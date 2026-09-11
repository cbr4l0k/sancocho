import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProvider = api.providers.mutations.createProvider;
const getProvider = api.providers.queries.getProvider;
const listProviders = api.providers.queries.listProviders;
const grantProjectAccessToProvider = api.providers.mutations.grantProjectAccessToProvider;
const updateProvider = api.providers.mutations.updateProvider;
const archiveProvider = api.providers.mutations.archiveProvider;
const deleteProvider = api.providers.mutations.deleteProvider;
const revokeProviderOrganizationClaim = api.providers.mutations.revokeProviderOrganizationClaim;
const inviteProviderOrganization = api.providers.mutations.inviteProviderOrganization;
const createVehicleClass = api.vehicles.mutations.createVehicleClass;
const createRateCard = api.rateCards.mutations.createRateCard;
const createInitialDraftVersion = api.rateCards.mutations.createInitialDraftVersion;
const addRateLine = api.rateCards.mutations.addRateLine;
const publishRateCardVersion = api.rateCards.mutations.publishRateCardVersion;
const createAssignment = api.assignments.mutations.createAssignment;
const createAssignmentRevision = api.assignments.mutations.createAssignmentRevision;
const acceptAssignmentRevision = api.assignments.mutations.acceptAssignmentRevision;
const counterAssignmentRevision = api.assignments.mutations.counterAssignmentRevision;
const declineAssignmentRevision = api.assignments.mutations.declineAssignmentRevision;
const recordAssignmentAdjustments = api.assignments.mutations.recordAssignmentAdjustments;
const recordAssignmentCheckpoint = api.assignments.mutations.recordAssignmentCheckpoint;
const removeAssignment = api.assignments.mutations.removeAssignment;
const getAssignmentRevision = api.assignments.queries.getAssignmentRevision;
const listAssignmentCheckpoints = api.assignments.queries.listAssignmentCheckpoints;

const inaccessible = 'notFoundOrInaccessible';

/**
 * Checkpoint timestamps must fall within a year of now, so tests offset from a
 * fixed recent base rather than using epoch-adjacent literals. The offsets keep
 * the relative ordering the pagination assertions depend on.
 */
const checkpointBase = Date.now() - 60_000;
function checkpointAt(offsetMs: number): number {
  return checkpointBase + offsetMs;
}
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
    const projectId = await ctx.db.insert('projects', {
      organizationId,
      name: `${name} project`,
      status: 'active',
    });
    const eventId = await ctx.db.insert('events', {
      organizationId,
      projectId,
      name: `${name} event`,
      status: 'active',
      startsAt: 0,
    });
    const serviceKindId = await ctx.db.insert('serviceKinds', {
      organizationId,
      key: `${name}Kind`,
      name: `${name} kind`,
      status: 'active',
    });
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

