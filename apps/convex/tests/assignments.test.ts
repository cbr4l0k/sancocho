import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { requireAssignmentAccess } from '../convex/assignments/model';
import { rateCardVersionHasAssignmentRevisions } from '../convex/rateCards/references';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const createProvider = api.providers.mutations.createProvider;
const archiveProvider = api.providers.mutations.archiveProvider;
const deleteProvider = api.providers.mutations.deleteProvider;
const grantProjectAccessToProvider = api.providers.mutations.grantProjectAccessToProvider;
const revokeProviderAccessGrant = api.providers.mutations.revokeProviderAccessGrant;
const createVehicleClass = api.vehicles.mutations.createVehicleClass;
const archiveVehicleClass = api.vehicles.mutations.archiveVehicleClass;
const deleteVehicleClass = api.vehicles.mutations.deleteVehicleClass;
const createRateCard = api.rateCards.mutations.createRateCard;
const updateRateCardMetadata = api.rateCards.mutations.updateRateCardMetadata;
const createInitialDraftVersion = api.rateCards.mutations.createInitialDraftVersion;
const addRateLine = api.rateCards.mutations.addRateLine;
const publishRateCardVersion = api.rateCards.mutations.publishRateCardVersion;
const retireRateCardVersion = api.rateCards.mutations.retireRateCardVersion;
const changeServiceStatus = api.services.mutations.changeServiceStatus;
const archiveProject = api.projects.mutations.archiveProject;

const createAssignment = api.assignments.mutations.createAssignment;
const createAssignmentRevision = api.assignments.mutations.createAssignmentRevision;
const acceptAssignmentRevision = api.assignments.mutations.acceptAssignmentRevision;
const declineAssignmentRevision = api.assignments.mutations.declineAssignmentRevision;
const removeAssignment = api.assignments.mutations.removeAssignment;
const getAssignment = api.assignments.queries.getAssignment;
const getAssignmentRevision = api.assignments.queries.getAssignmentRevision;
const listAssignmentRevisions = api.assignments.queries.listAssignmentRevisions;
const listServiceAssignments = api.assignments.queries.listServiceAssignments;
const listProjectAssignments = api.assignments.queries.listProjectAssignments;

const inaccessible = 'notFoundOrInaccessible';
const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 10, cursor: null };

type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;
type Client = ReturnType<SchemaTest['withIdentity']>;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId: Id<'users'> = await client.mutation(ensureUser, {});
  return { client, userId };
}

async function insertService(
  t: SchemaTest,
  organizationId: Id<'organizations'>,
  name: string,
): Promise<{ projectId: Id<'projects'>; serviceId: Id<'services'> }> {
  return t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', { organizationId, name: `${name} project`, status: 'active' });
    const eventId = await ctx.db.insert('events', { organizationId, projectId, name: `${name} event`, status: 'active', startsAt: 0 });
    const serviceKindId = await ctx.db.insert('serviceKinds', { organizationId, key: `${name}Kind`, name: `${name} kind`, status: 'active' });
    const serviceKindVersionId = await ctx.db.insert('serviceKindVersions', {
      organizationId,
      serviceKindId,
      versionNumber: 1,
      status: 'published',
      publishedAt: 1,
    });
    const serviceId = await ctx.db.insert('services', {
      organizationId,
      projectId,
      eventId,
      serviceKindId,
      serviceKindVersionId,
      name,
      status: 'draft',
      startsAt: 1,
    });
    return { projectId, serviceId };
  });
}

