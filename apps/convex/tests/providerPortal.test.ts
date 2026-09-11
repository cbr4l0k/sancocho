import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import type {
  SemanticType,
  fieldConfigValidator,
  serviceFieldValueValidator,
} from '../convex/validators';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const updateFieldDefinition = api.fields.mutations.updateFieldDefinition;
const revokeProviderAccessGrant = api.providers.mutations.revokeProviderAccessGrant;
const getAssignmentDetail = api.assignments.queries.getAssignmentDetail;
const archiveProvider = api.providers.mutations.archiveProvider;
const addMember = api.organizations.mutations.addMember;
const getAssignmentRevision = api.assignments.queries.getAssignmentRevision;
const listAssignmentRevisions = api.assignments.queries.listAssignmentRevisions;
const listMyProviderEngagements = api.providers.queries.listMyProviderEngagements;
const getRateCard = api.rateCards.queries.getRateCard;
const listRateCards = api.rateCards.queries.listRateCards;
const getRateCardVersion = api.rateCards.queries.getRateCardVersion;
const listRateCardVersions = api.rateCards.queries.listRateCardVersions;
const resolveRate = api.rateCards.queries.resolveRate;

const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 50, cursor: null };
const inaccessible = { data: { code: 'notFoundOrInaccessible' } };

type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;
type FieldConfig = typeof fieldConfigValidator.type;
type ServiceFieldValue = typeof serviceFieldValueValidator.type;

function identity(subject: string) {
  return {
    issuer,
    subject,
    name: subject,
    email: `${subject}@example.com`,
    emailVerified: true,
  };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId: Id<'users'> = await client.mutation(ensureUser, {});
  return { client, userId };
}

type PortalFixture = Awaited<ReturnType<typeof portalFixture>>;