async function fixture(subject: string) {
  const t = convexTest(schema, modules);
  const coordinator = await provision(t, `${subject}-coordinator`);
  const organizationId = await coordinator.client.mutation(createOrganization, {
    name: `${subject} coordinator`,
    slug: `${subject}-coordinator`,
  });
  const { projectId, serviceId } = await insertService(t, organizationId, `${subject} service`);

  const providerFirm = await provision(t, `${subject}-provider`);
  const providerOrganizationId = await providerFirm.client.mutation(createOrganization, {
    name: `${subject} provider`,
    slug: `${subject}-provider`,
  });
  const providerId = await coordinator.client.mutation(createProvider, {
    organizationId,
    name: `${subject} Transport`,
    legalName: `${subject} Transport SAS`,
    taxId: 'private-tax-id',
    contactName: 'Dispatch',
    contactEmail: 'dispatch@example.com',
    contactPhone: '+57 300 555 0101',
    notes: 'Coordinator-private assessment',
  });
  await t.run(async (ctx) => ctx.db.patch(providerId, { linkedOrganizationId: providerOrganizationId }));
  await coordinator.client.mutation(grantProjectAccessToProvider, { projectId, providerId });

  const vehicleClassId = await coordinator.client.mutation(createVehicleClass, {
    organizationId,
    key: 'coachClass',
    name: `${subject} coach`,
  });
  const rateCardId = await coordinator.client.mutation(createRateCard, {
    organizationId,
    providerId,
    name: `${subject} card`,
  });
  const rateCardVersionId = await coordinator.client.mutation(createInitialDraftVersion, {
    rateCardId,
    currency: 'COP',
  });
  const dispositionLineId = await coordinator.client.mutation(addRateLine, {
    rateCardVersionId,
    vehicleClassId,
    modality: 'disposition',
    unitAmount: 100_000,
  });
  const fixedLineId = await coordinator.client.mutation(addRateLine, {
    rateCardVersionId,
    vehicleClassId,
    modality: 'fixed',
    unitAmount: 75_000,
  });
  await coordinator.client.mutation(publishRateCardVersion, { rateCardVersionId });
  const assignmentId = await coordinator.client.mutation(createAssignment, {
    serviceId,
    providerId,
    position: 1,
  });
  const revisionArgs = {
    assignmentId,
    vehicleClassId,
    modality: 'disposition' as const,
    quantity: 1,
    rateCardVersionId,
    rateLineId: dispositionLineId,
  };
  return {
    t,
    coordinator,
    providerFirm,
    organizationId,
    providerOrganizationId,
    providerId,
    projectId,
    serviceId,
    vehicleClassId,
    rateCardVersionId,
    dispositionLineId,
    fixedLineId,
    assignmentId,
    revisionArgs,
  };
}

function commercial(revision: Doc<'assignmentRevisions'>) {
  return {
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

test('a Provider cannot accept its own counter, while the coordinator can and supersedes the previous agreement', async () => {
  const f = await fixture('provider-counter-accept');
  const originalId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.providerFirm.client.mutation(acceptAssignmentRevision, { revisionId: originalId });

  const offerId = await f.coordinator.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    quantity: 2,
  });
  const counterId = await f.providerFirm.client.mutation(counterAssignmentRevision, {
    revisionId: offerId,
    quantity: 3,
    modality: 'fixed',
  });
  await expect(f.providerFirm.client.mutation(acceptAssignmentRevision, { revisionId: counterId }))
    .rejects.toMatchObject({ data: { code: 'assignmentRevisionProviderAcceptanceForbidden' } });

  await expect(f.coordinator.client.mutation(acceptAssignmentRevision, { revisionId: counterId }))
    .resolves.toBeNull();
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(originalId)).toMatchObject({ status: 'superseded' });
    expect(await ctx.db.get(counterId)).toMatchObject({ status: 'accepted' });
    expect(await ctx.db.get(f.assignmentId)).toMatchObject({ currentRevisionId: counterId });
  });
});

test('Provider acceptance and later Provider writes never edit accepted commercial columns or adjustments', async () => {
  const f = await fixture('provider-immutable');
  const acceptedId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.providerFirm.client.mutation(acceptAssignmentRevision, { revisionId: acceptedId });
  const before = await f.t.run(async (ctx) => {
    const revision = await ctx.db.get(acceptedId);
    if (revision === null) throw new Error('Expected accepted revision');
    return commercial(revision);
  });

  await f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
    assignmentId: f.assignmentId,
    kind: 'arrivedAtOrigin',
    occurredAt: checkpointAt(10),
  });
  await expect(f.providerFirm.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    notExecutedAmount: 1,
    additionalCharges: 1,
    additionalDetail: 'attempt',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.providerFirm.client.mutation(createAssignmentRevision, f.revisionArgs))
    .rejects.toMatchObject({ data: { code: inaccessible } });

  await f.t.run(async (ctx) => {
    const revision = await ctx.db.get(acceptedId);
    const assignment = await ctx.db.get(f.assignmentId);
    if (revision === null) throw new Error('Expected accepted revision');
    expect(commercial(revision)).toEqual(before);
    expect(assignment).toMatchObject({ currentRevisionId: acceptedId });
    expect(assignment?.notExecutedAmount).toBeUndefined();
    expect(assignment?.additionalCharges).toBeUndefined();
    expect(assignment?.additionalDetail).toBeUndefined();
  });
});