async function fixture(subject = 'assignments') {
  const t = convexTest(schema, modules);
  const owner = await provision(t, `${subject}-owner`);
  const organizationId = await owner.client.mutation(createOrganization, {
    name: `${subject} organization`,
    slug: 'assignment-fixture',
  });
  const { projectId, serviceId } = await insertService(t, organizationId, `${subject} service`);
  const providerId = await owner.client.mutation(createProvider, { organizationId, name: `${subject} Provider` });
  const vehicleClassId = await owner.client.mutation(createVehicleClass, {
    organizationId,
    key: 'assignmentClass',
    name: `${subject} Class`,
  });
  const rateCardId = await owner.client.mutation(createRateCard, { organizationId, providerId, name: `${subject} Card` });
  const rateCardVersionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  const rateLineId = await owner.client.mutation(addRateLine, {
    rateCardVersionId,
    vehicleClassId,
    modality: 'disposition',
    unitAmount: 12_345,
  });
  await owner.client.mutation(publishRateCardVersion, { rateCardVersionId });
  const assignmentId = await owner.client.mutation(createAssignment, { serviceId, providerId, position: 10, notes: '  first bus  ' });
  const revisionArgs = {
    assignmentId,
    vehicleClassId,
    modality: 'disposition' as const,
    quantity: 3,
    rateCardVersionId,
    rateLineId,
  };
  return {
    t,
    owner,
    organizationId,
    projectId,
    serviceId,
    providerId,
    vehicleClassId,
    rateCardId,
    rateCardVersionId,
    rateLineId,
    assignmentId,
    revisionArgs,
  };
}

async function makeGrantedProvider(
  f: Awaited<ReturnType<typeof fixture>>,
  subject: string,
  name: string,
): Promise<{ client: Client; providerId: Id<'providers'>; grantId: Id<'providerAccessGrants'> }> {
  const firm = await provision(f.t, subject);
  const firmOrganizationId = await firm.client.mutation(createOrganization, { name, slug: subject });
  const providerId = await f.owner.client.mutation(createProvider, { organizationId: f.organizationId, name });
  await f.t.run(async (ctx) => ctx.db.patch(providerId, { linkedOrganizationId: firmOrganizationId }));
  const grantId = await f.owner.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId });
  return { client: firm.client, providerId, grantId };
}

function commercial(revision: Doc<'assignmentRevisions'>) {
  return {
    revisionNumber: revision.revisionNumber,
    vehicleClassId: revision.vehicleClassId,
    modality: revision.modality,
    quantity: revision.quantity,
    rateCardVersionId: revision.rateCardVersionId,
    rateLineId: revision.rateLineId,
    unitAmount: revision.unitAmount,
    currency: revision.currency,
    lineTotal: revision.lineTotal,
  };
}

test('creation derives tenant and Project from the Service, trims notes, and prices an immutable snapshot', async () => {
  const f = await fixture('assignment-create');
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({
    organizationId: f.organizationId,
    projectId: f.projectId,
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 10,
    notes: 'first bus',
  });
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  expect(await f.owner.client.query(getAssignmentRevision, { revisionId })).toMatchObject({
    assignmentId: f.assignmentId,
    organizationId: f.organizationId,
    revisionNumber: 1,
    status: 'draft',
    unitAmount: 12_345,
    currency: 'COP',
    lineTotal: 37_035,
  });

  const invalidCalls = [
    f.owner.client.mutation(
      createAssignment,
      // @ts-expect-error organizationId and projectId are derived from the stored Service.
      { serviceId: f.serviceId, providerId: f.providerId, position: 20, organizationId: f.organizationId, projectId: f.projectId },
    ),
    f.owner.client.mutation(
      createAssignmentRevision,
      // @ts-expect-error revisionNumber is assigned by the server.
      { ...f.revisionArgs, revisionNumber: 99 },
    ),
  ];
  for (const call of invalidCalls) {
    const result: unknown = await call.catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toHaveProperty('data');
  }
});

