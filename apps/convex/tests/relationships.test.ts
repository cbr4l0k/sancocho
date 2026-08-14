import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProject = api.projects.mutations.createProject;
const archiveProject = api.projects.mutations.archiveProject;
const changeEventStatus = api.events.mutations.changeEventStatus;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const createRecipe = api.recipes.mutations.createRecipe;
const createInitialDraftVersion = api.recipes.mutations.createInitialDraftVersion;
const publishRecipeVersion = api.recipes.mutations.publishRecipeVersion;
const addRecipeField = api.recipes.fields.mutations.addRecipeField;
const createEventFromRecipe = api.events.mutations.createEventFromRecipe;
const createRelationship = api.relationships.mutations.createRelationship;
const removeRelationship = api.relationships.mutations.removeRelationship;
const listOutgoingRelationships = api.relationships.queries.listOutgoingRelationships;
const listIncomingRelationships = api.relationships.queries.listIncomingRelationships;

const issuer = 'https://example.clerk.accounts.dev';
const inaccessible = 'Not found or inaccessible';
const unauthenticated = 'Unauthenticated';
const firstPage = { numItems: 10, cursor: null };
type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;
type RelationshipType = Doc<'eventRelationships'>['type'];

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(ensureUser, {});
  return { client, userId };
}

/** Minimal public-API Event fixture, shaped after tests/events.test.ts. */
async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'relationships-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Relationships', slug: 'relationships-fixture' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Primary project' });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, {
    organizationId,
    key: 'code',
    label: 'Code',
    config: { kind: 'text' },
  });
  const recipeId = await owner.client.mutation(createRecipe, { organizationId, key: 'relationshipPlan', name: 'Relationship plan' });
  const recipeVersionId = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await owner.client.mutation(addRecipeField, { recipeVersionId, fieldDefinitionId, required: true, visible: true });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId });
  let sequence = 0;
  const createEvent = (project = projectId) => {
    sequence += 1;
    return owner.client.mutation(createEventFromRecipe, {
      projectId: project,
      recipeVersionId,
      name: `Event ${sequence}`,
      startsAt: sequence,
      values: [{ fieldDefinitionId, value: { kind: 'text', value: 'ok' } }],
    });
  };
  return { t, owner, organizationId, projectId, recipeId, recipeVersionId, createEvent };
}

async function missingEventId(t: SchemaTest, organizationId: Id<'organizations'>, projectId: Id<'projects'>, recipeId: Id<'eventRecipes'>, recipeVersionId: Id<'recipeVersions'>) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('events', { organizationId, projectId, recipeId, recipeVersionId, name: 'Missing', status: 'draft', startsAt: 0 });
    await ctx.db.delete(id);
    return id;
  });
}

async function missingRelationshipId(t: SchemaTest, organizationId: Id<'organizations'>, sourceEventId: Id<'events'>, targetEventId: Id<'events'>) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('eventRelationships', { organizationId, sourceEventId, targetEventId, type: 'relatedTo' });
    await ctx.db.delete(id);
    return id;
  });
}

test('creates all typed links, joins counterpart events, and allows same-org cross-project links', async () => {
  const { owner, organizationId, createEvent } = await fixture();
  const source = await createEvent();
  const target = await createEvent();
  const types: RelationshipType[] = ['dependsOn', 'follows', 'parentOf', 'relatedTo'];
  for (const type of types) await owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type });

  const outgoing = await owner.client.query(listOutgoingRelationships, { eventId: source, paginationOpts: firstPage });
  const incoming = await owner.client.query(listIncomingRelationships, { eventId: target, paginationOpts: firstPage });
  expect(outgoing.page.map((row) => row.type)).toEqual(types);
  expect(incoming.page.map((row) => row.type)).toEqual(types);
  expect(outgoing.page.every((row) => row.counterpartEvent._id === target && row.counterpartEvent.name === 'Event 2')).toBe(true);
  expect(incoming.page.every((row) => row.counterpartEvent._id === source && row.counterpartEvent.status === 'draft')).toBe(true);

  const otherProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Other project' });
  const otherProjectEvent = await createEvent(otherProjectId);
  await expect(owner.client.mutation(createRelationship, {
    sourceEventId: source,
    targetEventId: otherProjectEvent,
    type: 'dependsOn',
  })).resolves.toBeDefined();
});