/**
 * `convex-test` serializes mutations, so `Promise.all` here does NOT exercise
 * Convex's OCC — this assertion would hold even against a broken numbering
 * scheme, and it is recorded as a partial pin rather than a proof. What makes
 * the real thing correct is that `nextAssignmentRevisionNumber` reads the
 * descending tail of `by_assignment_revision` INSIDE the mutation, so a
 * concurrent insert at `latest + 1` lands inside the recorded read interval and
 * forces a retry. The test below still pins that the number is server-assigned
 * from that read and never influenced by caller input.
 */
test('two concurrent Provider counters receive distinct, gapless server numbers', async () => {
  const f = await fixture('provider-concurrent-counter');
  const offerId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  const counterIds = await Promise.all([
    f.providerFirm.client.mutation(counterAssignmentRevision, {
      revisionId: offerId,
      quantity: 2,
      modality: 'fixed',
    }),
    f.providerFirm.client.mutation(counterAssignmentRevision, {
      revisionId: offerId,
      quantity: 3,
      modality: 'fixed',
    }),
  ]);
  const rows = await f.t.run(async (ctx) => Promise.all(counterIds.map((id) => ctx.db.get(id))));
  expect(rows.map((row) => row?.revisionNumber).sort()).toEqual([2, 3]);
  expect(await f.t.run(async (ctx) => ctx.db.get(offerId))).toMatchObject({ status: 'draft' });
});

/**
 * An ABSENT reason is now refused by the argument validator itself, so it cannot
 * be expressed here at all — the generated client type requires the field. What
 * this test covers is the half the validator cannot: a reason that is present
 * but says nothing. Both arms answer the same way.
 */
test('declining with a blank reason is refused for both Provider and coordinator arms', async () => {
  const f = await fixture('provider-decline-reason');
  const providerDeclineId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  await expect(f.providerFirm.client.mutation(declineAssignmentRevision, {
    revisionId: providerDeclineId,
    reason: '',
  })).rejects.toMatchObject({ data: { code: 'assignmentDeclinedReasonRequired' } });

  await expect(f.providerFirm.client.mutation(declineAssignmentRevision, {
    revisionId: providerDeclineId,
    reason: '   \n  ',
  })).rejects.toMatchObject({ data: { code: 'assignmentDeclinedReasonRequired' } });

  const coordinatorDeclineId = await f.coordinator.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    quantity: 2,
  });
  await expect(f.coordinator.client.mutation(declineAssignmentRevision, {
    revisionId: coordinatorDeclineId,
    reason: '  ',
  })).rejects.toMatchObject({ data: { code: 'assignmentDeclinedReasonRequired' } });
});