test('foreign Service, Provider, Vehicle Class, Rate Card Version, and Rate Line ids each return the generic error', async () => {
  const f = await fixture('assignment-foreign');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign organization',
    slug: 'assignment-foreign-other',
  });
  const foreignService = await insertService(f.t, foreignOrganizationId, 'foreign service');
  const foreignProviderId = await f.owner.client.mutation(createProvider, { organizationId: foreignOrganizationId, name: 'Foreign Provider' });
  const foreignClassId = await f.owner.client.mutation(createVehicleClass, {
    organizationId: foreignOrganizationId,
    key: 'foreignClass',
    name: 'Foreign Class',
  });
  const foreignCardId = await f.owner.client.mutation(createRateCard, {
    organizationId: foreignOrganizationId,
    providerId: foreignProviderId,
    name: 'Foreign Card',
  });
  const foreignVersionId = await f.owner.client.mutation(createInitialDraftVersion, { rateCardId: foreignCardId, currency: 'USD' });
  const foreignLineId = await f.owner.client.mutation(addRateLine, {
    rateCardVersionId: foreignVersionId,
    vehicleClassId: foreignClassId,
    modality: 'disposition',
    unitAmount: 8,
  });
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId: foreignVersionId });

  await expect(f.owner.client.mutation(createAssignment, {
    serviceId: foreignService.serviceId,
    providerId: f.providerId,
    position: 1,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: foreignProviderId,
    position: 1,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
  for (const patch of [
    { vehicleClassId: foreignClassId },
    { rateCardVersionId: foreignVersionId },
    { rateLineId: foreignLineId },
  ]) {
    await expect(f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, ...patch }))
      .rejects.toMatchObject({ data: { code: inaccessible } });
  }
});

test('draft and retired Rate Card Versions are refused as price sources', async () => {
  const f = await fixture('assignment-version-state');
  const draftId = await f.owner.client.mutation(createInitialDraftVersion, { rateCardId: f.rateCardId, currency: 'COP' });
  const draftLineId = await f.owner.client.mutation(addRateLine, {
    rateCardVersionId: draftId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
    unitAmount: 1,
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.rateCardId, { currentPublishedVersionId: draftId }));
  await expect(f.owner.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    rateCardVersionId: draftId,
    rateLineId: draftLineId,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
  await f.t.run(async (ctx) => ctx.db.patch(f.rateCardId, { currentPublishedVersionId: f.rateCardVersionId }));
  await f.owner.client.mutation(retireRateCardVersion, { rateCardVersionId: f.rateCardVersionId });
  await expect(f.owner.client.mutation(createAssignmentRevision, f.revisionArgs))
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('a Card for Provider X cannot price Provider Y and a mismatched Class or modality line is refused', async () => {
  const f = await fixture('assignment-price-cell');
  const otherProviderId = await f.owner.client.mutation(createProvider, { organizationId: f.organizationId, name: 'Provider Y' });
  const otherAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: otherProviderId,
    position: 20,
  });
  await expect(f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, assignmentId: otherAssignmentId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });

  const otherClassId = await f.owner.client.mutation(createVehicleClass, {
    organizationId: f.organizationId,
    key: 'otherClass',
    name: 'Other Class',
  });
  await expect(f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, vehicleClassId: otherClassId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, modality: 'fixed' }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('I10: stored lineTotal and all commercial columns survive Card edits and source retirement exactly', async () => {
  const f = await fixture('assignment-i10');
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  const before = await f.owner.client.query(getAssignmentRevision, { revisionId });
  await f.owner.client.mutation(updateRateCardMetadata, { rateCardId: f.rateCardId, name: 'Renamed source' });
  // Historical snapshots remain authoritative even if source data is later
  // corrected administratively or by a migration.
  await f.t.run(async (ctx) => ctx.db.patch(f.rateLineId, { unitAmount: 999 }));
  await f.owner.client.mutation(retireRateCardVersion, { rateCardVersionId: f.rateCardVersionId });
  const after = await f.owner.client.query(getAssignmentRevision, { revisionId });
  expect(commercial(after)).toEqual(commercial(before));
  expect(after.lineTotal).toBe(37_035);
});

test('I7: concurrent Revision creation assigns distinct, gapless server numbers', async () => {
  const f = await fixture('assignment-concurrent-create');
  const ids = await Promise.all([
    f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 7 }),
    f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 3 }),
  ]);
  expect(new Set(ids)).toHaveLength(2);
  const rows = await f.owner.client.query(listAssignmentRevisions, { assignmentId: f.assignmentId, paginationOpts: firstPage });
  expect(rows.page.map((row) => row.revisionNumber)).toEqual([1, 2]);
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'quantity %s is rejected',
  async (quantity) => {
    const f = await fixture(`assignment-quantity-${String(quantity).replaceAll('.', '-')}`);
    await expect(f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity }))
      .rejects.toMatchObject({ data: { code: 'assignmentRevisionQuantityInvalid' } });
  },
);