async function portalFixture(subject: string) {
  const t = convexTest(schema, modules);
  const coordinator = await provision(t, `${subject}-coordinator`);
  const organizationId = await coordinator.client.mutation(createOrganization, {
    name: `${subject} coordinator`,
    slug: `${subject}-coordinator`,
  });
  const providerMember = await provision(t, `${subject}-provider`);
  const providerOrganizationId = await providerMember.client.mutation(createOrganization, {
    name: `${subject} provider`,
    slug: `${subject}-provider`,
  });

  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', {
      organizationId,
      name: `${subject} project`,
      status: 'active',
    });
    const eventId = await ctx.db.insert('events', {
      organizationId,
      projectId,
      name: `${subject} event`,
      status: 'active',
      startsAt: 0,
    });
    const serviceKindId = await ctx.db.insert('serviceKinds', {
      organizationId,
      key: `${subject}Kind`,
      name: `${subject} kind`,
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
      name: `${subject} target service`,
      status: 'draft',
      startsAt: 1,
    });
    const siblingServiceId = await ctx.db.insert('services', {
      organizationId,
      projectId,
      eventId,
      serviceKindId,
      serviceKindVersionId,
      name: `${subject} sibling service`,
      status: 'draft',
      startsAt: 2,
    });
    const providerId = await ctx.db.insert('providers', {
      organizationId,
      name: `${subject} firm`,
      searchText: `${subject} firm`,
      status: 'active',
      linkedOrganizationId: providerOrganizationId,
    });
    const grantId = await ctx.db.insert('providerAccessGrants', {
      organizationId,
      providerId,
      providerOrganizationId,
      projectId,
      status: 'active',
      grantedByUserId: coordinator.userId,
      grantedAt: 1,
    });
    const costCentreId = await ctx.db.insert('costCentres', {
      organizationId,
      key: `${subject}Cc`,
      name: `${subject} cost centre`,
      searchText: `${subject} cost centre`,
      status: 'active',
    });
    // EVERY column the Provider arm narrows away is populated here, so a read
    // that forgets to narrow returns a real value rather than `undefined` and
    // the key-set assertions below can actually see it. A fixture that leaves
    // them unset makes those assertions pass whether or not the code narrows.
    const assignmentId = await ctx.db.insert('assignments', {
      organizationId,
      serviceId,
      projectId,
      providerId,
      costCentreId,
      position: 1,
      executionStatus: 'notExecuted',
      notExecutedAmount: 250000,
      notExecutedReason: 'Cancelled at the kerb',
      additionalCharges: 75000,
      additionalDetail: 'Waiting time beyond the agreed window',
    });
    const vehicleClassId = await ctx.db.insert('vehicleClasses', {
      organizationId,
      key: `${subject}Class`,
      name: `${subject} class`,
      searchText: `${subject} class`,
      status: 'active',
    });
    const rateCardId = await ctx.db.insert('rateCards', {
      organizationId,
      providerId,
      name: `${subject} card`,
      status: 'active',
    });
    const rateCardVersionId = await ctx.db.insert('rateCardVersions', {
      organizationId,
      rateCardId,
      versionNumber: 1,
      currency: 'COP',
      status: 'published',
      publishedAt: 1,
    });
    const rateLineId = await ctx.db.insert('rateLines', {
      organizationId,
      rateCardVersionId,
      vehicleClassId,
      modality: 'transfer',
      unitAmount: 5000,
    });
    const revisionId = await ctx.db.insert('assignmentRevisions', {
      organizationId,
      assignmentId,
      revisionNumber: 1,
      status: 'accepted',
      vehicleClassId,
      modality: 'transfer',
      quantity: 2,
      rateCardVersionId,
      rateLineId,
      unitAmount: 5000,
      currency: 'COP',
      lineTotal: 10000,
      acceptedAt: 2,
      acceptedByUserId: coordinator.userId,
    });
    await ctx.db.patch(assignmentId, { currentRevisionId: revisionId });
    return {
      projectId,
      eventId,
      serviceKindId,
      serviceKindVersionId,
      serviceId,
      siblingServiceId,
      providerId,
      grantId,
      assignmentId,
      costCentreId,
      vehicleClassId,
      rateCardId,
      rateCardVersionId,
      rateLineId,
      revisionId,
    };
  });

  return {
    t,
    coordinator,
    organizationId,
    providerMember,
    providerOrganizationId,
    ...ids,
  };
}

async function insertProjectionField(
  f: PortalFixture,
  args: {
    key: string;
    label: string;
    config: FieldConfig;
    value: ServiceFieldValue;
    siblingValue?: ServiceFieldValue;
    semanticType?: SemanticType;
    visible?: boolean;
    position: number;
  },
): Promise<Id<'fieldDefinitions'>> {
  return f.t.run(async (ctx) => {
    const fieldDefinitionId = await ctx.db.insert('fieldDefinitions', {
      scope: 'organization',
      organizationId: f.organizationId,
      key: args.key,
      label: args.label,
      status: 'active',
      ...(args.semanticType === undefined ? {} : { semanticType: args.semanticType }),
      config: args.config,
    });
    const serviceKindFieldId = await ctx.db.insert('serviceKindFields', {
      organizationId: f.organizationId,
      serviceKindVersionId: f.serviceKindVersionId,
      fieldDefinitionId,
      position: args.position,
      required: false,
      visible: args.visible ?? true,
      config: args.config,
    });
    await ctx.db.insert('serviceFieldValues', {
      organizationId: f.organizationId,
      serviceId: f.serviceId,
      serviceKindFieldId,
      fieldDefinitionId,
      value: args.value,
      ...(args.value.kind === 'location' ? { locationId: args.value.locationId } : {}),
    });
    if (args.siblingValue !== undefined) {
      await ctx.db.insert('serviceFieldValues', {
        organizationId: f.organizationId,
        serviceId: f.siblingServiceId,
        serviceKindFieldId,
        fieldDefinitionId,
        value: args.siblingValue,
        ...(args.siblingValue.kind === 'location'
          ? { locationId: args.siblingValue.locationId }
          : {}),
      });
    }
    return fieldDefinitionId;
  });
}

