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
const createEvent = api.events.mutations.createEvent;
const changeServiceStatus = api.services.mutations.changeServiceStatus;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const createServiceKind = api.serviceKinds.mutations.createServiceKind;
const createInitialDraftVersion = api.serviceKinds.mutations.createInitialDraftVersion;
const publishServiceKindVersion = api.serviceKinds.mutations.publishServiceKindVersion;
const addServiceKindField = api.serviceKinds.fields.mutations.addServiceKindField;
const createServiceFromServiceKind = api.services.mutations.createServiceFromServiceKind;
const createRelationship = api.relationships.mutations.createRelationship;
const removeRelationship = api.relationships.mutations.removeRelationship;
const listOutgoingRelationships = api.relationships.queries.listOutgoingRelationships;
const listIncomingRelationships = api.relationships.queries.listIncomingRelationships;

const issuer = 'https://example.clerk.accounts.dev';
const inaccessible = 'notFoundOrInaccessible';
const unauthenticated = 'unauthenticated';
const firstPage = { numItems: 10, cursor: null };
type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;
type RelationshipType = Doc<'serviceRelationships'>['type'];

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(ensureUser, {});
  return { client, userId };
}

/** Minimal public-API Service fixture, shaped after tests/services.test.ts. */
async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'relationships-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Relationships', slug: 'relationships-fixture' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Primary project' });
  const eventId = await owner.client.mutation(createEvent, { projectId, name: 'Primary event', startsAt: 0 });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, {
    organizationId,
    key: 'code',
    label: 'Code',
    config: { kind: 'text' },
  });
  const serviceKindId = await owner.client.mutation(createServiceKind, { organizationId, key: 'relationshipPlan', name: 'Relationship plan' });
  const serviceKindVersionId = await owner.client.mutation(createInitialDraftVersion, { serviceKindId });
  await owner.client.mutation(addServiceKindField, { serviceKindVersionId, fieldDefinitionId, required: true, visible: true });
  await owner.client.mutation(publishServiceKindVersion, { serviceKindVersionId });
  let sequence = 0;
  const createService = (event = eventId) => {
    sequence += 1;
    return owner.client.mutation(createServiceFromServiceKind, {
      eventId: event,
      serviceKindVersionId,
      name: `Service ${sequence}`,
      startsAt: sequence,
      values: [{ fieldDefinitionId, value: { kind: 'text', value: 'ok' } }],
    });
  };
  return { t, owner, organizationId, projectId, eventId, serviceKindId, serviceKindVersionId, createService };
}

async function missingServiceId(t: SchemaTest, organizationId: Id<'organizations'>, projectId: Id<'projects'>, eventId: Id<'events'>, serviceKindId: Id<'serviceKinds'>, serviceKindVersionId: Id<'serviceKindVersions'>) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('services', { organizationId, projectId, eventId, serviceKindId, serviceKindVersionId, name: 'Missing', status: 'draft', startsAt: 0 });
    await ctx.db.delete(id);
    return id;
  });
}

async function missingRelationshipId(t: SchemaTest, organizationId: Id<'organizations'>, sourceServiceId: Id<'services'>, targetServiceId: Id<'services'>) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('serviceRelationships', { organizationId, sourceServiceId, targetServiceId, type: 'relatedTo' });
    await ctx.db.delete(id);
    return id;
  });
}

test('creates all typed links, joins counterpart services, and allows same-org cross-project links', async () => {
  const { owner, organizationId, createService } = await fixture();
  const source = await createService();
  const target = await createService();
  const types: RelationshipType[] = ['dependsOn', 'follows', 'parentOf', 'relatedTo'];
  for (const type of types) await owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type });

  const outgoing = await owner.client.query(listOutgoingRelationships, { serviceId: source, paginationOpts: firstPage });
  const incoming = await owner.client.query(listIncomingRelationships, { serviceId: target, paginationOpts: firstPage });
  expect(outgoing.page.map((row) => row.type)).toEqual(types);
  expect(incoming.page.map((row) => row.type)).toEqual(types);
  expect(outgoing.page.every((row) => row.counterpartService._id === target && row.counterpartService.name === 'Service 2')).toBe(true);
  expect(incoming.page.every((row) => row.counterpartService._id === source && row.counterpartService.status === 'draft')).toBe(true);

  const otherProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Other project' });
  const otherEventId = await owner.client.mutation(createEvent, { projectId: otherProjectId, name: 'Other event', startsAt: 0 });
  const otherProjectService = await createService(otherEventId);
  await expect(owner.client.mutation(createRelationship, {
    sourceServiceId: source,
    targetServiceId: otherProjectService,
    type: 'dependsOn',
  })).resolves.toBeDefined();
});