test('rejects cross-org, fabricated, self, duplicate links while preserving distinct type and direction', async () => {
  const { t, owner, organizationId, projectId, recipeId, recipeVersionId, createEvent } = await fixture();
  const source = await createEvent();
  const target = await createEvent();
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Foreign', slug: 'relationships-foreign' });
  const foreignProjectId = await owner.client.mutation(createProject, { organizationId: foreignOrganizationId, name: 'Foreign project' });
  const foreignFieldId = await owner.client.mutation(createFieldDefinition, { organizationId: foreignOrganizationId, key: 'code', label: 'Code', config: { kind: 'text' } });
  const foreignRecipeId = await owner.client.mutation(createRecipe, { organizationId: foreignOrganizationId, key: 'foreignPlan', name: 'Foreign plan' });
  const foreignVersionId = await owner.client.mutation(createInitialDraftVersion, { recipeId: foreignRecipeId });
  await owner.client.mutation(addRecipeField, { recipeVersionId: foreignVersionId, fieldDefinitionId: foreignFieldId, required: true, visible: true });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: foreignVersionId });
  const foreignEvent = await owner.client.mutation(createEventFromRecipe, {
    projectId: foreignProjectId, recipeVersionId: foreignVersionId, name: 'Foreign event', startsAt: 1,
    values: [{ fieldDefinitionId: foreignFieldId, value: { kind: 'text', value: 'ok' } }],
  });
  const missing = await missingEventId(t, organizationId, projectId, recipeId, recipeVersionId);

  // Both orderings: the foreign Event resolves in a different position each way,
  // and the tenancy check must not depend on which side reaches it first.
  await expect(owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: foreignEvent, type: 'dependsOn' })).rejects.toMatchObject({ data: inaccessible });
  await expect(owner.client.mutation(createRelationship, { sourceEventId: foreignEvent, targetEventId: source, type: 'dependsOn' })).rejects.toMatchObject({ data: inaccessible });
  await expect(owner.client.mutation(createRelationship, { sourceEventId: missing, targetEventId: target, type: 'dependsOn' })).rejects.toMatchObject({ data: inaccessible });
  await expect(owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: missing, type: 'dependsOn' })).rejects.toMatchObject({ data: inaccessible });
  await expect(owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: source, type: 'dependsOn' })).rejects.toMatchObject({ data: 'An Event cannot relate to itself' });

  await owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type: 'dependsOn' });
  await expect(owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type: 'dependsOn' })).rejects.toMatchObject({ data: 'Conflict' });
  await expect(owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type: 'follows' })).resolves.toBeDefined();
  await expect(owner.client.mutation(createRelationship, { sourceEventId: target, targetEventId: source, type: 'dependsOn' })).resolves.toBeDefined();
});

test('all public functions authenticate first and enforce planner authoring while viewers read', async () => {
  const { t, owner, organizationId, projectId, recipeId, recipeVersionId, createEvent } = await fixture();
  const source = await createEvent();
  const target = await createEvent();
  const relationshipId = await owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type: 'relatedTo' });
  const missingEvent = await missingEventId(t, organizationId, projectId, recipeId, recipeVersionId);
  const missingRelationship = await missingRelationshipId(t, organizationId, source, target);
  for (const eventId of [source, missingEvent]) {
    await expect(t.mutation(createRelationship, { sourceEventId: eventId, targetEventId: target, type: 'follows' })).rejects.toMatchObject({ data: unauthenticated });
    await expect(t.query(listOutgoingRelationships, { eventId, paginationOpts: firstPage })).rejects.toMatchObject({ data: unauthenticated });
    await expect(t.query(listIncomingRelationships, { eventId, paginationOpts: firstPage })).rejects.toMatchObject({ data: unauthenticated });
  }
  await expect(t.mutation(createRelationship, { sourceEventId: source, targetEventId: missingEvent, type: 'follows' })).rejects.toMatchObject({ data: unauthenticated });
  for (const id of [relationshipId, missingRelationship]) {
    await expect(t.mutation(removeRelationship, { relationshipId: id })).rejects.toMatchObject({ data: unauthenticated });
  }

  // A provisioned stranger is not a weaker case than an anonymous one: the read
  // path must refuse them on membership, generically, for a real id and a
  // fabricated one alike (I1/I9).
  const stranger = await provision(t, 'relationships-stranger');
  for (const eventId of [source, target, missingEvent]) {
    await expect(stranger.client.query(listOutgoingRelationships, { eventId, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });
    await expect(stranger.client.query(listIncomingRelationships, { eventId, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });
  }

  const viewer = await provision(t, 'relationships-viewer');
  const operator = await provision(t, 'relationships-operator');
  const planner = await provision(t, 'relationships-planner');
  const admin = await provision(t, 'relationships-admin');
  for (const member of [viewer, operator, planner, admin]) await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: member === planner ? 'planner' : member === admin ? 'admin' : member === viewer ? 'viewer' : 'operator' });
  await expect(viewer.client.query(listOutgoingRelationships, { eventId: source, paginationOpts: firstPage })).resolves.toBeDefined();
  await expect(viewer.client.query(listIncomingRelationships, { eventId: target, paginationOpts: firstPage })).resolves.toBeDefined();
  // A member with the read floor still cannot name an Event that does not exist:
  // fabricated and foreign stay indistinguishable on the read path (I9).
  await expect(viewer.client.query(listOutgoingRelationships, { eventId: missingEvent, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });
  await expect(viewer.client.query(listIncomingRelationships, { eventId: missingEvent, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });
  for (const member of [viewer, operator]) {
    await expect(member.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type: 'follows' })).rejects.toMatchObject({ data: inaccessible });
    await expect(member.client.mutation(removeRelationship, { relationshipId })).rejects.toMatchObject({ data: inaccessible });
  }
  await expect(planner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type: 'follows' })).resolves.toBeDefined();
  // Above the floor works too, explicitly for removal: planner is a floor, not a
  // whitelist, so admin (and owner) clear it.
  await expect(admin.client.mutation(removeRelationship, { relationshipId })).resolves.toBeNull();
  const adminCreated = await admin.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type: 'parentOf' });
  await expect(planner.client.mutation(removeRelationship, { relationshipId: adminCreated })).resolves.toBeNull();
});