test('a checkpoint outside the Provider grant is generically inaccessible', async () => {
  const f = await fixture('provider-checkpoint-scope');
  const outside = await insertService(f.t, f.organizationId, 'outside grant');
  const outsideAssignmentId = await f.coordinator.client.mutation(createAssignment, {
    serviceId: outside.serviceId,
    providerId: f.providerId,
    position: 1,
  });
  await expect(f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
    assignmentId: outsideAssignmentId,
    kind: 'arrivedAtOrigin',
    occurredAt: checkpointAt(10),
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('writeExecution does not imply respondToTerms, and respondToTerms opens no direct commercial patch', async () => {
  const f = await fixture('provider-capability-separation');
  const operator = await provision(f.t, 'provider-capability-operator');
  await f.coordinator.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: operator.userId,
    role: 'operator',
  });
  const offerId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  await expect(operator.client.mutation(recordAssignmentCheckpoint, {
    assignmentId: f.assignmentId,
    kind: 'arrivedAtOrigin',
    occurredAt: checkpointAt(10),
  })).resolves.toBeDefined();
  await expect(operator.client.mutation(acceptAssignmentRevision, { revisionId: offerId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });

  await expect(f.providerFirm.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    additionalCharges: 50_000,
  })).rejects.toMatchObject({ data: { code: inaccessible } });

  const sources = import.meta.glob('../convex/assignments/model.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const source = Object.values(sources)[0] ?? '';
  expect(source).toMatch(/recordAssignmentCheckpoint[\s\S]*?'writeExecution'/);
  expect(source).toMatch(/counterAssignmentRevision[\s\S]*?'respondToTerms'/);
  expect(source).toMatch(/recordAssignmentAdjustments[\s\S]*?'writeAssignmentTerms'/);
});

test('a counter derives its card, line and class from the answered revision and exposes no card argument', async () => {
  const f = await fixture('provider-counter-derived-rate');
  const offerId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  const counterId = await f.providerFirm.client.mutation(counterAssignmentRevision, {
    revisionId: offerId,
    quantity: 2,
    modality: 'fixed',
  });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(counterId)).toMatchObject({
      rateCardVersionId: f.rateCardVersionId,
      rateLineId: f.fixedLineId,
      vehicleClassId: f.vehicleClassId,
    });
  });

  const sources = import.meta.glob('../convex/assignments/mutations.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const source = Object.values(sources)[0] ?? '';
  const counterContract = source.slice(
    source.indexOf('export const counterAssignmentRevision'),
    source.indexOf('export const declineAssignmentRevision'),
  );
  expect(counterContract).toContain("revisionId: v.id('assignmentRevisions')");
  expect(counterContract).toContain('quantity: v.number()');
  expect(counterContract).toContain('modality: rateModalityValidator');
  expect(counterContract).not.toContain('rateCardVersionId');
  expect(counterContract).not.toContain('rateLineId');
  expect(counterContract).not.toContain('vehicleClassId');
});