test('rejects cross-org, fabricated, self, duplicate links while preserving distinct type and direction', async () => {
  const { t, owner, organizationId, projectId, eventId, serviceKindId, serviceKindVersionId, createService } = await fixture();
  const source = await createService();
  const target = await createService();
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Foreign', slug: 'relationships-foreign' });
  const foreignProjectId = await owner.client.mutation(createProject, { organizationId: foreignOrganizationId, name: 'Foreign project' });
  const foreignEventId = await owner.client.mutation(createEvent, { projectId: foreignProjectId, name: 'Foreign event', startsAt: 0 });
  const foreignFieldId = await owner.client.mutation(createFieldDefinition, { organizationId: foreignOrganizationId, key: 'code', label: 'Code', config: { kind: 'text' } });
  const foreignServiceKindId = await owner.client.mutation(createServiceKind, { organizationId: foreignOrganizationId, key: 'foreignPlan', name: 'Foreign plan' });
  const foreignVersionId = await owner.client.mutation(createInitialDraftVersion, { serviceKindId: foreignServiceKindId });
  await owner.client.mutation(addServiceKindField, { serviceKindVersionId: foreignVersionId, fieldDefinitionId: foreignFieldId, required: true, visible: true });
  await owner.client.mutation(publishServiceKindVersion, { serviceKindVersionId: foreignVersionId });
  const foreignService = await owner.client.mutation(createServiceFromServiceKind, {
    eventId: foreignEventId, serviceKindVersionId: foreignVersionId, name: 'Foreign service', startsAt: 1,
    values: [{ fieldDefinitionId: foreignFieldId, value: { kind: 'text', value: 'ok' } }],
  });
  const missing = await missingServiceId(t, organizationId, projectId, eventId, serviceKindId, serviceKindVersionId);

  // Both orderings: the foreign Service resolves in a different position each way,
  // and the tenancy check must not depend on which side reaches it first.
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: foreignService, type: 'dependsOn' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: foreignService, targetServiceId: source, type: 'dependsOn' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: missing, targetServiceId: target, type: 'dependsOn' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: missing, type: 'dependsOn' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: source, type: 'dependsOn' })).rejects.toMatchObject({ data: { code: 'relationshipSelfReference' } });

  await owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type: 'dependsOn' });
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type: 'dependsOn' })).rejects.toMatchObject({ data: { code: 'conflict' } });
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type: 'follows' })).resolves.toBeDefined();
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: target, targetServiceId: source, type: 'dependsOn' })).resolves.toBeDefined();
});