function semanticField(semanticType: SemanticType, index: number): {
  config: FieldConfig;
  value: ServiceFieldValue;
} {
  if (semanticType === 'serviceDate') return { config: { kind: 'date' }, value: { kind: 'date', value: '2026-09-11' } };
  if (semanticType === 'serviceTime') return { config: { kind: 'time' }, value: { kind: 'time', value: '09:30' } };
  if (semanticType === 'passenger.count' || semanticType === 'luggage.count' || semanticType === 'accessibility.wheelchairCount') {
    return { config: { kind: 'number', integer: true }, value: { kind: 'number', value: index + 1 } };
  }
  if (semanticType === 'serviceDescription' || semanticType === 'general.notes') {
    return { config: { kind: 'longText' }, value: { kind: 'longText', value: `${semanticType} value` } };
  }
  return { config: { kind: 'text' }, value: { kind: 'text', value: `${semanticType} value` } };
}

test('the Service projection contains exactly the eleven code-owned semantics', async () => {
  const f = await portalFixture('portal-composition');
  const projected: SemanticType[] = [
    'serviceName',
    'serviceDate',
    'serviceTime',
    'serviceLocation',
    'transport.origin',
    'transport.destination',
    'passenger.count',
    'aviation.flightNumber',
    'aviation.terminal',
    'contact.primary',
    'general.notes',
  ];
  const excluded: SemanticType[] = [
    'serviceDescription',
    'luggage.count',
    'accessibility.wheelchairCount',
  ];
  const locationId = await f.t.run((ctx) => ctx.db.insert('locations', {
    organizationId: f.organizationId,
    name: 'Projection location',
    type: 'venue',
    status: 'active',
  }));
  for (const [index, semanticType] of [...projected, ...excluded].entries()) {
    const field = semanticType === 'serviceLocation' || semanticType === 'transport.origin' || semanticType === 'transport.destination'
      ? { config: { kind: 'location' } as const, value: { kind: 'location', locationId } as const }
      : semanticField(semanticType, index);
    await insertProjectionField(f, {
      key: `field${index}`,
      label: `label:${semanticType}`,
      semanticType,
      position: index,
      ...field,
    });
  }
  // The decoy carries NO `semanticType`, but its key spells one projected
  // semantic and its label spells another. `docs/provider-access.md` states the
  // rule as a binding negative — selection "never matches Field Definition keys,
  // never matches labels" — and a decoy named `customUnclassified` proves only
  // the weaker claim that an unsemantic field is excluded. `fieldKeyPattern`
  // admits `serviceName`, and it is not a builtin key, so a tenant can really
  // create this field: matching on either column would be a tenant widening
  // disclosure by misconfiguration.
  await insertProjectionField(f, {
    key: 'serviceName',
    label: 'general.notes',
    position: 99,
    config: { kind: 'text' },
    value: { kind: 'text', value: 'custom value' },
  });

  const detail = await f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  expect(new Set(detail.serviceProjection.map((entry) => entry.semanticType))).toEqual(new Set(projected));
  // One `not.toEqual(arrayContaining([...]))` over all four would pass as soon
  // as ANY single one were absent, so a lone leaked semantic would go unseen.
  // Each exclusion is therefore asserted on its own.
  const labels = detail.serviceProjection.map((entry) => entry.label);
  for (const excludedLabel of [
    'label:serviceDescription',
    'label:luggage.count',
    'label:accessibility.wheelchairCount',
    'general.notes',
  ]) {
    expect(labels).not.toContain(excludedLabel);
  }
  expect(labels).toHaveLength(projected.length);
  // The decoy's own value must not appear anywhere, whichever column a broken
  // selection matched on.
  expect(JSON.stringify(detail.serviceProjection)).not.toContain('custom value');
  const memberDetail = await f.coordinator.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  expect(memberDetail.serviceProjection).toEqual(detail.serviceProjection);
});