test('directional queries paginate and removal audits then deletes the link', async () => {
  const { t, owner, organizationId, createEvent } = await fixture();
  const source = await createEvent();
  const firstTarget = await createEvent();
  const secondTarget = await createEvent();
  const thirdTarget = await createEvent();
  const firstId = await owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: firstTarget, type: 'relatedTo' });
  await owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: secondTarget, type: 'relatedTo' });
  await owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: thirdTarget, type: 'relatedTo' });
  const secondSource = await createEvent();
  const thirdSource = await createEvent();
  await owner.client.mutation(createRelationship, { sourceEventId: secondSource, targetEventId: firstTarget, type: 'relatedTo' });
  await owner.client.mutation(createRelationship, { sourceEventId: thirdSource, targetEventId: firstTarget, type: 'relatedTo' });

  const outgoingFirst = await owner.client.query(listOutgoingRelationships, { eventId: source, paginationOpts: { numItems: 2, cursor: null } });
  const outgoingSecond = await owner.client.query(listOutgoingRelationships, { eventId: source, paginationOpts: { numItems: 2, cursor: outgoingFirst.continueCursor } });
  expect(outgoingFirst.page).toHaveLength(2);
  expect(outgoingSecond.page).toHaveLength(1);
  const incomingFirst = await owner.client.query(listIncomingRelationships, { eventId: firstTarget, paginationOpts: { numItems: 2, cursor: null } });
  const incomingSecond = await owner.client.query(listIncomingRelationships, { eventId: firstTarget, paginationOpts: { numItems: 2, cursor: incomingFirst.continueCursor } });
  expect(incomingFirst.page).toHaveLength(2);
  expect(incomingSecond.page).toHaveLength(1);

  await owner.client.mutation(removeRelationship, { relationshipId: firstId });
  const afterRemoval = await owner.client.query(listIncomingRelationships, { eventId: firstTarget, paginationOpts: firstPage });
  expect(afterRemoval.page.map((row) => row._id)).not.toContain(firstId);
  const missing = await missingRelationshipId(t, organizationId, source, firstTarget);
  await expect(owner.client.mutation(removeRelationship, { relationshipId: missing })).rejects.toMatchObject({ data: inaccessible });
  await expect(owner.client.mutation(removeRelationship, { relationshipId: firstId })).rejects.toMatchObject({ data: inaccessible });
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Foreign removal', slug: 'relationships-foreign-removal' });
  const foreignRelationshipId = await t.run((ctx) =>
    ctx.db.insert('eventRelationships', {
      organizationId: foreignOrganizationId,
      sourceEventId: source,
      targetEventId: secondTarget,
      type: 'follows',
    }),
  );
  const member = await provision(t, 'relationships-removal-member');
  await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'planner' });
  // That row is deliberately inconsistent: its organization column disagrees
  // with the Events it joins. Authorization follows the Event graph, so it is
  // refused even for a planner of the Events' own organization (I4) — and the
  // owner, who *is* a member of the foreign organization, fares no better.
  await expect(member.client.mutation(removeRelationship, { relationshipId: foreignRelationshipId })).rejects.toMatchObject({ data: inaccessible });
  await expect(owner.client.mutation(removeRelationship, { relationshipId: foreignRelationshipId })).rejects.toMatchObject({ data: inaccessible });
  // On the read side the same row is skipped rather than fatal: one bad row must
  // not make the whole directional list unreadable, and the healthy links still
  // come back.
  const outgoingWithAnomaly = await owner.client.query(listOutgoingRelationships, { eventId: source, paginationOpts: firstPage });
  expect(outgoingWithAnomaly.page.map((row) => row._id)).not.toContain(foreignRelationshipId);
  expect(outgoingWithAnomaly.page.map((row) => row.targetEventId)).toEqual([secondTarget, thirdTarget]);
  const incomingWithAnomaly = await owner.client.query(listIncomingRelationships, { eventId: secondTarget, paginationOpts: firstPage });
  expect(incomingWithAnomaly.page.map((row) => row._id)).not.toContain(foreignRelationshipId);
  expect(incomingWithAnomaly.page.map((row) => row.sourceEventId)).toEqual([source]);

  await t.run(async (ctx) => {
    expect(await ctx.db.get(firstId)).toBeNull();
    const audits = await ctx.db.query('auditEvents').withIndex('by_org_entity', (q) =>
      q.eq('organizationId', organizationId).eq('entityType', 'eventRelationship').eq('entityId', firstId),
    ).collect();
    expect(audits).toHaveLength(2);
    // Both endpoints on BOTH rows: the link is hard-deleted, so `created` read on
    // its own must still name what it joined.
    expect(audits[0]).toMatchObject({ action: 'relationship.created', organizationId, actorUserId: owner.userId, metadata: { type: 'relatedTo', sourceEventId: source, targetEventId: firstTarget } });
    expect(audits[1]).toMatchObject({ action: 'relationship.removed', organizationId, actorUserId: owner.userId, metadata: { type: 'relatedTo', sourceEventId: source, targetEventId: firstTarget } });
  });
});