test('all public functions authenticate first and enforce planner authoring while viewers read', async () => {
  const { t, owner, organizationId, projectId, eventId, serviceKindId, serviceKindVersionId, createService } = await fixture();
  const source = await createService();
  const target = await createService();
  const relationshipId = await owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type: 'relatedTo' });
  const missingService = await missingServiceId(t, organizationId, projectId, eventId, serviceKindId, serviceKindVersionId);
  const missingRelationship = await missingRelationshipId(t, organizationId, source, target);
  for (const serviceId of [source, missingService]) {
    await expect(t.mutation(createRelationship, { sourceServiceId: serviceId, targetServiceId: target, type: 'follows' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.query(listOutgoingRelationships, { serviceId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.query(listIncomingRelationships, { serviceId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
  }
  await expect(t.mutation(createRelationship, { sourceServiceId: source, targetServiceId: missingService, type: 'follows' })).rejects.toMatchObject({ data: { code: unauthenticated } });
  for (const id of [relationshipId, missingRelationship]) {
    await expect(t.mutation(removeRelationship, { relationshipId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
  }

  // A provisioned stranger is not a weaker case than an anonymous one: the read
  // path must refuse them on membership, generically, for a real id and a
  // fabricated one alike (I1/I9).
  const stranger = await provision(t, 'relationships-stranger');
  for (const serviceId of [source, target, missingService]) {
    await expect(stranger.client.query(listOutgoingRelationships, { serviceId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(stranger.client.query(listIncomingRelationships, { serviceId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  const viewer = await provision(t, 'relationships-viewer');
  const operator = await provision(t, 'relationships-operator');
  const planner = await provision(t, 'relationships-planner');
  const admin = await provision(t, 'relationships-admin');
  for (const member of [viewer, operator, planner, admin]) await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: member === planner ? 'planner' : member === admin ? 'admin' : member === viewer ? 'viewer' : 'operator' });
  // The viewer gets the CONTENT of both directions, not merely a resolved
  // promise: a read path that handed viewers an empty page would otherwise be
  // indistinguishable from one that granted them access.
  const viewerOutgoing = await viewer.client.query(listOutgoingRelationships, { serviceId: source, paginationOpts: firstPage });
  expect(viewerOutgoing.page.map((row) => [row._id, row.type, row.counterpartService._id])).toEqual([[relationshipId, 'relatedTo', target]]);
  const viewerIncoming = await viewer.client.query(listIncomingRelationships, { serviceId: target, paginationOpts: firstPage });
  expect(viewerIncoming.page.map((row) => [row._id, row.type, row.counterpartService._id])).toEqual([[relationshipId, 'relatedTo', source]]);
  // A member with the read floor still cannot name an Service that does not exist:
  // fabricated and foreign stay indistinguishable on the read path (I9).
  await expect(viewer.client.query(listOutgoingRelationships, { serviceId: missingService, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(viewer.client.query(listIncomingRelationships, { serviceId: missingService, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  for (const member of [viewer, operator]) {
    await expect(member.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type: 'follows' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(member.client.mutation(removeRelationship, { relationshipId })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  await expect(planner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type: 'follows' })).resolves.toBeDefined();
  // Above the floor works too, explicitly for removal: planner is a floor, not a
  // whitelist, so admin (and owner) clear it.
  await expect(admin.client.mutation(removeRelationship, { relationshipId })).resolves.toBeNull();
  const adminCreated = await admin.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type: 'parentOf' });
  await expect(planner.client.mutation(removeRelationship, { relationshipId: adminCreated })).resolves.toBeNull();
});

test('directional queries paginate and removal audits then deletes the link', async () => {
  const { t, owner, organizationId, createService } = await fixture();
  const source = await createService();
  const firstTarget = await createService();
  const secondTarget = await createService();
  const thirdTarget = await createService();
  const firstId = await owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: firstTarget, type: 'relatedTo' });
  await owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: secondTarget, type: 'relatedTo' });
  await owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: thirdTarget, type: 'relatedTo' });
  const secondSource = await createService();
  const thirdSource = await createService();
  await owner.client.mutation(createRelationship, { sourceServiceId: secondSource, targetServiceId: firstTarget, type: 'relatedTo' });
  await owner.client.mutation(createRelationship, { sourceServiceId: thirdSource, targetServiceId: firstTarget, type: 'relatedTo' });

  const outgoingFirst = await owner.client.query(listOutgoingRelationships, { serviceId: source, paginationOpts: { numItems: 2, cursor: null } });
  const outgoingSecond = await owner.client.query(listOutgoingRelationships, { serviceId: source, paginationOpts: { numItems: 2, cursor: outgoingFirst.continueCursor } });
  expect(outgoingFirst.page).toHaveLength(2);
  expect(outgoingSecond.page).toHaveLength(1);
  const incomingFirst = await owner.client.query(listIncomingRelationships, { serviceId: firstTarget, paginationOpts: { numItems: 2, cursor: null } });
  const incomingSecond = await owner.client.query(listIncomingRelationships, { serviceId: firstTarget, paginationOpts: { numItems: 2, cursor: incomingFirst.continueCursor } });
  expect(incomingFirst.page).toHaveLength(2);
  expect(incomingSecond.page).toHaveLength(1);

  await owner.client.mutation(removeRelationship, { relationshipId: firstId });
  const afterRemoval = await owner.client.query(listIncomingRelationships, { serviceId: firstTarget, paginationOpts: firstPage });
  expect(afterRemoval.page.map((row) => row._id)).not.toContain(firstId);
  const missing = await missingRelationshipId(t, organizationId, source, firstTarget);
  await expect(owner.client.mutation(removeRelationship, { relationshipId: missing })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.client.mutation(removeRelationship, { relationshipId: firstId })).rejects.toMatchObject({ data: { code: inaccessible } });
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Foreign removal', slug: 'relationships-foreign-removal' });
  const foreignRelationshipId = await t.run((ctx) =>
    ctx.db.insert('serviceRelationships', {
      organizationId: foreignOrganizationId,
      sourceServiceId: source,
      targetServiceId: secondTarget,
      type: 'follows',
    }),
  );
  const member = await provision(t, 'relationships-removal-member');
  await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'planner' });
  // That row is deliberately inconsistent: its organization column disagrees
  // with the Services it joins. Authorization follows the Service graph, so it is
  // refused even for a planner of the Services' own organization (I4) — and the
  // owner, who *is* a member of the foreign organization, fares no better.
  await expect(member.client.mutation(removeRelationship, { relationshipId: foreignRelationshipId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.client.mutation(removeRelationship, { relationshipId: foreignRelationshipId })).rejects.toMatchObject({ data: { code: inaccessible } });
  // On the read side the same row is skipped rather than fatal: one bad row must
  // not make the whole directional list unreadable, and the healthy links still
  // come back.
  const outgoingWithAnomaly = await owner.client.query(listOutgoingRelationships, { serviceId: source, paginationOpts: firstPage });
  expect(outgoingWithAnomaly.page.map((row) => row._id)).not.toContain(foreignRelationshipId);
  expect(outgoingWithAnomaly.page.map((row) => row.targetServiceId)).toEqual([secondTarget, thirdTarget]);
  const incomingWithAnomaly = await owner.client.query(listIncomingRelationships, { serviceId: secondTarget, paginationOpts: firstPage });
  expect(incomingWithAnomaly.page.map((row) => row._id)).not.toContain(foreignRelationshipId);
  expect(incomingWithAnomaly.page.map((row) => row.sourceServiceId)).toEqual([source]);

  await t.run(async (ctx) => {
    expect(await ctx.db.get(firstId)).toBeNull();
    const audits = await ctx.db.query('auditEvents').withIndex('by_org_entity', (q) =>
      q.eq('organizationId', organizationId).eq('entityType', 'serviceRelationship').eq('entityId', firstId),
    ).collect();
    expect(audits).toHaveLength(2);
    // Both endpoints on BOTH rows: the link is hard-deleted, so `created` read on
    // its own must still name what it joined.
    expect(audits[0]).toMatchObject({ action: 'relationship.created', organizationId, actorUserId: owner.userId, metadata: { type: 'relatedTo', sourceServiceId: source, targetServiceId: firstTarget } });
    expect(audits[1]).toMatchObject({ action: 'relationship.removed', organizationId, actorUserId: owner.userId, metadata: { type: 'relatedTo', sourceServiceId: source, targetServiceId: firstTarget } });
  });
});

test('F1 regression: the archival freeze reaches relationship writes through every door', async () => {
  const { owner, organizationId, createService } = await fixture();
  const source = await createService();
  const target = await createService();
  const healthyLink = await owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type: 'relatedTo' });

  // A terminal Service is read-only, and a link is a write to its source.
  const cancelled = await createService();
  const cancelledLink = await owner.client.mutation(createRelationship, { sourceServiceId: cancelled, targetServiceId: target, type: 'relatedTo' });
  await owner.client.mutation(changeServiceStatus, { serviceId: cancelled, status: 'cancelled' });
  const completed = await createService();
  const completedLink = await owner.client.mutation(createRelationship, { sourceServiceId: completed, targetServiceId: target, type: 'relatedTo' });
  for (const status of ['planned', 'confirmed', 'active', 'completed'] as const) {
    await owner.client.mutation(changeServiceStatus, { serviceId: completed, status });
  }
  const terminal = 'serviceReadOnly';
  for (const [serviceId, relationshipId] of [[cancelled, cancelledLink], [completed, completedLink]] as const) {
    await expect(owner.client.mutation(createRelationship, { sourceServiceId: serviceId, targetServiceId: target, type: 'dependsOn' })).rejects.toMatchObject({ data: { code: terminal } });
    await expect(owner.client.mutation(removeRelationship, { relationshipId })).rejects.toMatchObject({ data: { code: terminal } });
  }
  // A terminal Service remains a legal TARGET: recording that live work follows the
  // arrival that already happened writes nothing to the arrival.
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: completed, type: 'follows' })).resolves.toBeDefined();

  // An archived project freezes its services' links in both directions.
  const archivedProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Archived' });
  const archivedEventId = await owner.client.mutation(createEvent, { projectId: archivedProjectId, name: 'Archived event', startsAt: 0 });
  const frozenService = await createService(archivedEventId);
  const frozenLink = await owner.client.mutation(createRelationship, { sourceServiceId: frozenService, targetServiceId: target, type: 'relatedTo' });
  await owner.client.mutation(archiveProject, { projectId: archivedProjectId });
  const frozen = 'serviceProjectReadOnly';
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: frozenService, targetServiceId: target, type: 'dependsOn' })).rejects.toMatchObject({ data: { code: frozen } });
  await expect(owner.client.mutation(removeRelationship, { relationshipId: frozenLink })).rejects.toMatchObject({ data: { code: frozen } });
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: frozenService, type: 'dependsOn' })).rejects.toMatchObject({ data: { code: frozen } });

  // Frozen means unwritable, not unreadable, and healthy Services are untouched.
  await expect(owner.client.query(listOutgoingRelationships, { serviceId: frozenService, paginationOpts: firstPage })).resolves.toMatchObject({ isDone: true });
  await expect(owner.client.mutation(createRelationship, { sourceServiceId: source, targetServiceId: target, type: 'parentOf' })).resolves.toBeDefined();
  await expect(owner.client.mutation(removeRelationship, { relationshipId: healthyLink })).resolves.toBeNull();
});