test('checkpoint reads are paginated, indexed, and confined to one Assignment', async () => {
  const f = await fixture('provider-checkpoint-list');
  const otherAssignmentId = await f.coordinator.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 2,
  });
  for (const offset of [10, 20, 30]) {
    await f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
      assignmentId: f.assignmentId,
      kind: 'arrivedAtOrigin',
      occurredAt: checkpointAt(offset),
    });
  }
  await f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
    assignmentId: otherAssignmentId,
    kind: 'departedOrigin',
    occurredAt: checkpointAt(40),
  });

  const page = await f.providerFirm.client.query(listAssignmentCheckpoints, {
    assignmentId: f.assignmentId,
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(page.page.map((row) => row.occurredAt)).toEqual([checkpointAt(30), checkpointAt(20)]);
  expect(page.isDone).toBe(false);
  const continuation = await f.providerFirm.client.query(listAssignmentCheckpoints, {
    assignmentId: f.assignmentId,
    paginationOpts: { numItems: 2, cursor: page.continueCursor },
  });
  expect(continuation.page.map((row) => row.occurredAt)).toEqual([checkpointAt(10)]);
  expect(continuation.isDone).toBe(true);
  expect([...page.page, ...continuation.page].every((row) => row.assignmentId === f.assignmentId)).toBe(true);

  const sources = import.meta.glob('../convex/assignments/model.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const source = Object.values(sources)[0] ?? '';
  expect(source).toMatch(/listAssignmentCheckpoints[\s\S]*?withIndex\('by_assignment_occurredAt'/);
  expect(source).toMatch(/listAssignmentCheckpoints[\s\S]*?\.paginate\(args\.paginationOpts\)/);
});

test('a Provider reads only its own shaped directory row and cannot browse the catalogue', async () => {
  const f = await fixture('provider-self-row');
  const view = await f.providerFirm.client.query(getProvider, { providerId: f.providerId });
  expect(view).toMatchObject({
    _id: f.providerId,
    name: 'provider-self-row Transport',
    legalName: 'provider-self-row Transport SAS',
    contactName: 'Dispatch',
    claimState: 'claimed',
  });
  for (const forbidden of ['notes', 'taxId', 'searchText', 'linkedOrganizationId']) {
    expect(Object.hasOwn(view, forbidden)).toBe(false);
  }
  await expect(f.providerFirm.client.query(listProviders, {
    organizationId: f.organizationId,
    paginationOpts: firstPage,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('the Provider cannot reach coordinator proposal or adjustment actions at all', async () => {
  const f = await fixture('provider-member-only-actions');
  await expect(f.providerFirm.client.mutation(createAssignmentRevision, f.revisionArgs))
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.providerFirm.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    additionalCharges: 1,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

/**
 * The counterparty must never be able to walk the agreement BACKWARDS.
 *
 * Several drafts may legitimately be open at once — a coordinator offering
 * alternatives — and acceptance does not close the ones it did not choose. That
 * left every lower-numbered draft standing as a live re-entry point: once the
 * Provider arm could accept at all (#88), it could reach back for an abandoned
 * coordinator offer long after a corrected one was agreed and re-price the
 * Assignment at a figure the coordinator had already replaced. Nothing stored
 * was mutated, so I10's letter survived while its purpose did not.
 */
test('a Provider cannot accept a draft older than the current agreement', async () => {
  const f = await fixture('provider-rewind');
  const expensiveId = await f.coordinator.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    quantity: 10,
  });
  const correctedId = await f.coordinator.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    quantity: 1,
  });
  await f.providerFirm.client.mutation(acceptAssignmentRevision, { revisionId: correctedId });

  await expect(
    f.providerFirm.client.mutation(acceptAssignmentRevision, { revisionId: expensiveId }),
  ).rejects.toMatchObject({ data: { code: 'assignmentRevisionOutdated' } });
  // The coordinator is refused identically: this is a lifecycle rule, not an
  // authorization one, and a second rule for the owning tenant would be a way
  // back in.
  await expect(
    f.coordinator.client.mutation(acceptAssignmentRevision, { revisionId: expensiveId }),
  ).rejects.toMatchObject({ data: { code: 'assignmentRevisionOutdated' } });

  await f.t.run(async (ctx) => {
    const assignment = await ctx.db.get(f.assignmentId);
    expect(assignment?.currentRevisionId).toBe(correctedId);
    expect((await ctx.db.get(correctedId))?.status).toBe('accepted');
    expect((await ctx.db.get(expensiveId))?.status).toBe('draft');
  });
});

test('open alternatives stay acceptable until one of them is agreed', async () => {
  const f = await fixture('provider-alternatives');
  const vansId = await f.coordinator.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    quantity: 2,
  });
  const coachId = await f.coordinator.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    quantity: 5,
  });
  // Both remain live offers; proposing the second did not retire the first.
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(vansId))?.status).toBe('draft');
    expect((await ctx.db.get(coachId))?.status).toBe('draft');
  });
  // The Provider may pick the LOWER-numbered alternative while nothing is agreed.
  await expect(
    f.providerFirm.client.mutation(acceptAssignmentRevision, { revisionId: vansId }),
  ).resolves.toBeNull();
});

test('an external principal cannot append revisions or checkpoints without limit', async () => {
  const f = await fixture('provider-bounds');
  const offerId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  // Fill the revision table to its ceiling directly; the point under test is the
  // read-before-write refusal, not the cost of 200 round trips.
  await f.t.run(async (ctx) => {
    const seed = await ctx.db.get(offerId);
    if (seed === null) throw new Error('fixture revision missing');
    const { _id: _ignoredId, _creationTime: _ignoredTime, ...fields } = seed;
    for (let number = 2; number <= 200; number += 1) {
      await ctx.db.insert('assignmentRevisions', { ...fields, revisionNumber: number, status: 'declined', declinedReason: 'filler' });
    }
  });
  await expect(
    f.providerFirm.client.mutation(counterAssignmentRevision, {
      revisionId: offerId,
      quantity: 3,
      modality: 'fixed',
    }),
  ).rejects.toMatchObject({ data: { code: 'assignmentRevisionLimitReached' } });
});