test('cancelled Services and write-refusing Projects reject Assignment creation', async () => {
  const cancelled = await fixture('assignment-cancelled');
  await cancelled.owner.client.mutation(changeServiceStatus, { serviceId: cancelled.serviceId, status: 'cancelled' });
  await expect(cancelled.owner.client.mutation(createAssignment, {
    serviceId: cancelled.serviceId,
    providerId: cancelled.providerId,
    position: 20,
  })).rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });

  const frozen = await fixture('assignment-frozen');
  await frozen.owner.client.mutation(archiveProject, { projectId: frozen.projectId });
  await expect(frozen.owner.client.mutation(createAssignment, {
    serviceId: frozen.serviceId,
    providerId: frozen.providerId,
    position: 20,
  })).rejects.toMatchObject({ data: { code: 'serviceProjectReadOnly' } });
});

test('the public mutation surface is exact and repricing never edits prior commercial columns', async () => {
  const sources = import.meta.glob('../convex/assignments/mutations.ts', { query: '?raw', import: 'default', eager: true });
  const source = Object.values(sources)[0];
  expect(source).toBeDefined();
  const exports = [...(source ?? '').matchAll(/export const (\w+) = mutation/g)].map((match) => match[1]);
  expect(exports).toEqual([
    'createAssignment',
    'createAssignmentRevision',
    'acceptAssignmentRevision',
    'declineAssignmentRevision',
    'removeAssignment',
  ]);

  const f = await fixture('assignment-immutable');
  const firstId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  const before = await f.owner.client.query(getAssignmentRevision, { revisionId: firstId });
  await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  expect(commercial(await f.owner.client.query(getAssignmentRevision, { revisionId: firstId }))).toEqual(commercial(before));
});

test('accepted Revisions cannot be re-accepted; superseded and declined Revisions cannot be accepted', async () => {
  const f = await fixture('assignment-status-guards');
  const firstId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: firstId });
  await expect(f.owner.client.mutation(acceptAssignmentRevision, { revisionId: firstId }))
    .rejects.toMatchObject({ data: { code: 'assignmentRevisionNotDraft' } });

  const secondId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: secondId });
  expect(await f.owner.client.query(getAssignmentRevision, { revisionId: firstId })).toMatchObject({ status: 'superseded' });
  await expect(f.owner.client.mutation(acceptAssignmentRevision, { revisionId: firstId }))
    .rejects.toMatchObject({ data: { code: 'assignmentRevisionNotDraft' } });

  const thirdId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 5 });
  await f.owner.client.mutation(declineAssignmentRevision, { revisionId: thirdId, reason: ' no longer needed ' });
  await expect(f.owner.client.mutation(acceptAssignmentRevision, { revisionId: thirdId }))
    .rejects.toMatchObject({ data: { code: 'assignmentRevisionNotDraft' } });
});

test('concurrent acceptance atomically leaves exactly one accepted Revision and supersedes the other', async () => {
  const f = await fixture('assignment-concurrent-accept');
  const firstId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  const secondId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  await Promise.all([
    f.owner.client.mutation(acceptAssignmentRevision, { revisionId: firstId }),
    f.owner.client.mutation(acceptAssignmentRevision, { revisionId: secondId }),
  ]);
  await f.t.run(async (ctx) => {
    const accepted = await ctx.db.query('assignmentRevisions')
      .withIndex('by_assignment_status', (q) => q.eq('assignmentId', f.assignmentId).eq('status', 'accepted'))
      .collect();
    const superseded = await ctx.db.query('assignmentRevisions')
      .withIndex('by_assignment_status', (q) => q.eq('assignmentId', f.assignmentId).eq('status', 'superseded'))
      .collect();
    const assignment = await ctx.db.get(f.assignmentId);
    expect(accepted).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    expect(assignment?.currentRevisionId).toBe(accepted[0]?._id);
  });
});