test('hidden fields with a projected semantic remain in the Provider projection', async () => {
  const f = await portalFixture('portal-hidden');
  await insertProjectionField(f, {
    key: 'hiddenName',
    label: 'Hidden service name',
    semanticType: 'serviceName',
    position: 1,
    visible: false,
    config: { kind: 'text' },
    value: { kind: 'text', value: 'Visible to provider' },
  });
  const detail = await f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  expect(detail.serviceProjection).toEqual([
    expect.objectContaining({ semanticType: 'serviceName', label: 'Hidden service name' }),
  ]);
});

test('projection labels are joined live after publication', async () => {
  const f = await portalFixture('portal-live-label');
  const fieldDefinitionId = await insertProjectionField(f, {
    key: 'liveLabel',
    label: 'Old label',
    semanticType: 'serviceName',
    position: 1,
    config: { kind: 'text' },
    value: { kind: 'text', value: 'Named movement' },
  });
  await f.coordinator.client.mutation(updateFieldDefinition, {
    fieldDefinitionId,
    label: 'New live label',
  });
  const detail = await f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  expect(detail.serviceProjection).toEqual([
    expect.objectContaining({ semanticType: 'serviceName', label: 'New live label' }),
  ]);
});

/**
 * The disclosure half of the `historicalMeaningFields` freeze.
 *
 * The projection selects on the LIVE `semanticType`, so "a tenant cannot widen
 * disclosure by misconfiguration" holds only while that column is unchangeable
 * once a published version references it. The fields-domain suite already proves
 * the refusal; this proves WHY the projection depends on it — re-pointing an
 * excluded field at a projected semantic is the attack, and it must be refused
 * rather than merely awkward.
 */
test('an excluded field cannot be re-pointed at a projected semantic to widen disclosure', async () => {
  const f = await portalFixture('portal-semantic-freeze');
  const fieldDefinitionId = await insertProjectionField(f, {
    key: 'wheelchairs',
    label: 'Wheelchair count',
    semanticType: 'accessibility.wheelchairCount',
    position: 1,
    config: { kind: 'number', integer: true },
    value: { kind: 'number', value: 3 },
  });
  const before = await f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  expect(before.serviceProjection).toEqual([]);

  await expect(
    f.coordinator.client.mutation(updateFieldDefinition, {
      fieldDefinitionId,
      semanticType: 'general.notes',
    }),
    // The exact refusal, not merely "some error": a weaker assertion would pass
    // if the mutation failed for an unrelated reason and the freeze had lapsed.
  ).rejects.toMatchObject({ data: { code: 'fieldHistoricalFrozen' } });

  const after = await f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  expect(after.serviceProjection).toEqual([]);
});

test('location values resolve only names owned by the Service organization', async () => {
  const f = await portalFixture('portal-location');
  const foreignOrganizationId = await f.coordinator.client.mutation(createOrganization, {
    name: 'Foreign location organization',
    slug: 'portal-location-foreign',
  });
  const { localLocationId, foreignLocationId } = await f.t.run(async (ctx) => ({
    localLocationId: await ctx.db.insert('locations', {
      organizationId: f.organizationId,
      name: 'Local venue',
      type: 'venue',
      status: 'active',
    }),
    foreignLocationId: await ctx.db.insert('locations', {
      organizationId: foreignOrganizationId,
      name: 'Secret foreign venue',
      type: 'venue',
      status: 'active',
    }),
  }));
  await insertProjectionField(f, {
    key: 'localLocation',
    label: 'Local location',
    semanticType: 'serviceLocation',
    position: 1,
    config: { kind: 'location' },
    value: { kind: 'location', locationId: localLocationId },
  });
  await insertProjectionField(f, {
    key: 'foreignLocation',
    label: 'Foreign location',
    semanticType: 'transport.origin',
    position: 2,
    config: { kind: 'location' },
    value: { kind: 'location', locationId: foreignLocationId },
  });
  const detail = await f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  expect(detail.serviceProjection[0]).toMatchObject({ locationName: 'Local venue' });
  expect(detail.serviceProjection[1]).not.toHaveProperty('locationName');
  expect(JSON.stringify(detail)).not.toContain('Secret foreign venue');
});