test('F1 regression: the archival freeze reaches relationship writes through every door', async () => {
  const { owner, organizationId, createEvent } = await fixture();
  const source = await createEvent();
  const target = await createEvent();
  const healthyLink = await owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type: 'relatedTo' });

  // A terminal Event is read-only, and a link is a write to its source.
  const cancelled = await createEvent();
  const cancelledLink = await owner.client.mutation(createRelationship, { sourceEventId: cancelled, targetEventId: target, type: 'relatedTo' });
  await owner.client.mutation(changeEventStatus, { eventId: cancelled, status: 'cancelled' });
  const completed = await createEvent();
  const completedLink = await owner.client.mutation(createRelationship, { sourceEventId: completed, targetEventId: target, type: 'relatedTo' });
  for (const status of ['planned', 'confirmed', 'active', 'completed'] as const) {
    await owner.client.mutation(changeEventStatus, { eventId: completed, status });
  }
  const terminal = 'Completed and cancelled events are read-only';
  for (const [eventId, relationshipId] of [[cancelled, cancelledLink], [completed, completedLink]] as const) {
    await expect(owner.client.mutation(createRelationship, { sourceEventId: eventId, targetEventId: target, type: 'dependsOn' })).rejects.toMatchObject({ data: terminal });
    await expect(owner.client.mutation(removeRelationship, { relationshipId })).rejects.toMatchObject({ data: terminal });
  }
  // A terminal Event remains a legal TARGET: recording that live work follows the
  // arrival that already happened writes nothing to the arrival.
  await expect(owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: completed, type: 'follows' })).resolves.toBeDefined();

  // An archived project freezes its events' links in both directions.
  const archivedProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Archived' });
  const frozenEvent = await createEvent(archivedProjectId);
  const frozenLink = await owner.client.mutation(createRelationship, { sourceEventId: frozenEvent, targetEventId: target, type: 'relatedTo' });
  await owner.client.mutation(archiveProject, { projectId: archivedProjectId });
  const frozen = 'Archived projects are read-only for their events';
  await expect(owner.client.mutation(createRelationship, { sourceEventId: frozenEvent, targetEventId: target, type: 'dependsOn' })).rejects.toMatchObject({ data: frozen });
  await expect(owner.client.mutation(removeRelationship, { relationshipId: frozenLink })).rejects.toMatchObject({ data: frozen });
  await expect(owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: frozenEvent, type: 'dependsOn' })).rejects.toMatchObject({ data: frozen });

  // Frozen means unwritable, not unreadable, and healthy Events are untouched.
  await expect(owner.client.query(listOutgoingRelationships, { eventId: frozenEvent, paginationOpts: firstPage })).resolves.toMatchObject({ isDone: true });
  await expect(owner.client.mutation(createRelationship, { sourceEventId: source, targetEventId: target, type: 'parentOf' })).resolves.toBeDefined();
  await expect(owner.client.mutation(removeRelationship, { relationshipId: healthyLink })).resolves.toBeNull();
});