test('removing an Assignment is refused while checkpoints still reference it', async () => {
  const f = await fixture('provider-checkpoint-refs');
  await f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
    assignmentId: f.assignmentId,
    kind: 'arrivedAtOrigin',
    occurredAt: Date.now(),
  });
  // No revisions exist, so the pre-#88 guard would have allowed the delete and
  // stranded the checkpoint behind an id no read can resolve.
  await expect(
    f.coordinator.client.mutation(removeAssignment, { assignmentId: f.assignmentId }),
  ).rejects.toMatchObject({ data: { code: 'assignmentRemoveBlocked' } });
});

/**
 * MAY-see #1 is a READ. `requireProviderAccess` admits the Provider arm only
 * when no `minimumRole` is supplied, and every write on a directory row supplies
 * one — but nothing tested that, so widening the condition by one clause handed
 * a granted firm the power to rename itself, rewrite the coordinator's private
 * `notes` and `taxId`, archive itself, delete itself, and drive the claim
 * lifecycle, all while the audit row recorded it as a legitimate actor.
 */
test('a Provider can read its own directory row but reach no write on it', async () => {
  const f = await fixture('provider-row-writes');
  await expect(
    f.providerFirm.client.query(getProvider, { providerId: f.providerId }),
  ).resolves.toMatchObject({ _id: f.providerId });

  const refused = [
    () => f.providerFirm.client.mutation(updateProvider, { providerId: f.providerId, name: 'Renamed by the firm' }),
    () => f.providerFirm.client.mutation(updateProvider, { providerId: f.providerId, notes: 'overwritten' }),
    () => f.providerFirm.client.mutation(archiveProvider, { providerId: f.providerId }),
    () => f.providerFirm.client.mutation(deleteProvider, { providerId: f.providerId }),
    () => f.providerFirm.client.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId }),
    () => f.providerFirm.client.mutation(inviteProviderOrganization, {
      providerId: f.providerId,
      email: 'someone@example.com',
    }),
  ];
  for (const call of refused) {
    await expect(call()).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  await f.t.run(async (ctx) => {
    const stored = await ctx.db.get(f.providerId);
    expect(stored).toMatchObject({ name: 'provider-row-writes Transport', status: 'active' });
  });
});

/**
 * The row gate answers a different question from the Project gate — no Project
 * in hand — but it must reach its verdict through the SAME predicate. A source
 * grep cannot prove that: the identifier survives in a comment when the call is
 * gone, which is exactly how this passed before. These are behavioural.
 */
