import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc } from '../convex/_generated/dataModel';
import type { EventStatus } from '../convex/events/model';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProject = api.projects.mutations.createProject;
const updateProject = api.projects.mutations.updateProject;
const archiveProject = api.projects.mutations.archiveProject;
const createEvent = api.events.mutations.createEvent;
const getEvent = api.events.queries.getEvent;
const listProjectEvents = api.events.queries.listProjectEvents;
const changeEventStatus = api.events.mutations.changeEventStatus;
const updateEvent = api.events.mutations.updateEvent;
const archiveEvent = api.events.mutations.archiveEvent;
const deleteEvent = api.events.mutations.deleteEvent;
const listEventServices = api.services.queries.listEventServices;

const issuer = 'https://example.clerk.accounts.dev';
const inaccessible = 'notFoundOrInaccessible';
const unauthenticated = 'unauthenticated';
const firstPage = { numItems: 10, cursor: null };
type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function fixture(subject = 'events-owner') {
  const t = convexTest(schema, modules);
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(ensureUser, {});
  const organizationId = await client.mutation(createOrganization, { name: 'Events', slug: subject });
  const projectId = await client.mutation(createProject, {
    organizationId,
    name: 'Project',
    startsAt: 100,
    endsAt: 1000,
  });
  return { t, client, userId, organizationId, projectId };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(ensureUser, {});
  return { client, userId };
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

const transitionCases: readonly { current: EventStatus; next: EventStatus; legal: boolean }[] = [
  { current: 'draft', next: 'draft', legal: false },
  { current: 'draft', next: 'active', legal: true },
  { current: 'draft', next: 'completed', legal: false },
  { current: 'draft', next: 'archived', legal: true },
  { current: 'active', next: 'draft', legal: false },
  { current: 'active', next: 'active', legal: false },
  { current: 'active', next: 'completed', legal: true },
  { current: 'active', next: 'archived', legal: true },
  { current: 'completed', next: 'draft', legal: false },
  { current: 'completed', next: 'active', legal: false },
  { current: 'completed', next: 'completed', legal: false },
  { current: 'completed', next: 'archived', legal: true },
  { current: 'archived', next: 'draft', legal: false },
  { current: 'archived', next: 'active', legal: false },
  { current: 'archived', next: 'completed', legal: false },
  { current: 'archived', next: 'archived', legal: false },
];

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

test('changeEventStatus cannot bypass the dedicated archive door', async () => {
  const { client, projectId } = await fixture('event-archive-door');
  const eventId = await client.mutation(createEvent, { projectId, name: 'Archive through status', startsAt: 200 });
  await expect(client.mutation(changeEventStatus, { eventId, status: 'archived' })).rejects.toMatchObject({
    data: { code: 'eventArchiveRequired' },
  });
});

test('every public Event function is opaque to unauthenticated, fabricated, foreign, and non-member callers', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-access');
  const eventId = await owner.mutation(createEvent, { projectId, name: 'Protected event', startsAt: 200 });
  const archivedEventId = await owner.mutation(createEvent, { projectId, name: 'Protected archived event', startsAt: 300 });
  await owner.mutation(archiveEvent, { eventId: archivedEventId });
  const missingProjectId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('projects', { organizationId, name: 'Temporary', status: 'draft' });
    await ctx.db.delete(id);
    return id;
  });
  const missingEventId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('events', { organizationId, projectId, name: 'Temporary', status: 'draft', startsAt: 400 });
    await ctx.db.delete(id);
    return id;
  });

  for (const id of [eventId, missingEventId]) {
    await expect(t.query(getEvent, { eventId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.query(listEventServices, { eventId: id, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(updateEvent, { eventId: id, name: 'Nope' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(changeEventStatus, { eventId: id, status: 'active' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(archiveEvent, { eventId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
  }
  await expect(t.mutation(deleteEvent, { eventId: archivedEventId })).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(t.mutation(deleteEvent, { eventId: missingEventId })).rejects.toMatchObject({ data: { code: unauthenticated } });
  for (const id of [projectId, missingProjectId]) {
    await expect(t.query(listProjectEvents, { projectId: id, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(createEvent, { projectId: id, name: 'Nope', startsAt: 200 })).rejects.toMatchObject({ data: { code: unauthenticated } });
  }

  for (const id of [missingEventId]) {
    await expect(owner.query(getEvent, { eventId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(owner.query(listEventServices, { eventId: id, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(owner.mutation(updateEvent, { eventId: id, name: 'Nope' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(owner.mutation(changeEventStatus, { eventId: id, status: 'active' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(owner.mutation(archiveEvent, { eventId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(owner.mutation(deleteEvent, { eventId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  await expect(owner.query(listProjectEvents, { projectId: missingProjectId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(createEvent, { projectId: missingProjectId, name: 'Nope', startsAt: 200 })).rejects.toMatchObject({ data: { code: inaccessible } });

  const outsider = await provision(t, 'events-access-outsider');
  const foreignMember = await provision(t, 'events-access-foreign-member');
  const foreignOrganizationId = await owner.mutation(createOrganization, { name: 'Foreign', slug: 'events-access-foreign' });
  await owner.mutation(addMember, { organizationId: foreignOrganizationId, userId: foreignMember.userId, role: 'owner' });
  for (const caller of [outsider.client, foreignMember.client]) {
    await expect(caller.query(getEvent, { eventId })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.query(listProjectEvents, { projectId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.query(listEventServices, { eventId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(createEvent, { projectId, name: 'Nope', startsAt: 200 })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(updateEvent, { eventId, name: 'Nope' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(changeEventStatus, { eventId, status: 'active' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(archiveEvent, { eventId })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(deleteEvent, { eventId: archivedEventId })).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  const viewer = await provision(t, 'events-access-viewer');
  const operator = await provision(t, 'events-access-operator');
  await owner.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  await owner.mutation(addMember, { organizationId, userId: operator.userId, role: 'operator' });
  for (const caller of [viewer.client, operator.client]) {
    await expect(caller.mutation(createEvent, { projectId, name: 'Nope', startsAt: 200 })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(updateEvent, { eventId, name: 'Nope' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(changeEventStatus, { eventId, status: 'active' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(archiveEvent, { eventId })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(deleteEvent, { eventId: archivedEventId })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
});

test('Event reads return content to viewers', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-viewer-read');
  const viewer = await provision(t, 'events-viewer-read-member');
  await owner.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  const eventId = await owner.mutation(createEvent, { projectId, name: 'Visible event', startsAt: 200 });
  await expect(viewer.client.query(getEvent, { eventId })).resolves.toMatchObject({ _id: eventId, name: 'Visible event' });
  const page = await viewer.client.query(listProjectEvents, { projectId, paginationOpts: firstPage });
  expect(page.page.map((event) => event._id)).toEqual([eventId]);
  await expect(viewer.client.query(listEventServices, { eventId, paginationOpts: firstPage })).resolves.toMatchObject({
    page: [],
    isDone: true,
  });
});

test('Event access rejects a forged Event whose stored Project belongs to another organization', async () => {
  const { t, client, organizationId, projectId } = await fixture('events-forged-project-chain');
  const foreignOrganizationId = await client.mutation(createOrganization, {
    name: 'Foreign Event Project',
    slug: 'events-forged-project-chain-foreign',
  });
  const foreignProjectId = await client.mutation(createProject, {
    organizationId: foreignOrganizationId,
    name: 'Foreign project',
  });
  const forgedEventId = await t.run((ctx) => ctx.db.insert('events', {
    organizationId,
    projectId: foreignProjectId,
    name: 'Corrupt event',
    status: 'draft',
    startsAt: 200,
  }));

  await expect(client.query(getEvent, { eventId: forgedEventId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
  await expect(client.query(listProjectEvents, { projectId, paginationOpts: firstPage })).resolves.toMatchObject({ page: [] });
});

test('Event dates are finite, ordered, and constrained by the Project window on create and update', async () => {
  const { t, client, projectId } = await fixture('events-dates');
  await expect(client.mutation(createEvent, { projectId, name: 'Bad start', startsAt: Number.NaN })).rejects.toMatchObject({ data: { code: 'eventStartInvalid' } });
  await expect(client.mutation(createEvent, { projectId, name: 'Bad end', startsAt: 200, endsAt: Number.POSITIVE_INFINITY })).rejects.toMatchObject({ data: { code: 'eventEndInvalid' } });
  await expect(client.mutation(createEvent, { projectId, name: 'Bad range', startsAt: 300, endsAt: 200 })).rejects.toMatchObject({ data: { code: 'eventDateRangeInvalid' } });
  await expect(client.mutation(createEvent, { projectId, name: 'Too early', startsAt: 99 })).rejects.toMatchObject({ data: { code: 'eventBeforeProjectWindow' } });
  await expect(client.mutation(createEvent, { projectId, name: 'Open-ended too late', startsAt: 1001 })).rejects.toMatchObject({ data: { code: 'eventAfterProjectWindow' } });
  await expect(client.mutation(createEvent, { projectId, name: 'Too late', startsAt: 200, endsAt: 1001 })).rejects.toMatchObject({ data: { code: 'eventAfterProjectWindow' } });
  const eventId = await client.mutation(createEvent, { projectId, name: 'Bounded', startsAt: 200, endsAt: 900 });
  await expect(client.mutation(updateEvent, { eventId, startsAt: Number.NaN })).rejects.toMatchObject({ data: { code: 'eventStartInvalid' } });
  await expect(client.mutation(updateEvent, { eventId, endsAt: Number.NEGATIVE_INFINITY })).rejects.toMatchObject({ data: { code: 'eventEndInvalid' } });
  await expect(client.mutation(updateEvent, { eventId, startsAt: 99 })).rejects.toMatchObject({ data: { code: 'eventBeforeProjectWindow' } });
  await expect(client.mutation(updateEvent, { eventId, endsAt: 1001 })).rejects.toMatchObject({ data: { code: 'eventAfterProjectWindow' } });
  await expect(client.mutation(updateEvent, { eventId, startsAt: 950 })).rejects.toMatchObject({ data: { code: 'eventDateRangeInvalid' } });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(eventId)).toMatchObject({ startsAt: 200, endsAt: 900 });
  });
  await expect(client.mutation(createEvent, { projectId, name: 'Boundaries', startsAt: 100, endsAt: 1000 })).resolves.toBeDefined();
});

test('updating an Event start persists the new start', async () => {
  const { t, client, projectId } = await fixture('events-update-start');
  const eventId = await client.mutation(createEvent, { projectId, name: 'Moving start', startsAt: 200, endsAt: 900 });

  await expect(client.mutation(updateEvent, { eventId, startsAt: 300 })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(eventId)).toMatchObject({ startsAt: 300, endsAt: 900 });
  });
});

test('updating an Event end persists the new end', async () => {
  const { t, client, projectId } = await fixture('events-update-end');
  const eventId = await client.mutation(createEvent, { projectId, name: 'Moving end', startsAt: 200, endsAt: 900 });

  await expect(client.mutation(updateEvent, { eventId, endsAt: 800 })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(eventId)).toMatchObject({ startsAt: 200, endsAt: 800 });
  });
});

test('clearing an Event end removes the stored end', async () => {
  const { t, client, projectId } = await fixture('events-clear-end');
  const eventId = await client.mutation(createEvent, { projectId, name: 'Clearable end', startsAt: 200, endsAt: 900 });

  await expect(client.mutation(updateEvent, { eventId, endsAt: null })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect((await ctx.db.get(eventId))?.endsAt).toBeUndefined();
  });
});

test('completed Projects reject new Events and archived Projects freeze every Event write door', async () => {
  const { client, organizationId, projectId } = await fixture('events-project-lifecycle');
  const eventId = await client.mutation(createEvent, { projectId, name: 'Frozen later', startsAt: 200 });
  const completedProjectId = await client.mutation(createProject, { organizationId, name: 'Completed project' });
  const correctableEventId = await client.mutation(createEvent, { projectId: completedProjectId, name: 'Correctable event', startsAt: 200 });
  await client.mutation(updateProject, { projectId: completedProjectId, status: 'completed' });
  await expect(client.mutation(createEvent, { projectId: completedProjectId, name: 'Nope', startsAt: 200 })).rejects.toMatchObject({ data: { code: 'eventProjectUnavailable' } });
  await expect(client.mutation(updateEvent, { eventId: correctableEventId, name: 'Corrected event' })).resolves.toBeNull();
  await client.mutation(archiveProject, { projectId });
  await expect(client.mutation(createEvent, { projectId, name: 'Nope', startsAt: 200 })).rejects.toMatchObject({ data: { code: 'eventProjectUnavailable' } });
  const frozen = 'eventProjectReadOnly';
  await expect(client.mutation(updateEvent, { eventId, name: 'Nope' })).rejects.toMatchObject({ data: { code: frozen } });
  await expect(client.mutation(changeEventStatus, { eventId, status: 'active' })).rejects.toMatchObject({ data: { code: frozen } });
  await expect(client.mutation(archiveEvent, { eventId })).rejects.toMatchObject({ data: { code: frozen } });
  await expect(client.mutation(deleteEvent, { eventId })).rejects.toMatchObject({ data: { code: frozen } });
});

test('archived Events reject edits and unarchived Events reject hard deletion', async () => {
  const { client, projectId } = await fixture('events-own-lifecycle');
  const eventId = await client.mutation(createEvent, { projectId, name: 'Lifecycle event', startsAt: 200 });
  await expect(client.mutation(deleteEvent, { eventId })).rejects.toMatchObject({ data: { code: 'eventDeleteRequiresArchive' } });
  await client.mutation(archiveEvent, { eventId });
  await expect(client.mutation(updateEvent, { eventId, name: 'Nope' })).rejects.toMatchObject({ data: { code: 'eventArchived' } });
});

test('every Event operation writes an attributed audit row and an archived unreferenced Event disappears', async () => {
  const { t, client: owner, userId: ownerUserId, organizationId, projectId } = await fixture('events-audit');
  const planner = await provision(t, 'events-audit-planner');
  await owner.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const eventId = await owner.mutation(createEvent, { projectId, name: 'Audited event', startsAt: 200 });
  await planner.client.mutation(updateEvent, { eventId, name: 'Renamed event' });
  await planner.client.mutation(changeEventStatus, { eventId, status: 'active' });
  await planner.client.mutation(archiveEvent, { eventId });
  await planner.client.mutation(deleteEvent, { eventId });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(eventId)).toBeNull();
    const audits = await ctx.db.query('auditEvents').withIndex('by_org_entity', (q) =>
      q.eq('organizationId', organizationId).eq('entityType', 'event').eq('entityId', eventId),
    ).collect();
    expect(audits.map((audit) => audit.action)).toEqual([
      'event.created', 'event.updated', 'event.statusChanged', 'event.archived', 'event.deleted',
    ]);
    expect(audits.every((audit) => audit.organizationId === organizationId && audit.entityType === 'event')).toBe(true);
    expect(audits[0]).toMatchObject({ actorUserId: ownerUserId, metadata: { name: 'Audited event' } });
    expect(audits[1]).toMatchObject({ actorUserId: planner.userId, metadata: { changedFields: 'name' } });
    expect(audits[2]).toMatchObject({ actorUserId: planner.userId, metadata: { previousStatus: 'draft', status: 'active' } });
    expect(audits[3]).toMatchObject({ actorUserId: planner.userId, metadata: { previousStatus: 'active' } });
    expect(audits[4]).toMatchObject({ actorUserId: planner.userId, metadata: { name: 'Renamed event' } });
  });
});

test('deleting an Event with Services is refused and archival never cascades to those Services', async () => {
  const { t, client, organizationId, projectId } = await fixture('event-references');
  const eventId = await client.mutation(createEvent, { projectId, name: 'Referenced', startsAt: 200 });
  const serviceId = await insertServiceReference(t, { organizationId, projectId, eventId });

  const page = await client.query(listEventServices, { eventId, paginationOpts: firstPage });
  expect(page.page.map((service) => service._id)).toEqual([serviceId]);

  await expect(client.mutation(archiveEvent, { eventId })).resolves.toBeNull();
  await expect(client.mutation(deleteEvent, { eventId })).rejects.toMatchObject({ data: { code: 'eventDeleteBlocked' } });
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