test('a granted Provider cannot read any Rate Card surface', async () => {
  const f = await portalFixture('portal-rate-cards');
  const calls = [
    f.providerMember.client.query(getRateCard, { rateCardId: f.rateCardId }),
    f.providerMember.client.query(listRateCards, { organizationId: f.organizationId, paginationOpts: firstPage }),
    f.providerMember.client.query(getRateCardVersion, { rateCardVersionId: f.rateCardVersionId }),
    f.providerMember.client.query(listRateCardVersions, { rateCardId: f.rateCardId, paginationOpts: firstPage }),
    f.providerMember.client.query(resolveRate, {
      rateCardVersionId: f.rateCardVersionId,
      providerId: f.providerId,
      vehicleClassId: f.vehicleClassId,
      modality: 'transfer',
    }),
  ];
  for (const call of calls) await expect(call).rejects.toMatchObject(inaccessible);
});

test('Provider revision reads omit coordinator Rate Card and user ids on both paths', async () => {
  const f = await portalFixture('portal-revisions');
  const providerSingle = await f.providerMember.client.query(getAssignmentRevision, { revisionId: f.revisionId });
  const providerList = await f.providerMember.client.query(listAssignmentRevisions, {
    assignmentId: f.assignmentId,
    paginationOpts: firstPage,
  });
  for (const revision of [providerSingle, ...providerList.page]) {
    expect(revision).not.toHaveProperty('rateCardVersionId');
    expect(revision).not.toHaveProperty('rateLineId');
    expect(revision).not.toHaveProperty('acceptedByUserId');
    expect(revision).toMatchObject({ unitAmount: 5000, currency: 'COP', lineTotal: 10000 });
  }
  const memberSingle = await f.coordinator.client.query(getAssignmentRevision, { revisionId: f.revisionId });
  const memberList = await f.coordinator.client.query(listAssignmentRevisions, {
    assignmentId: f.assignmentId,
    paginationOpts: firstPage,
  });
  for (const revision of [memberSingle, ...memberList.page]) {
    expect(revision).toMatchObject({
      rateCardVersionId: f.rateCardVersionId,
      rateLineId: f.rateLineId,
      acceptedByUserId: f.coordinator.userId,
    });
  }
});

test('engagement discovery returns active grants and drops one immediately on revocation', async () => {
  const f = await portalFixture('portal-engagement-lifecycle');
  const revokedGrantId = await f.t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', {
      organizationId: f.organizationId,
      name: 'Already revoked project',
      status: 'active',
    });
    return ctx.db.insert('providerAccessGrants', {
      organizationId: f.organizationId,
      providerId: f.providerId,
      providerOrganizationId: f.providerOrganizationId,
      projectId,
      status: 'revoked',
      grantedByUserId: f.coordinator.userId,
      grantedAt: 1,
      revokedAt: 2,
    });
  });
  const before = await f.providerMember.client.query(listMyProviderEngagements, {
    providerOrganizationId: f.providerOrganizationId,
    paginationOpts: firstPage,
  });
  expect(before.page.map((row) => row._id)).toEqual([f.grantId]);
  expect(before.page.map((row) => row._id)).not.toContain(revokedGrantId);

  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });
  const after = await f.providerMember.client.query(listMyProviderEngagements, {
    providerOrganizationId: f.providerOrganizationId,
    paginationOpts: firstPage,
  });
  expect(after.page).toEqual([]);
});

