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
const getEventDetail = api.events.queries.getEventDetail;
const listProjectEvents = api.events.queries.listProjectEvents;
const listOrganizationEvents = api.events.queries.listOrganizationEvents;
const changeEventStatus = api.events.mutations.changeEventStatus;
const updateEvent = api.events.mutations.updateEvent;
const archiveEvent = api.events.mutations.archiveEvent;
const deleteEvent = api.events.mutations.deleteEvent;
const listEventServices = api.services.queries.listEventServices;
const removeMember = api.organizations.mutations.removeMember;
const createLocation = api.locations.mutations.createLocation;
const archiveLocation = api.locations.mutations.archiveLocation;
const createCostCentre = api.costCentres.mutations.createCostCentre;
const archiveCostCentre = api.costCentres.mutations.archiveCostCentre;

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

test('listOrganizationEvents is tenant-scoped and narrows by indexed status and Project before pagination', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-org-list');
  const secondProjectId = await owner.mutation(createProject, { organizationId, name: 'Second project' });
  const draft = await owner.mutation(createEvent, { projectId, name: 'Draft', startsAt: 200 });
  const active = await owner.mutation(createEvent, { projectId, name: 'Active', startsAt: 300 });
  await owner.mutation(changeEventStatus, { eventId: active, status: 'active' });
  const otherProjectDraft = await owner.mutation(createEvent, { projectId: secondProjectId, name: 'Other draft', startsAt: 400 });

  const all = await owner.query(listOrganizationEvents, { organizationId, paginationOpts: firstPage });
  expect(all.page.map((event) => event._id)).toEqual([draft, active, otherProjectDraft]);
  const firstDraftPage = await owner.query(listOrganizationEvents, {
    organizationId,
    status: 'draft',
    paginationOpts: { numItems: 1, cursor: null },
  });
  expect(firstDraftPage.page).toHaveLength(1);
  expect(firstDraftPage.page.every((event) => event.status === 'draft')).toBe(true);
  const remainingDrafts = await owner.query(listOrganizationEvents, {
    organizationId,
    status: 'draft',
    paginationOpts: { numItems: 10, cursor: firstDraftPage.continueCursor },
  });
  expect([...firstDraftPage.page, ...remainingDrafts.page].map((event) => event._id)).toEqual([draft, otherProjectDraft]);
  expect(remainingDrafts.page.every((event) => event.status === 'draft')).toBe(true);
  const projectOnly = await owner.query(listOrganizationEvents, {
    organizationId,
    projectId,
    paginationOpts: firstPage,
  });
  expect(projectOnly.page.map((event) => event._id)).toEqual([draft, active]);

  // Both filters together is its own index branch, and it is the default path
  // once a planner touches both selects. Tested separately because the two
  // filters passing alone proves nothing about the branch that serves the pair:
  // an earlier version narrowed by Project and silently dropped the status.
  const secondProjectDraft = await owner.mutation(createEvent, { projectId, name: 'Second draft', startsAt: 500 });
  const projectAndStatus = await owner.query(listOrganizationEvents, {
    organizationId,
    projectId,
    status: 'draft',
    paginationOpts: firstPage,
  });
  expect(projectAndStatus.page.map((event) => event._id)).toEqual([draft, secondProjectDraft]);
  // A page boundary proves the narrowing happened BEFORE the cursor. Filtering
  // after pagination would return a short page here and lose the second draft.
  const firstOfPair = await owner.query(listOrganizationEvents, {
    organizationId,
    projectId,
    status: 'draft',
    paginationOpts: { numItems: 1, cursor: null },
  });
  expect(firstOfPair.page.map((event) => event._id)).toEqual([draft]);
  const restOfPair = await owner.query(listOrganizationEvents, {
    organizationId,
    projectId,
    status: 'draft',
    paginationOpts: { numItems: 10, cursor: firstOfPair.continueCursor },
  });
  expect(restOfPair.page.map((event) => event._id)).toEqual([secondProjectDraft]);
  expect(restOfPair.page.every((event) => event.status === 'draft')).toBe(true);

  const foreign = await provision(t, 'events-org-list-foreign');
  const foreignOrganizationId = await owner.mutation(createOrganization, { name: 'Foreign list', slug: 'events-org-list-foreign' });
  await owner.mutation(addMember, { organizationId: foreignOrganizationId, userId: foreign.userId, role: 'owner' });
  const foreignProjectId = await foreign.client.mutation(createProject, { organizationId: foreignOrganizationId, name: 'Foreign project' });
  await foreign.client.mutation(createEvent, { projectId: foreignProjectId, name: 'Foreign event', startsAt: 100 });
  const foreignPage = await foreign.client.query(listOrganizationEvents, {
    organizationId: foreignOrganizationId,
    paginationOpts: firstPage,
  });
  expect(foreignPage.page).toHaveLength(1);
  expect(foreignPage.page.every((event) => event.organizationId === foreignOrganizationId)).toBe(true);
  await expect(owner.query(listOrganizationEvents, {
    organizationId,
    projectId: foreignProjectId,
    paginationOpts: firstPage,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listOrganizationEvents refuses a page whose stored Project contradicts the indexed organizationId', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-org-list-divergence');
  const eventId = await owner.mutation(createEvent, { projectId, name: 'Honest', startsAt: 200 });
  await expect(owner.query(listOrganizationEvents, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({
    page: [{ _id: eventId }],
  });

  // No public door can produce this: `createEvent` derives the column from a
  // proven Project and `updateEvent` cannot name it. A bad migration or seed
  // can, which is the whole reason the list re-derives the tenant through the
  // stored graph instead of trusting the column its index selected on (I4).
  const foreign = await provision(t, 'events-divergence-foreign');
  const foreignOrganizationId = await foreign.client.mutation(createOrganization, {
    name: 'Divergent',
    slug: 'events-divergence-foreign',
  });
  const foreignProjectId = await foreign.client.mutation(createProject, {
    organizationId: foreignOrganizationId,
    name: 'Divergent project',
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(eventId, { projectId: foreignProjectId });
  });

  // The whole page is refused, not silently shortened: a divergence is a corrupt
  // database, and a quietly dropped row would hide it from the tenant it belongs to.
  await expect(
    owner.query(listOrganizationEvents, { organizationId, paginationOpts: firstPage }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('getEventDetail joins safe header projections and nulls absent, dangling, foreign, and former-member arms', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-detail');
  const absentId = await owner.mutation(createEvent, { projectId, name: 'Absent context', startsAt: 200 });
  await expect(owner.query(getEventDetail, { eventId: absentId })).resolves.toMatchObject({
    venue: null,
    clientCostCentre: null,
    accountable: null,
  });

  const venueId = await owner.mutation(createLocation, { organizationId, name: 'Hall', type: 'venue' });
  const costCentreId = await owner.mutation(createCostCentre, { organizationId, key: 'client', name: 'Client' });
  const member = await provision(t, 'events-detail-member');
  const membershipId = await owner.mutation(addMember, { organizationId, userId: member.userId, role: 'planner' });
  const eventId = await owner.mutation(createEvent, {
    projectId,
    name: 'Joined context',
    startsAt: 300,
    venueLocationId: venueId,
    clientCostCentreId: costCentreId,
    accountableUserId: member.userId,
  });
  await expect(owner.query(getEventDetail, { eventId })).resolves.toMatchObject({
    venue: { _id: venueId, name: 'Hall', type: 'venue' },
    clientCostCentre: { _id: costCentreId, key: 'client', name: 'Client', status: 'active' },
    accountable: { _id: member.userId },
  });
  await owner.mutation(removeMember, { membershipId });
  await expect(owner.query(getEventDetail, { eventId })).resolves.toMatchObject({ accountable: null });

  await t.run(async (ctx) => {
    await ctx.db.delete(venueId);
    await ctx.db.delete(costCentreId);
  });
  await expect(owner.query(getEventDetail, { eventId })).resolves.toMatchObject({ venue: null, clientCostCentre: null });

  const foreignOrganizationId = await owner.mutation(createOrganization, { name: 'Foreign detail', slug: 'events-detail-foreign' });
  const foreignVenueId = await owner.mutation(createLocation, { organizationId: foreignOrganizationId, name: 'Foreign hall', type: 'venue' });
  const foreignCostCentreId = await owner.mutation(createCostCentre, { organizationId: foreignOrganizationId, key: 'foreign', name: 'Foreign client' });
  await t.run((ctx) => ctx.db.patch(eventId, { venueLocationId: foreignVenueId, clientCostCentreId: foreignCostCentreId }));
  await expect(owner.query(getEventDetail, { eventId })).resolves.toMatchObject({ venue: null, clientCostCentre: null });
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
    await expect(t.query(getEventDetail, { eventId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
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
  await expect(t.query(listOrganizationEvents, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });

  for (const id of [missingEventId]) {
    await expect(owner.query(getEvent, { eventId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(owner.query(getEventDetail, { eventId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
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
    // The header projection is the read that joins a venue, a cost centre and a
    // person, so an ungated version of it discloses far more than `getEvent`.
    await expect(caller.query(getEventDetail, { eventId })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.query(listProjectEvents, { projectId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.query(listOrganizationEvents, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.query(listEventServices, { eventId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(createEvent, { projectId, name: 'Nope', startsAt: 200 })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(updateEvent, { eventId, name: 'Nope' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(changeEventStatus, { eventId, status: 'active' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(archiveEvent, { eventId })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(caller.mutation(deleteEvent, { eventId: archivedEventId })).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  // Knowing a Project id from another tenant grants nothing, and the two ids are
  // checked against EACH OTHER rather than only against the caller. `both` is an
  // owner of the fixture organization AND of a second one, so membership cannot
  // be what refuses the mismatched pair — the positive controls below prove each
  // id is reachable on its own, which is what makes the pairing the thing tested.
  await expect(
    outsider.client.query(listOrganizationEvents, { organizationId, paginationOpts: firstPage }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  const both = await provision(t, 'events-two-orgs');
  const secondOrganizationId = await both.client.mutation(createOrganization, { name: 'Second', slug: 'events-second' });
  await owner.mutation(addMember, { organizationId, userId: both.userId, role: 'planner' });
  const secondProjectId = await both.client.mutation(createProject, {
    organizationId: secondOrganizationId,
    name: 'Second org project',
  });
  await expect(
    both.client.query(listOrganizationEvents, { organizationId, projectId: secondProjectId, paginationOpts: firstPage }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    both.client.query(listOrganizationEvents, { organizationId, projectId, paginationOpts: firstPage }),
  ).resolves.toBeDefined();
  await expect(
    both.client.query(listOrganizationEvents, {
      organizationId: secondOrganizationId,
      projectId: secondProjectId,
      paginationOpts: firstPage,
    }),
  ).resolves.toBeDefined();

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


test('Event context references are proven against the Event organization before they are stored', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-context');
  const venueId = await owner.mutation(createLocation, { organizationId, name: 'Main hall', type: 'venue' });
  const hotelId = await owner.mutation(createLocation, { organizationId, name: 'Crew hotel', type: 'hotel' });
  const retiredVenueId = await owner.mutation(createLocation, { organizationId, name: 'Old hall', type: 'venue' });
  await owner.mutation(archiveLocation, { locationId: retiredVenueId });
  const costCentreId = await owner.mutation(createCostCentre, { organizationId, key: 'clientA', name: 'Client A' });
  const retiredCostCentreId = await owner.mutation(createCostCentre, { organizationId, key: 'clientB', name: 'Client B' });
  await owner.mutation(archiveCostCentre, { costCentreId: retiredCostCentreId });
  const member = await provision(t, 'events-context-member');
  await owner.mutation(addMember, { organizationId, userId: member.userId, role: 'operator' });

  // The foreign catalogue is owned by the SAME caller, so a rejection can only
  // come from the organization proof — never from a missing membership.
  const foreignOrganizationId = await owner.mutation(createOrganization, { name: 'Foreign', slug: 'events-context-foreign' });
  const foreignVenueId = await owner.mutation(createLocation, { organizationId: foreignOrganizationId, name: 'Foreign hall', type: 'venue' });
  const foreignCostCentreId = await owner.mutation(createCostCentre, { organizationId: foreignOrganizationId, key: 'clientA', name: 'Foreign client' });
  const stranger = await provision(t, 'events-context-stranger');

  // These two exist to pin the ORDER of the venue proof. Both are non-venues, so
  // a type-first implementation would answer `eventVenueLocationTypeInvalid` and
  // disclose that the caller named a real row in another tenant (or an archived
  // one). Ownership and archival must answer first, generically.
  const foreignHotelId = await owner.mutation(createLocation, { organizationId: foreignOrganizationId, name: 'Foreign hotel', type: 'hotel' });
  const retiredHotelId = await owner.mutation(createLocation, { organizationId, name: 'Old hotel', type: 'hotel' });
  await owner.mutation(archiveLocation, { locationId: retiredHotelId });

  const base = { projectId, name: 'Context', startsAt: 200, endsAt: 900 };
  await expect(owner.mutation(createEvent, { ...base, venueLocationId: foreignHotelId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(createEvent, { ...base, venueLocationId: retiredHotelId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(createEvent, { ...base, venueLocationId: foreignVenueId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(createEvent, { ...base, venueLocationId: retiredVenueId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(createEvent, { ...base, clientCostCentreId: foreignCostCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(createEvent, { ...base, clientCostCentreId: retiredCostCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(createEvent, { ...base, accountableUserId: stranger.userId })).rejects.toMatchObject({ data: { code: inaccessible } });
  // Same organization, live, but the wrong code-owned type: a reportable input
  // error precisely because ownership has already been proven.
  await expect(owner.mutation(createEvent, { ...base, venueLocationId: hotelId })).rejects.toMatchObject({
    data: { code: 'eventVenueLocationTypeInvalid' },
  });

  const eventId = await owner.mutation(createEvent, {
    ...base,
    venueLocationId: venueId,
    clientCostCentreId: costCentreId,
    accountableUserId: member.userId,
  });
  await expect(owner.query(getEvent, { eventId })).resolves.toMatchObject({
    venueLocationId: venueId,
    clientCostCentreId: costCentreId,
    accountableUserId: member.userId,
  });

  // The update door runs the identical proofs and leaves the stored context untouched when they fail.
  await expect(owner.mutation(updateEvent, { eventId, venueLocationId: foreignVenueId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(updateEvent, { eventId, venueLocationId: hotelId })).rejects.toMatchObject({ data: { code: 'eventVenueLocationTypeInvalid' } });
  await expect(owner.mutation(updateEvent, { eventId, clientCostCentreId: foreignCostCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(updateEvent, { eventId, accountableUserId: stranger.userId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(updateEvent, { eventId, venueLocationId: retiredVenueId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(updateEvent, { eventId, venueLocationId: foreignHotelId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(updateEvent, { eventId, clientCostCentreId: retiredCostCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(eventId)).toMatchObject({
      venueLocationId: venueId,
      clientCostCentreId: costCentreId,
      accountableUserId: member.userId,
    });
  });
});

test('an accountable user must be a current member of the Event organization', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-accountable');
  const former = await provision(t, 'events-accountable-former');
  const membershipId = await owner.mutation(addMember, { organizationId, userId: former.userId, role: 'planner' });
  // While the membership stands the user is an acceptable accountable member.
  const eventId = await owner.mutation(createEvent, { projectId, name: 'Accountable', startsAt: 200, accountableUserId: former.userId });
  await expect(owner.mutation(updateEvent, { eventId, accountableUserId: null })).resolves.toBeNull();

  await owner.mutation(removeMember, { membershipId });
  // The very same user id, still present in the users table, is now refused.
  await expect(owner.mutation(createEvent, { projectId, name: 'Departed', startsAt: 200, accountableUserId: former.userId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
  await expect(owner.mutation(updateEvent, { eventId, accountableUserId: former.userId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(former.userId)).not.toBeNull();
    expect((await ctx.db.get(eventId))?.accountableUserId).toBeUndefined();
  });
});

test('an Event budget is a both-or-neither pair of integer minor units', async () => {
  const { t, client, projectId } = await fixture('events-budget');
  const base = { projectId, name: 'Budget', startsAt: 200 };
  await expect(client.mutation(createEvent, { ...base, budgetAmount: 1_000 })).rejects.toMatchObject({ data: { code: 'eventBudgetIncomplete' } });
  await expect(client.mutation(createEvent, { ...base, budgetCurrency: 'COP' })).rejects.toMatchObject({ data: { code: 'eventBudgetIncomplete' } });
  // The shared money boundary (#83) owns these three codes; the Event does not restate them.
  await expect(client.mutation(createEvent, { ...base, budgetAmount: 1_000.5, budgetCurrency: 'COP' })).rejects.toMatchObject({ data: { code: 'moneyAmountNotInteger' } });
  await expect(client.mutation(createEvent, { ...base, budgetAmount: -1, budgetCurrency: 'COP' })).rejects.toMatchObject({ data: { code: 'moneyAmountNegative' } });
  await expect(client.mutation(createEvent, { ...base, budgetAmount: Number.NaN, budgetCurrency: 'COP' })).rejects.toMatchObject({ data: { code: 'moneyAmountNotFinite' } });

  const eventId = await client.mutation(createEvent, { ...base, budgetAmount: 250_000_00, budgetCurrency: 'COP' });
  await expect(client.query(getEvent, { eventId })).resolves.toMatchObject({ budgetAmount: 250_000_00, budgetCurrency: 'COP' });

  // The pair is checked on the resolved values, so neither half can be dropped,
  // added, or corrupted on its own through the update door.
  await expect(client.mutation(updateEvent, { eventId, budgetCurrency: null })).rejects.toMatchObject({ data: { code: 'eventBudgetIncomplete' } });
  await expect(client.mutation(updateEvent, { eventId, budgetAmount: null })).rejects.toMatchObject({ data: { code: 'eventBudgetIncomplete' } });
  await expect(client.mutation(updateEvent, { eventId, budgetAmount: 3.5 })).rejects.toMatchObject({ data: { code: 'moneyAmountNotInteger' } });
  await expect(client.mutation(updateEvent, { eventId, budgetCurrency: 'USD' })).resolves.toBeNull();
  await expect(client.mutation(updateEvent, { eventId, budgetAmount: 400_00, budgetCurrency: 'USD' })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(eventId)).toMatchObject({ budgetAmount: 400_00, budgetCurrency: 'USD' });
  });

  await expect(client.mutation(updateEvent, { eventId, budgetAmount: null, budgetCurrency: null })).resolves.toBeNull();
  await t.run(async (ctx) => {
    const event = await ctx.db.get(eventId);
    expect(event?.budgetAmount).toBeUndefined();
    expect(event?.budgetCurrency).toBeUndefined();
  });
  // An unbudgeted Event cannot acquire half a budget either.
  await expect(client.mutation(updateEvent, { eventId, budgetAmount: 500_00 })).rejects.toMatchObject({ data: { code: 'eventBudgetIncomplete' } });
});

test('Event context columns are cleared, replaced, and audited like every other Event column', async () => {
  const { t, client: owner, userId: ownerUserId, organizationId, projectId } = await fixture('events-context-audit');
  const venueId = await owner.mutation(createLocation, { organizationId, name: 'Hall', type: 'venue' });
  const otherVenueId = await owner.mutation(createLocation, { organizationId, name: 'Annex', type: 'venue' });
  const costCentreId = await owner.mutation(createCostCentre, { organizationId, key: 'clientA', name: 'Client A' });
  const eventId = await owner.mutation(createEvent, { projectId, name: 'Audited context', startsAt: 200 });

  await expect(owner.mutation(updateEvent, {
    eventId,
    venueLocationId: venueId,
    clientCostCentreId: costCentreId,
    budgetAmount: 10_000_00,
    budgetCurrency: 'COP',
    accountableUserId: ownerUserId,
  })).resolves.toBeNull();
  await expect(owner.mutation(updateEvent, { eventId, venueLocationId: otherVenueId })).resolves.toBeNull();
  // A no-op patch changes nothing and records nothing.
  await expect(owner.mutation(updateEvent, { eventId, venueLocationId: otherVenueId })).resolves.toBeNull();
  await expect(owner.mutation(updateEvent, { eventId, venueLocationId: null, clientCostCentreId: null, accountableUserId: null })).resolves.toBeNull();

  await t.run(async (ctx) => {
    const event = await ctx.db.get(eventId);
    expect(event?.venueLocationId).toBeUndefined();
    expect(event?.clientCostCentreId).toBeUndefined();
    expect(event?.accountableUserId).toBeUndefined();
    expect(event).toMatchObject({ budgetAmount: 10_000_00, budgetCurrency: 'COP' });
    const audits = await ctx.db.query('auditEvents').withIndex('by_org_entity', (q) =>
      q.eq('organizationId', organizationId).eq('entityType', 'event').eq('entityId', eventId),
    ).collect();
    expect(audits.map((audit) => audit.metadata.changedFields)).toEqual([
      undefined,
      'venueLocationId,clientCostCentreId,budgetAmount,budgetCurrency,accountableUserId',
      'venueLocationId',
      'venueLocationId,clientCostCentreId,accountableUserId',
    ]);
  });
});

test('a current member of another organization is refused as accountable', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-cross-org-accountable');
  // A user with a live, current membership — just not in THIS organization.
  // "Is this user a member of anything?" would accept them; only the
  // (organization, user) pairing refuses.
  const neighbour = await provision(t, 'events-cross-org-neighbour');
  const foreignOrganizationId = await owner.mutation(createOrganization, { name: 'Neighbour', slug: 'events-cross-org-foreign' });
  await owner.mutation(addMember, { organizationId: foreignOrganizationId, userId: neighbour.userId, role: 'owner' });
  await t.run(async (ctx) => {
    const memberships = await ctx.db.query('organizationMemberships').withIndex('by_user', (q) => q.eq('userId', neighbour.userId)).collect();
    expect(memberships.map((membership) => membership.organizationId)).toEqual([foreignOrganizationId]);
  });

  await expect(owner.mutation(createEvent, { projectId, name: 'Neighbour', startsAt: 200, accountableUserId: neighbour.userId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
  const eventId = await owner.mutation(createEvent, { projectId, name: 'Local', startsAt: 200 });
  await expect(owner.mutation(updateEvent, { eventId, accountableUserId: neighbour.userId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
});

test('a bad reference is reported before a malformed budget in the same call', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-order');
  const foreignOrganizationId = await owner.mutation(createOrganization, { name: 'Foreign', slug: 'events-order-foreign' });
  const foreignVenueId = await owner.mutation(createLocation, { organizationId: foreignOrganizationId, name: 'Foreign hall', type: 'venue' });
  const foreignCostCentreId = await owner.mutation(createCostCentre, { organizationId: foreignOrganizationId, key: 'foreign', name: 'Foreign client' });
  const stranger = await provision(t, 'events-order-stranger');

  // Each call carries BOTH a foreign reference and a half-stated budget. The
  // local budget error must never answer first: it would be an oracle telling
  // the caller their tenant proof was not even reached.
  const halfBudget = { budgetAmount: 1_000 };
  for (const reference of [
    { venueLocationId: foreignVenueId },
    { clientCostCentreId: foreignCostCentreId },
    { accountableUserId: stranger.userId },
  ]) {
    await expect(owner.mutation(createEvent, { projectId, name: 'Order', startsAt: 200, ...reference, ...halfBudget })).rejects.toMatchObject({
      data: { code: inaccessible },
    });
  }

  const eventId = await owner.mutation(createEvent, { projectId, name: 'Order target', startsAt: 200 });
  for (const reference of [
    { venueLocationId: foreignVenueId },
    { clientCostCentreId: foreignCostCentreId },
    { accountableUserId: stranger.userId },
  ]) {
    await expect(owner.mutation(updateEvent, { eventId, ...reference, ...halfBudget })).rejects.toMatchObject({
      data: { code: inaccessible },
    });
  }
  // Nothing was written by any of those twelve refusals.
  await t.run(async (ctx) => {
    const event = await ctx.db.get(eventId);
    expect(event?.venueLocationId).toBeUndefined();
    expect(event?.clientCostCentreId).toBeUndefined();
    expect(event?.accountableUserId).toBeUndefined();
    expect(event?.budgetAmount).toBeUndefined();
  });
});

test('an Event with an archived venue or Cost Centre stays editable in every other column', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-archived-context');
  const venueId = await owner.mutation(createLocation, { organizationId, name: 'Hall', type: 'venue' });
  const costCentreId = await owner.mutation(createCostCentre, { organizationId, key: 'clientA', name: 'Client A' });
  const eventId = await owner.mutation(createEvent, {
    projectId,
    name: 'Archived context',
    startsAt: 200,
    venueLocationId: venueId,
    clientCostCentreId: costCentreId,
  });

  // Archival makes a row unselectable anew; it does not invalidate the Events
  // already pointing at it. Only references the patch SUPPLIES are re-proven,
  // so an unrelated edit must not be collateral damage.
  await owner.mutation(archiveLocation, { locationId: venueId });
  await owner.mutation(archiveCostCentre, { costCentreId });
  await expect(owner.mutation(updateEvent, { eventId, name: 'Renamed anyway' })).resolves.toBeNull();
  await expect(owner.mutation(updateEvent, { eventId, startsAt: 300 })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(eventId)).toMatchObject({
      name: 'Renamed anyway',
      startsAt: 300,
      venueLocationId: venueId,
      clientCostCentreId: costCentreId,
    });
  });

  // Re-supplying the same now-archived ids is still refused, and clearing works.
  await expect(owner.mutation(updateEvent, { eventId, venueLocationId: venueId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(updateEvent, { eventId, venueLocationId: null, clientCostCentreId: null })).resolves.toBeNull();
});

test('a fabricated Cost Centre id is indistinguishable from a foreign one', async () => {
  const { t, client: owner, organizationId, projectId } = await fixture('events-missing-costcentre');
  const missingCostCentreId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('costCentres', { organizationId, key: 'gone', name: 'Gone', status: 'active' });
    await ctx.db.delete(id);
    return id;
  });
  await expect(owner.mutation(createEvent, { projectId, name: 'Missing', startsAt: 200, clientCostCentreId: missingCostCentreId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
});

test('a zero budget is a real budget and an out-of-range amount is refused', async () => {
  const { client, projectId } = await fixture('events-budget-edges');
  const base = { projectId, name: 'Edges', startsAt: 200 };
  // Zero is a legitimate agreed budget, so it must not be treated as absent by
  // a falsy check anywhere in the pair rule.
  const eventId = await client.mutation(createEvent, { ...base, budgetAmount: 0, budgetCurrency: 'COP' });
  await expect(client.query(getEvent, { eventId })).resolves.toMatchObject({ budgetAmount: 0, budgetCurrency: 'COP' });
  await expect(client.mutation(createEvent, { ...base, budgetAmount: 0 })).rejects.toMatchObject({ data: { code: 'eventBudgetIncomplete' } });
  await expect(client.mutation(createEvent, { ...base, budgetAmount: Number.MAX_SAFE_INTEGER + 2, budgetCurrency: 'COP' })).rejects.toMatchObject({
    data: { code: 'moneyAmountOutOfRange' },
  });
});

test('listProjectEvents returns the Event context columns through its own return validator', async () => {
  const { client: owner, organizationId, projectId } = await fixture('events-context-list');
  const venueId = await owner.mutation(createLocation, { organizationId, name: 'Hall', type: 'venue' });
  const costCentreId = await owner.mutation(createCostCentre, { organizationId, key: 'clientA', name: 'Client A' });
  const eventId = await owner.mutation(createEvent, {
    projectId,
    name: 'Listed',
    startsAt: 200,
    venueLocationId: venueId,
    clientCostCentreId: costCentreId,
    budgetAmount: 5_000_00,
    budgetCurrency: 'USD',
  });

  const page = await owner.query(listProjectEvents, { projectId, paginationOpts: firstPage });
  expect(page.page).toEqual([expect.objectContaining({
    _id: eventId,
    venueLocationId: venueId,
    clientCostCentreId: costCentreId,
    budgetAmount: 5_000_00,
    budgetCurrency: 'USD',
  })]);
});