test('currentRevisionId is present iff one Revision is accepted across acceptance, supersession, and decline', async () => {
  const f = await fixture('assignment-current-mirror');
  const firstId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  const secondId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: firstId });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({ currentRevisionId: firstId });
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: secondId });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({ currentRevisionId: secondId });
  expect(await f.owner.client.query(getAssignmentRevision, { revisionId: firstId })).toMatchObject({ status: 'superseded' });
  await f.owner.client.mutation(declineAssignmentRevision, { revisionId: secondId, reason: 'declined' });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).not.toHaveProperty('currentRevisionId');
  expect(await f.owner.client.query(getAssignmentRevision, { revisionId: secondId })).toMatchObject({ status: 'declined', declinedReason: 'declined' });
});

test('a corrupted currentRevisionId mirror refuses both acceptance and decline', async () => {
  const f = await fixture('assignment-corrupt-mirror');
  const acceptedId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: acceptedId });
  const draftId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { currentRevisionId: draftId }));
  await expect(f.owner.client.mutation(acceptAssignmentRevision, { revisionId: draftId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.owner.client.mutation(declineAssignmentRevision, { revisionId: acceptedId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('Service and Project lists preserve position, scope multiple rows, paginate, and use declared indexes', async () => {
  const f = await fixture('assignment-lists');
  const second = await f.owner.client.mutation(createAssignment, { serviceId: f.serviceId, providerId: f.providerId, position: 5 });
  const otherService = await insertService(f.t, f.organizationId, 'list other service');
  const other = await f.owner.client.mutation(createAssignment, { serviceId: otherService.serviceId, providerId: f.providerId, position: 1 });
  const serviceRows = await f.owner.client.query(listServiceAssignments, { serviceId: f.serviceId });
  expect(serviceRows.map((row) => [row._id, row.position])).toEqual([[second, 5], [f.assignmentId, 10]]);
  expect(serviceRows.map((row) => row._id)).not.toContain(other);

  const page1 = await f.owner.client.query(listProjectAssignments, {
    projectId: f.projectId,
    paginationOpts: { numItems: 1, cursor: null },
  });
  expect(page1.page).toHaveLength(1);
  expect(page1.isDone).toBe(false);
  const page2 = await f.owner.client.query(listProjectAssignments, {
    projectId: f.projectId,
    paginationOpts: { numItems: 1, cursor: page1.continueCursor },
  });
  expect([...page1.page, ...page2.page].map((row) => row.position)).toEqual([5, 10]);

  const revision1 = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  const revision2 = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  const revisions1 = await f.owner.client.query(listAssignmentRevisions, {
    assignmentId: f.assignmentId,
    paginationOpts: { numItems: 1, cursor: null },
  });
  const revisions2 = await f.owner.client.query(listAssignmentRevisions, {
    assignmentId: f.assignmentId,
    paginationOpts: { numItems: 1, cursor: revisions1.continueCursor },
  });
  expect([...revisions1.page, ...revisions2.page].map((row) => row._id)).toEqual([revision1, revision2]);

  const sources = import.meta.glob('../convex/assignments/model.ts', { query: '?raw', import: 'default', eager: true });
  const source = Object.values(sources)[0] ?? '';
  for (const index of ['by_service_position', 'by_project_provider_position', 'by_project_position', 'by_assignment_revision', 'by_assignment_status']) {
    expect(source).toContain(`withIndex('${index}'`);
  }
  expect(source).toContain('.take(maxAssignmentsPerService)');
});

test('Provider access is Assignment-scoped: own reads work, other Providers and other Assignments do not', async () => {
  const f = await fixture('assignment-provider-access');
  const granted = await makeGrantedProvider(f, 'assignment-provider-firm', 'Granted Firm');
  const ownId = await f.owner.client.mutation(createAssignment, { serviceId: f.serviceId, providerId: granted.providerId, position: 20 });
  await expect(granted.client.query(getAssignment, { assignmentId: ownId })).resolves.toMatchObject({ _id: ownId });
  await expect(granted.client.query(getAssignment, { assignmentId: f.assignmentId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });

  const otherGranted = await makeGrantedProvider(f, 'assignment-other-firm', 'Other Granted Firm');
  const otherId = await f.owner.client.mutation(createAssignment, { serviceId: f.serviceId, providerId: otherGranted.providerId, position: 30 });
  await expect(granted.client.query(getAssignment, { assignmentId: otherId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
  const listed = await granted.client.query(listProjectAssignments, { projectId: f.projectId, paginationOpts: firstPage });
  expect(listed.page.map((row) => row._id)).toEqual([ownId]);
  expect(await granted.client.query(listServiceAssignments, { serviceId: f.serviceId })).toMatchObject([{ _id: ownId }]);
});

test('Provider principals cannot write commercial fields on their own Assignment', async () => {
  const f = await fixture('assignment-provider-write');
  const granted = await makeGrantedProvider(f, 'assignment-writer-firm', 'Writer Firm');
  const ownId = await f.owner.client.mutation(createAssignment, { serviceId: f.serviceId, providerId: granted.providerId, position: 20 });
  await expect(granted.client.mutation(createAssignmentRevision, { ...f.revisionArgs, assignmentId: ownId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('requireAssignmentAccess delegates live grant policy and revocation takes effect on the next call', async () => {
  const f = await fixture('assignment-revocation');
  const granted = await makeGrantedProvider(f, 'assignment-revoked-firm', 'Revoked Firm');
  const ownId = await f.owner.client.mutation(createAssignment, { serviceId: f.serviceId, providerId: granted.providerId, position: 20 });
  await expect(granted.client.query(getAssignment, { assignmentId: ownId })).resolves.toMatchObject({ _id: ownId });
  await f.owner.client.mutation(revokeProviderAccessGrant, { grantId: granted.grantId });
  await expect(granted.client.query(getAssignment, { assignmentId: ownId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('dual-firm dispatchers resolve as the Assignment Provider in both directions', async () => {
  const f = await fixture('assignment-dual-firm');
  const dispatcher = await provision(f.t, 'assignment-dual-dispatcher');
  const firmAId = await dispatcher.client.mutation(createOrganization, { name: 'Firm A', slug: 'assignment-dual-a' });
  const firmBId = await dispatcher.client.mutation(createOrganization, { name: 'Firm B', slug: 'assignment-dual-b' });
  const providerAId = await f.owner.client.mutation(createProvider, { organizationId: f.organizationId, name: 'Dual Provider A' });
  const providerBId = await f.owner.client.mutation(createProvider, { organizationId: f.organizationId, name: 'Dual Provider B' });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(providerAId, { linkedOrganizationId: firmAId });
    await ctx.db.patch(providerBId, { linkedOrganizationId: firmBId });
  });
  await f.owner.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: providerAId });
  await f.owner.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: providerBId });
  const assignmentAId = await f.owner.client.mutation(createAssignment, { serviceId: f.serviceId, providerId: providerAId, position: 20 });
  const assignmentBId = await f.owner.client.mutation(createAssignment, { serviceId: f.serviceId, providerId: providerBId, position: 30 });

  async function resolvedProvider(assignmentId: Id<'assignments'>) {
    return dispatcher.client.query(async (ctx): Promise<Id<'providers'>> => {
      const { principal } = await requireAssignmentAccess(ctx, assignmentId, 'readAssignment');
      if (principal.kind !== 'provider') throw new Error('Expected provider principal');
      return principal.providerId;
    });
  }
  await expect(dispatcher.client.query(getAssignment, { assignmentId: assignmentAId })).resolves.toMatchObject({ providerId: providerAId });
  await expect(resolvedProvider(assignmentAId)).resolves.toBe(providerAId);
  await expect(dispatcher.client.query(getAssignment, { assignmentId: assignmentBId })).resolves.toMatchObject({ providerId: providerBId });
  await expect(resolvedProvider(assignmentBId)).resolves.toBe(providerBId);
});

test('Provider, Vehicle Class, and Rate Card Version reference guards include Assignment history', async () => {
  const providerFixture = await fixture('assignment-provider-delete');
  const assignedOnlyProviderId = await providerFixture.owner.client.mutation(createProvider, {
    organizationId: providerFixture.organizationId,
    name: 'Assigned Only Provider',
  });
  await providerFixture.owner.client.mutation(createAssignment, {
    serviceId: providerFixture.serviceId,
    providerId: assignedOnlyProviderId,
    position: 20,
  });
  await providerFixture.owner.client.mutation(archiveProvider, { providerId: assignedOnlyProviderId });
  await expect(providerFixture.owner.client.mutation(deleteProvider, { providerId: assignedOnlyProviderId }))
    .rejects.toMatchObject({ data: { code: 'providerDeleteBlocked' } });

  const classFixture = await fixture('assignment-class-delete');
  await classFixture.owner.client.mutation(createAssignmentRevision, classFixture.revisionArgs);
  await classFixture.t.run(async (ctx) => {
    await ctx.db.delete(classFixture.rateLineId);
  });
  await classFixture.owner.client.mutation(archiveVehicleClass, { vehicleClassId: classFixture.vehicleClassId });
  await expect(classFixture.owner.client.mutation(deleteVehicleClass, { vehicleClassId: classFixture.vehicleClassId }))
    .rejects.toMatchObject({ data: { code: 'vehicleClassDeleteBlocked' } });

  const versionFixture = await fixture('assignment-version-reference');
  expect(await versionFixture.t.run((ctx) => rateCardVersionHasAssignmentRevisions(ctx, versionFixture.rateCardVersionId))).toBe(false);
  await versionFixture.owner.client.mutation(createAssignmentRevision, versionFixture.revisionArgs);
  expect(await versionFixture.t.run((ctx) => rateCardVersionHasAssignmentRevisions(ctx, versionFixture.rateCardVersionId))).toBe(true);
});

test('removeAssignment refuses negotiation history and succeeds before history exists', async () => {
  const f = await fixture('assignment-remove');
  const removableId = await f.owner.client.mutation(createAssignment, { serviceId: f.serviceId, providerId: f.providerId, position: 20 });
  await expect(f.owner.client.mutation(removeAssignment, { assignmentId: removableId })).resolves.toBeNull();
  await expect(f.owner.client.query(getAssignment, { assignmentId: removableId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await expect(f.owner.client.mutation(removeAssignment, { assignmentId: f.assignmentId }))
    .rejects.toMatchObject({ data: { code: 'assignmentRemoveBlocked' } });
});

test('Assignment audit rows cover every transition, identify the actor, and contain no amounts', async () => {
  const f = await fixture('assignment-audit');
  const firstId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: firstId });
  const secondId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: secondId });
  await f.owner.client.mutation(declineAssignmentRevision, { revisionId: secondId, reason: 'declined' });
  const removableId = await f.owner.client.mutation(createAssignment, { serviceId: f.serviceId, providerId: f.providerId, position: 20 });
  await f.owner.client.mutation(removeAssignment, { assignmentId: removableId });

  await f.t.run(async (ctx) => {
    const audits = await ctx.db.query('auditEvents').withIndex('by_org', (q) => q.eq('organizationId', f.organizationId)).collect();
    const assignmentAudits = audits.filter((row) => row.action.startsWith('assignment'));
    expect(assignmentAudits.map((row) => row.action)).toEqual([
      'assignment.created',
      'assignmentRevision.created',
      'assignmentRevision.accepted',
      'assignmentRevision.created',
      'assignmentRevision.superseded',
      'assignmentRevision.accepted',
      'assignmentRevision.declined',
      'assignment.created',
      'assignment.removed',
    ]);
    for (const row of assignmentAudits) {
      expect(row.actorUserId).toBe(f.owner.userId);
      expect(row).not.toHaveProperty('onBehalfOfProviderId');
      expect(Object.keys(row.metadata)).not.toEqual(expect.arrayContaining(['unitAmount', 'lineTotal', 'quantity', 'currency']));
      expect(Object.keys(row.metadata).sort()).toEqual(
        row.action === 'assignment.created' || row.action === 'assignment.removed'
          ? ['position', 'providerId']
          : ['assignmentId', 'versionNumber'],
      );
    }
  });
});