test('engagement discovery refuses non-members of the Provider Organization generically', async () => {
  const f = await portalFixture('portal-engagement-membership');
  const stranger = await provision(f.t, 'portal-engagement-stranger');
  await expect(stranger.client.query(listMyProviderEngagements, {
    providerOrganizationId: f.providerOrganizationId,
    paginationOpts: firstPage,
  })).rejects.toMatchObject(inaccessible);
});

test('engagement rows expose exactly ids from the grant and no Project fields', async () => {
  const f = await portalFixture('portal-engagement-shape');
  const result = await f.providerMember.client.query(listMyProviderEngagements, {
    providerOrganizationId: f.providerOrganizationId,
    paginationOpts: firstPage,
  });
  expect(Object.keys(result.page[0] ?? {}).sort()).toEqual([
    '_id',
    'organizationId',
    'projectId',
    'providerId',
  ]);
});


/**
 * The four columns `providerAssignmentView` subtracts, checked as an absent-key
 * assertion rather than a value comparison: `toMatchObject` and the `returns`
 * validator both ignore extra keys, so nothing else in the stack can see them.
 * The fixture populates all four, so a read that forgets to narrow fails here.
 */
function expectNoForbiddenProviderKeys(assignment: Record<string, unknown>): void {
  expect(
    ['costCentreId', 'notExecutedAmount', 'additionalCharges', 'additionalDetail'].filter(
      (key) => key in assignment,
    ),
  ).toEqual([]);
}

/**
 * `getAssignmentDetail` is #87's headline query and, until these landed, the only
 * Provider-facing Assignment read with no authorization test of its own. A
 * completely un-gated version of it passed all 528 tests: the sole thing standing
 * against a total tenant-isolation bypass was one incidental call inside a helper
 * written to test grant LIFECYCLE. The mechanical guard in providerAccess.test.ts
 * does not cover this either — it detects an INLINED principal check, never an
 * omitted one.
 */
test('Assignment detail refuses an unauthenticated caller before resolving the id', async () => {
  const f = await portalFixture('portal-detail-anon');
  await expect(
    f.t.query(getAssignmentDetail, { assignmentId: f.assignmentId }),
  ).rejects.toMatchObject({ data: { code: 'unauthenticated' } });
});

test('Assignment detail refuses a stranger with no principal anywhere', async () => {
  const f = await portalFixture('portal-detail-stranger');
  const stranger = await provision(f.t, 'portal-detail-outsider');
  await expect(
    stranger.client.query(getAssignmentDetail, { assignmentId: f.assignmentId }),
  ).rejects.toMatchObject(inaccessible);
});

test('a grant on another Project confers nothing on this Assignment detail (I9)', async () => {
  const f = await portalFixture('portal-detail-other-project');
  const otherProjectId = await f.t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', {
      organizationId: f.organizationId,
      name: 'Neighbouring project',
      status: 'active',
    });
    await ctx.db.insert('providerAccessGrants', {
      organizationId: f.organizationId,
      projectId,
      providerId: f.providerId,
      providerOrganizationId: f.providerOrganizationId,
      status: 'active',
      grantedByUserId: f.coordinator.userId,
      grantedAt: Date.now(),
    });
    await ctx.db.delete(f.grantId);
    return projectId;
  });
  expect(otherProjectId).not.toBe(f.projectId);
  // Probing the real-but-ungranted Assignment and probing one that never
  // existed must be indistinguishable.
  const real = f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  const fabricated = f.providerMember.client.query(getAssignmentDetail, {
    assignmentId: await f.t.run((ctx) => ctx.db.insert('assignments', {
      organizationId: f.organizationId,
      serviceId: f.serviceId,
      projectId: f.projectId,
      providerId: f.providerId,
      position: 99,
      executionStatus: 'unassigned',
    })),
  });
  await expect(real).rejects.toMatchObject(inaccessible);
  await expect(fabricated).rejects.toMatchObject(inaccessible);
});

