import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc } from '../convex/_generated/dataModel';
import { eventStatusTransitions, type EventStatus } from '../convex/events/model';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProject = api.projects.mutations.createProject;
const createEvent = api.events.mutations.createEvent;
const getEvent = api.events.queries.getEvent;
const listProjectEvents = api.events.queries.listProjectEvents;
const changeEventStatus = api.events.mutations.changeEventStatus;
const updateEvent = api.events.mutations.updateEvent;
const archiveEvent = api.events.mutations.archiveEvent;
const deleteEvent = api.events.mutations.deleteEvent;
const listEventServices = api.services.queries.listEventServices;

const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 10, cursor: null };
type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function fixture(subject = 'events-owner') {
  const t = convexTest(schema, modules);
  const client = t.withIdentity(identity(subject));
  await client.mutation(ensureUser, {});
  const organizationId = await client.mutation(createOrganization, { name: 'Events', slug: subject });
  const projectId = await client.mutation(createProject, {
    organizationId,
    name: 'Project',
    startsAt: 100,
    endsAt: 1000,
  });
  return { t, client, organizationId, projectId };
}

async function eventAtStatus(
  client: Awaited<ReturnType<typeof fixture>>['client'],
  projectId: Awaited<ReturnType<typeof fixture>>['projectId'],
  status: EventStatus,
) {
  const eventId = await client.mutation(createEvent, { projectId, name: `Event ${status}`, startsAt: 200, endsAt: 900 });
  if (status === 'active' || status === 'completed') {
    await client.mutation(changeEventStatus, { eventId, status: 'active' });
  }
  if (status === 'completed') {
    await client.mutation(changeEventStatus, { eventId, status: 'completed' });
  }
  if (status === 'archived') {
    await client.mutation(archiveEvent, { eventId });
  }
  return eventId;
}

test('Event creation derives organization ownership and listProjectEvents is an ordered paginated read', async () => {
  const { client, organizationId, projectId } = await fixture('events-list');
  const later = await client.mutation(createEvent, { projectId, name: 'Later', startsAt: 600 });
  const earlier = await client.mutation(createEvent, { projectId, name: 'Earlier', startsAt: 200, endsAt: 300 });

  const event = await client.query(getEvent, { eventId: earlier });
  expect(event).toMatchObject({ organizationId, projectId, name: 'Earlier', status: 'draft', startsAt: 200, endsAt: 300 });
  const first = await client.query(listProjectEvents, { projectId, paginationOpts: { numItems: 1, cursor: null } });
  expect(first.page.map((row: Doc<'events'>) => row._id)).toEqual([earlier]);
  expect(first.isDone).toBe(false);
  const second = await client.query(listProjectEvents, {
    projectId,
    paginationOpts: { numItems: 1, cursor: first.continueCursor },
  });
  expect(second.page.map((row: Doc<'events'>) => row._id)).toEqual([later]);
});

test('Event creation and editing require the shared planner authoring role', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-roles');
  const members = await Promise.all((['viewer', 'operator', 'planner'] as const).map(async (role) => {
    const client = t.withIdentity(identity(`event-${role}`));
    const userId = await client.mutation(ensureUser, {});
    await owner.mutation(addMember, { organizationId, userId, role });
    return { role, client };
  }));
  const eventId = await owner.mutation(createEvent, { projectId, name: 'Owned event', startsAt: 200 });

  for (const member of members) {
    const create = member.client.mutation(createEvent, { projectId, name: `${member.role} event`, startsAt: 300 });
    const update = member.client.mutation(updateEvent, { eventId, name: `${member.role} edit` });
    if (member.role === 'planner') {
      await expect(create).resolves.toBeDefined();
      await expect(update).resolves.toBeNull();
    } else {
      await expect(create).rejects.toMatchObject({ data: { code: 'notFoundOrInaccessible' } });
      await expect(update).rejects.toMatchObject({ data: { code: 'notFoundOrInaccessible' } });
    }
  }
});

const statuses: readonly EventStatus[] = ['draft', 'active', 'completed', 'archived'];
const transitionCases = statuses.flatMap((current) =>
  statuses.map((next) => ({ current, next, legal: eventStatusTransitions[current].includes(next) })),
);

test.each(transitionCases)('Event status matrix: $current → $next', async ({ current, next, legal }) => {
  const { client, projectId } = await fixture(`event-matrix-${current}-${next}`);
  const eventId = await eventAtStatus(client, projectId, current);
  const transition = next === 'archived'
    ? client.mutation(archiveEvent, { eventId })
    : client.mutation(changeEventStatus, { eventId, status: next });
  if (legal) {
    await expect(transition).resolves.toBeNull();
    await expect(client.query(getEvent, { eventId })).resolves.toMatchObject({ status: next });
    return;
  }
  await expect(transition).rejects.toMatchObject({
    data: { code: current === 'archived' ? 'eventTerminal' : 'eventStatusTransitionInvalid' },
  });
});

test('deleting an Event with Services is refused and archival never cascades to those Services', async () => {
  const { t, client, organizationId, projectId } = await fixture('event-references');
  const eventId = await client.mutation(createEvent, { projectId, name: 'Referenced', startsAt: 200 });
  const serviceId = await insertServiceReference(t, { organizationId, projectId, eventId });

  const page = await client.query(listEventServices, { eventId, paginationOpts: firstPage });
  expect(page.page.map((service) => service._id)).toEqual([serviceId]);

  await expect(client.mutation(deleteEvent, { eventId })).rejects.toMatchObject({ data: { code: 'eventDeleteBlocked' } });
  await expect(client.mutation(archiveEvent, { eventId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(eventId)).toMatchObject({ status: 'archived' });
    expect(await ctx.db.get(serviceId)).toMatchObject({ status: 'draft', eventId, projectId });
  });
});

async function insertServiceReference(
  t: SchemaTest,
  ids: { organizationId: Doc<'organizations'>['_id']; projectId: Doc<'projects'>['_id']; eventId: Doc<'events'>['_id'] },
) {
  return t.run(async (ctx) => {
    const serviceKindId = await ctx.db.insert('serviceKinds', {
      organizationId: ids.organizationId,
      key: 'reference',
      name: 'Reference',
      status: 'active',
    });
    const serviceKindVersionId = await ctx.db.insert('serviceKindVersions', {
      organizationId: ids.organizationId,
      serviceKindId,
      versionNumber: 1,
      status: 'published',
    });
    return ctx.db.insert('services', {
      ...ids,
      serviceKindId,
      serviceKindVersionId,
      name: 'Reference service',
      status: 'draft',
      startsAt: 200,
    });
  });
}