test('the Provider directory read dies with the claim, the archival, and the relink', async () => {
  const claimRevoked = await fixture('provider-row-claim');
  await claimRevoked.coordinator.client.mutation(revokeProviderOrganizationClaim, {
    providerId: claimRevoked.providerId,
  });
  await expect(
    claimRevoked.providerFirm.client.query(getProvider, { providerId: claimRevoked.providerId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  const archived = await fixture('provider-row-archived');
  await archived.coordinator.client.mutation(archiveProvider, { providerId: archived.providerId });
  await expect(
    archived.providerFirm.client.query(getProvider, { providerId: archived.providerId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  const relinked = await fixture('provider-row-relinked');
  const successorId = await relinked.t.run((ctx) =>
    ctx.db.insert('organizations', { name: 'Successor', slug: 'provider-row-successor' }),
  );
  await relinked.t.run(async (ctx) => {
    await ctx.db.patch(relinked.providerId, { linkedOrganizationId: successorId });
  });
  await expect(
    relinked.providerFirm.client.query(getProvider, { providerId: relinked.providerId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
});

/**
 * The `anyArm*` return validators are unions whose WIDE member accepts a
 * narrowed row, so a shaping regression validates cleanly. Absent-key assertions
 * are the only enforcement these projections have — the directory-row test
 * already does this; revisions and checkpoints did not.
 */
test('Provider-arm revisions and checkpoints carry no coordinator-side identifiers', async () => {
  const f = await fixture('provider-shaping');
  const offerId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.providerFirm.client.mutation(acceptAssignmentRevision, { revisionId: offerId });
  await f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
    assignmentId: f.assignmentId,
    kind: 'arrivedAtOrigin',
    occurredAt: checkpointAt(5),
  });

  const revision = await f.providerFirm.client.query(getAssignmentRevision, { revisionId: offerId });
  for (const forbidden of ['rateCardVersionId', 'rateLineId', 'acceptedByUserId', 'proposedByUserId', 'proposedOnBehalfOfProviderId']) {
    expect(Object.hasOwn(revision, forbidden)).toBe(false);
  }

  const checkpoints = await f.providerFirm.client.query(listAssignmentCheckpoints, {
    assignmentId: f.assignmentId,
    paginationOpts: firstPage,
  });
  expect(checkpoints.page).toHaveLength(1);
  for (const row of checkpoints.page) {
    expect(Object.hasOwn(row, 'actorUserId')).toBe(false);
  }
  // The coordinator still sees both dimensions on the same rows.
  const memberCheckpoints = await f.coordinator.client.query(listAssignmentCheckpoints, {
    assignmentId: f.assignmentId,
    paginationOpts: firstPage,
  });
  expect(memberCheckpoints.page[0]).toMatchObject({ actorUserId: f.providerFirm.userId });
});

test('countering is refused for the coordinator arm and for any non-draft revision', async () => {
  const f = await fixture('provider-counter-guards');
  const offerId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  // The member arm holds `respondToTerms` by role, so only the explicit
  // provider-only refusal keeps this second write path out of its reach.
  await expect(
    f.coordinator.client.mutation(counterAssignmentRevision, { revisionId: offerId, quantity: 3, modality: 'fixed' }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  await f.providerFirm.client.mutation(acceptAssignmentRevision, { revisionId: offerId });
  // An accepted revision must not be counterable: the new row would be numbered
  // ABOVE the agreement and so would slip past the outdated-revision rule.
  await expect(
    f.providerFirm.client.mutation(counterAssignmentRevision, { revisionId: offerId, quantity: 4, modality: 'fixed' }),
  ).rejects.toMatchObject({ data: { code: 'assignmentRevisionNotDraft' } });

  const declinedId = await f.coordinator.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 2 });
  await f.providerFirm.client.mutation(declineAssignmentRevision, { revisionId: declinedId, reason: 'too few' });
  await expect(
    f.providerFirm.client.mutation(counterAssignmentRevision, { revisionId: declinedId, quantity: 5, modality: 'fixed' }),
  ).rejects.toMatchObject({ data: { code: 'assignmentRevisionNotDraft' } });
});

test('a counter refuses an invalid quantity and an archived vehicle class', async () => {
  const f = await fixture('provider-counter-usability');
  const offerId = await f.coordinator.client.mutation(createAssignmentRevision, f.revisionArgs);
  await expect(
    f.providerFirm.client.mutation(counterAssignmentRevision, { revisionId: offerId, quantity: 0, modality: 'fixed' }),
  ).rejects.toMatchObject({ data: { code: 'assignmentRevisionQuantityInvalid' } });

  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.vehicleClassId, { status: 'archived' });
  });
  await expect(
    f.providerFirm.client.mutation(counterAssignmentRevision, { revisionId: offerId, quantity: 3, modality: 'fixed' }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('checkpoints answer to the Project freeze, their own ceiling, and their timestamp bounds', async () => {
  const f = await fixture('provider-checkpoint-guards');
  const validAt = checkpointAt(1);
  const year = 365 * 24 * 60 * 60 * 1000;
  // A fractional stamp INSIDE the window is the only case the integer check
  // catches alone — every out-of-window value is refused by the window check
  // with the same code, so testing only those leaves the integer check unpinned.
  for (const occurredAt of [-1, 1.5, checkpointAt(7) + 0.5, Date.now() + year * 2, Date.now() - year * 2]) {
    await expect(
      f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
        assignmentId: f.assignmentId,
        kind: 'arrivedAtOrigin',
        occurredAt,
      }),
    ).rejects.toMatchObject({ data: { code: 'assignmentCheckpointOccurredAtInvalid' } });
  }
  await expect(
    f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
      assignmentId: f.assignmentId,
      kind: 'arrivedAtOrigin',
      occurredAt: validAt,
      note: 'x'.repeat(2001),
    }),
  ).rejects.toMatchObject({ data: { code: 'assignmentCheckpointNoteTooLong' } });

  // The ceiling half of "cannot append without limit" — the revision half is
  // covered above, and this test previously claimed both while asserting one.
  await f.t.run(async (ctx) => {
    for (let index = 0; index < 500; index += 1) {
      await ctx.db.insert('assignmentCheckpoints', {
        assignmentId: f.assignmentId,
        organizationId: f.organizationId,
        kind: 'arrivedAtOrigin',
        occurredAt: validAt + index,
        actorUserId: f.coordinator.userId,
      });
    }
  });
  await expect(
    f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
      assignmentId: f.assignmentId,
      kind: 'departedOrigin',
      occurredAt: validAt,
    }),
  ).rejects.toMatchObject({ data: { code: 'assignmentCheckpointLimitReached' } });

  const frozen = await fixture('provider-checkpoint-frozen');
  await frozen.t.run(async (ctx) => {
    await ctx.db.patch(frozen.projectId, { status: 'archived' });
  });
  await expect(
    frozen.providerFirm.client.mutation(recordAssignmentCheckpoint, {
      assignmentId: frozen.assignmentId,
      kind: 'arrivedAtOrigin',
      occurredAt: checkpointAt(2),
    }),
  ).rejects.toBeTruthy();
});

test('a checkpoint audit row names both actor dimensions and never carries the note', async () => {
  const f = await fixture('provider-checkpoint-audit');
  await f.providerFirm.client.mutation(recordAssignmentCheckpoint, {
    assignmentId: f.assignmentId,
    kind: 'arrivedAtOrigin',
    occurredAt: checkpointAt(3),
    note: 'Driver reports the gate code is 4417',
  });
  await f.t.run(async (ctx) => {
    const rows = await ctx.db.query('auditEvents').collect();
    const recorded = rows.filter((row) => row.action === 'assignmentCheckpoint.recorded');
    expect(recorded).toHaveLength(1);
    const [event] = recorded;
    expect(event).toMatchObject({
      actorUserId: f.providerFirm.userId,
      onBehalfOfProviderId: f.providerId,
    });
    // Free tenant text — potentially a phone number or a gate code — never
    // enters the audit log, whatever allowlisted key it might be squeezed into.
    expect(JSON.stringify(event?.metadata ?? {})).not.toContain('4417');
    expect(JSON.stringify(event?.metadata ?? {})).not.toContain('gate code');
  });
});

/**
 * The mirror of `providerAccess.test.ts > provider resolution checks every
 * caller membership when only the second organization holds the grant`, for the
 * row gate — which walks memberships itself and so needs its own proof.
 *
 * The ORDER is the whole test. `by_user` returns memberships in creation order,
 * so the dispatcher joins an unrelated Organization FIRST and the provider firm
 * second; a gate that consults only the first membership finds no grant and
 * refuses. Written the other way round the assertion passes either way.
 */
test('the Provider directory read checks every membership, not only the first', async () => {
  const f = await fixture('provider-row-memberships');
  const dispatcher = await provision(f.t, 'provider-row-dispatcher');
  await dispatcher.client.mutation(createOrganization, {
    name: 'Unrelated firm',
    slug: 'provider-row-unrelated',
  });
  await f.providerFirm.client.mutation(addMember, {
    organizationId: f.providerOrganizationId,
    userId: dispatcher.userId,
    role: 'viewer',
  });
  await f.t.run(async (ctx) => {
    const memberships = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_user', (q) => q.eq('userId', dispatcher.userId))
      .collect();
    expect(memberships.map((m) => m.organizationId)[0]).not.toBe(f.providerOrganizationId);
  });
  await expect(
    dispatcher.client.query(getProvider, { providerId: f.providerId }),
  ).resolves.toMatchObject({ _id: f.providerId });
});