test('the member arm reads the detail at the viewer floor, and unnarrowed', async () => {
  const f = await portalFixture('portal-detail-viewer');
  const viewer = await provision(f.t, 'portal-detail-viewer-member');
  await f.coordinator.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: viewer.userId,
    role: 'viewer',
  });
  const detail = await viewer.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  // A coordinator viewer must reach this at all — the query proves `readAssignment`,
  // whose member floor is `viewer`; raising the intent would lock them out silently.
  expect(detail.assignment).toMatchObject({ _id: f.assignmentId, costCentreId: f.costCentreId });
});


const backendSources: Record<string, string> = import.meta.glob(
  ['../convex/**/*.ts', '!../convex/_generated/**'],
  { query: '?raw', import: 'default', eager: true },
);

/**
 * A MECHANICAL pin, because the behavioural one cannot exist yet.
 *
 * `getAssignmentDetail` proves two capabilities because it returns two things
 * governed by two capabilities. The closed Provider set is total today, so
 * either proof alone would pass every behavioural test — deleting the second
 * call is an equivalent mutant right now. It stops being equivalent the day #88
 * narrows a grant, and on that day nobody would be told the proof had been
 * removed. Asserting on the source is the only witness available before the
 * divergence it guards against exists.
 */
test('the Assignment detail query proves both of the capabilities it answers for', async () => {
  const source = Object.entries(backendSources).find(([path]) =>
    path.endsWith('/assignments/model.ts'),
  )?.[1];
  expect(source).toBeDefined();
  const body = (source ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('export async function getAssignmentDetail')[1]
    ?.split('\nexport ')[0] ?? '';
  // The glob has to have found the function at all, or both assertions below
  // pass vacuously against an empty string.
  expect(body).toContain('requireAssignmentAccess');
  expect(body).toContain("'readAssignment'");
  expect(body).toContain("'readLinkedServiceProjection'");
});

/**
 * Defence in depth against inconsistent stored data: a `serviceFieldValues` row
 * whose `serviceKindFieldId` names a DIFFERENT version's row is corruption, not
 * a reinterpretation to paper over. Unreachable through any write path, which is
 * exactly why it needs a seeded test rather than none.
 */
test('a stored value pointing at another version\'s field is refused, not projected', async () => {
  const f = await portalFixture('portal-corrupt-value');
  await insertProjectionField(f, {
    key: 'movementName',
    label: 'Movement name',
    semanticType: 'serviceName',
    position: 1,
    config: { kind: 'text' },
    value: { kind: 'text', value: 'Named movement' },
  });
  await f.t.run(async (ctx) => {
    const stored = await ctx.db
      .query('serviceFieldValues')
      .withIndex('by_service_field', (q) => q.eq('serviceId', f.serviceId))
      .first();
    const foreignFieldId = await ctx.db.insert('serviceKindFields', {
      organizationId: f.organizationId,
      serviceKindVersionId: f.serviceKindVersionId,
      fieldDefinitionId: stored?.fieldDefinitionId ?? (await ctx.db.query('fieldDefinitions').first())!._id,
      position: 42,
      required: false,
      visible: true,
      config: { kind: 'text' },
    });
    await ctx.db.patch(stored!._id, { serviceKindFieldId: foreignFieldId });
  });
  await expect(
    f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId }),
  ).rejects.toMatchObject(inaccessible);
});

test('Assignment detail returns only the linked Service projection, never a sibling Service', async () => {
  const f = await portalFixture('portal-assignment-detail');
  await insertProjectionField(f, {
    key: 'movementName',
    label: 'Movement name',
    semanticType: 'serviceName',
    position: 1,
    config: { kind: 'text' },
    value: { kind: 'text', value: 'Target service value' },
    siblingValue: { kind: 'text', value: 'Sibling service secret' },
  });
  const detail = await f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId });
  expect(Object.keys(detail).sort()).toEqual(['assignment', 'serviceProjection']);
  expect(detail.assignment).toMatchObject({ _id: f.assignmentId, serviceId: f.serviceId });
  // The ASSIGNMENT half, not only the wrapper. `toMatchObject` above cannot see
  // an extra key, and the returns validator cannot either: `anyArmAssignmentDocValidator`
  // is a union whose full-document arm accepts a narrowed row, because every
  // column the Provider arm subtracts is optional. Assertions are the only
  // enforcement the Assignment half has — see the note in validators/index.ts.
  expectNoForbiddenProviderKeys(detail.assignment);
  expect(detail.serviceProjection).toEqual([
    expect.objectContaining({ semanticType: 'serviceName', value: { kind: 'text', value: 'Target service value' } }),
  ]);
  expect(JSON.stringify(detail)).not.toContain(f.siblingServiceId);
  expect(JSON.stringify(detail)).not.toContain('Sibling service secret');
});

/**
 * The portal's front door must answer to every control the gate answers to.
 *
 * `listMyProviderEngagements` originally asked for membership plus
 * `grant.status === 'active'` — two of the seven conditions `grantConfersAccess`
 * actually applies. That made it a second, weaker principal resolver living at
 * the right address: `archiveProvider` refused every gated call while this list
 * went on handing the firm the coordinator's Project ids. Each case below is one
 * of the five conditions the status column does not cover; each is asserted
 * alongside a gated read, so a fix that closes one door and not the other fails.
 */
async function expectWithdrawn(f: PortalFixture): Promise<void> {
  const engagements = await f.providerMember.client.query(listMyProviderEngagements, {
    providerOrganizationId: f.providerOrganizationId,
    paginationOpts: firstPage,
  });
  expect(engagements.page).toEqual([]);
  await expect(
    f.providerMember.client.query(getAssignmentDetail, { assignmentId: f.assignmentId }),
  ).rejects.toMatchObject(inaccessible);
}

test('archiving the Provider closes the portal front door, not only the gated reads', async () => {
  const f = await portalFixture('portal-withdrawn-archived');
  await f.coordinator.client.mutation(archiveProvider, { providerId: f.providerId });
  await expectWithdrawn(f);
});

test('revoking the Provider claim closes the front door without touching a grant row', async () => {
  const f = await portalFixture('portal-withdrawn-claim');
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.providerId, { linkedOrganizationId: undefined });
  });
  // The grant row is deliberately left `active`: `revokeAllProviderAccessGrants`
  // bounds its cascade at 256 rows on the argument that a stale active row
  // confers nothing, and this is the test that keeps that argument true.
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.grantId))?.status).toBe('active');
  });
  await expectWithdrawn(f);
});

test('a Provider re-claimed by a different firm stops appearing for the previous one', async () => {
  const f = await portalFixture('portal-withdrawn-relinked');
  const successorOrganizationId = await f.t.run((ctx) =>
    ctx.db.insert('organizations', { name: 'Successor firm', slug: 'portal-withdrawn-successor' }),
  );
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.providerId, { linkedOrganizationId: successorOrganizationId });
  });
  await expectWithdrawn(f);
});

test('a grant whose coordinator column disagrees with its Project confers nothing here either', async () => {
  const f = await portalFixture('portal-withdrawn-disagreeing');
  const foreignOrganizationId = await f.t.run((ctx) =>
    ctx.db.insert('organizations', { name: 'Foreign coordinator', slug: 'portal-withdrawn-foreign' }),
  );
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.grantId, { organizationId: foreignOrganizationId });
  });
  const engagements = await f.providerMember.client.query(listMyProviderEngagements, {
    providerOrganizationId: f.providerOrganizationId,
    paginationOpts: firstPage,
  });
  expect(engagements.page).toEqual([]);
});
