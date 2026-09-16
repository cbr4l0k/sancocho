import { convexTest } from 'convex-test';
import type { PaginationResult } from 'convex/server';
import { expect, test, vi } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import {
  requireAssignmentAccess,
  type ProviderDispatchAssignmentEntry,
} from '../convex/assignments/model';
import { maxRateCardsPerRateLookup } from '../convex/assignments/rateLookup';
import * as rateCardModel from '../convex/rateCards/model';
import { rateCardVersionHasAssignmentRevisions } from '../convex/rateCards/references';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createCostCentre = api.costCentres.mutations.createCostCentre;
const archiveCostCentre = api.costCentres.mutations.archiveCostCentre;
const deleteCostCentre = api.costCentres.mutations.deleteCostCentre;
const updateEvent = api.events.mutations.updateEvent;
const createProvider = api.providers.mutations.createProvider;
const archiveProvider = api.providers.mutations.archiveProvider;
const deleteProvider = api.providers.mutations.deleteProvider;
const grantProjectAccessToProvider = api.providers.mutations.grantProjectAccessToProvider;
const revokeProviderAccessGrant = api.providers.mutations.revokeProviderAccessGrant;
const createVehicleClass = api.vehicles.mutations.createVehicleClass;
const createFleetVehicle = api.vehicles.mutations.createFleetVehicle;
const archiveFleetVehicle = api.vehicles.mutations.archiveFleetVehicle;
const deleteFleetVehicle = api.vehicles.mutations.deleteFleetVehicle;
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
const listOrganizationAuditEvents = api.audit.queries.listOrganizationAuditEvents;
const listEntityAuditEvents = api.audit.queries.listEntityAuditEvents;

const createAssignment = api.assignments.mutations.createAssignment;
const createAssignmentRevision = api.assignments.mutations.createAssignmentRevision;
const acceptAssignmentRevision = api.assignments.mutations.acceptAssignmentRevision;
const declineAssignmentRevision = api.assignments.mutations.declineAssignmentRevision;
const removeAssignment = api.assignments.mutations.removeAssignment;
const transitionAssignmentExecution = api.assignments.mutations.transitionAssignmentExecution;
const recordAssignmentAdjustments = api.assignments.mutations.recordAssignmentAdjustments;
const getAssignment = api.assignments.queries.getAssignment;
const getAssignmentRevision = api.assignments.queries.getAssignmentRevision;
const listAssignmentRevisions = api.assignments.queries.listAssignmentRevisions;
const listServiceAssignments = api.assignments.queries.listServiceAssignments;
const listServiceAssignmentRows = api.assignments.queries.listServiceAssignmentRows;
const resolveAssignmentRate = api.assignments.queries.resolveAssignmentRate;
const listProjectAssignments = api.assignments.queries.listProjectAssignments;
const assignmentsAwaitingDispatch = api.assignments.queries.assignmentsAwaitingDispatch;
const listDispatchDay = api.assignments.queries.listDispatchDay;
const listProviderDispatchDay = api.assignments.queries.listProviderDispatchDay;
const dispatchDayReadiness = api.assignments.queries.dispatchDayReadiness;

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
): Promise<{ projectId: Id<'projects'>; eventId: Id<'events'>; serviceId: Id<'services'> }> {
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
    return { projectId, eventId, serviceId };
  });
}

async function fixture(subject = 'assignments', currency: 'COP' | 'USD' = 'COP') {
  const t = convexTest(schema, modules);
  const owner = await provision(t, `${subject}-owner`);
  const organizationId = await owner.client.mutation(createOrganization, {
    name: `${subject} organization`,
    slug: 'assignment-fixture',
  });
  const { projectId, eventId, serviceId } = await insertService(t, organizationId, `${subject} service`);
  const providerId = await owner.client.mutation(createProvider, { organizationId, name: `${subject} Provider` });
  const vehicleClassId = await owner.client.mutation(createVehicleClass, {
    organizationId,
    key: 'assignmentClass',
    name: `${subject} Class`,
  });
  const rateCardId = await owner.client.mutation(createRateCard, { organizationId, providerId, name: `${subject} Card` });
  const rateCardVersionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency });
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
    eventId,
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

async function insertFixtureService(
  f: Awaited<ReturnType<typeof fixture>>,
  args: {
    name: string;
    startsAt: number;
    endsAt?: number;
    eventId?: Id<'events'>;
    status?: Doc<'services'>['status'];
  },
): Promise<Id<'services'>> {
  return f.t.run(async (ctx) => {
    const base = await ctx.db.get(f.serviceId);
    if (base === null) throw new Error('Expected fixture Service');
    return ctx.db.insert('services', {
      organizationId: base.organizationId,
      projectId: base.projectId,
      eventId: args.eventId ?? base.eventId,
      serviceKindId: base.serviceKindId,
      serviceKindVersionId: base.serviceKindVersionId,
      name: args.name,
      status: args.status ?? 'draft',
      startsAt: args.startsAt,
      ...(args.endsAt === undefined ? {} : { endsAt: args.endsAt }),
    });
  });
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

/**
 * Grants the fixture's OWN Provider, rather than a fresh one, so the fixture's
 * published Rate Card still resolves for that Provider's Revisions.
 * `makeGrantedProvider` deliberately creates a new Provider and is the right
 * helper when the commercial chain is not being exercised.
 */
async function grantFixtureProvider(
  f: Awaited<ReturnType<typeof fixture>>,
  subject: string,
  name: string,
): Promise<{ client: Client; firmOrganizationId: Id<'organizations'> }> {
  const firm = await provision(f.t, subject);
  const firmOrganizationId = await firm.client.mutation(createOrganization, { name, slug: subject });
  await f.t.run(async (ctx) => ctx.db.patch(f.providerId, { linkedOrganizationId: firmOrganizationId }));
  await f.owner.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: f.providerId });
  return { client: firm.client, firmOrganizationId };
}

async function refusal(promise: Promise<unknown>): Promise<{ message: string; data: unknown }> {
  try {
    await promise;
  } catch (error) {
    const thrown = error as { message: string; data: unknown };
    return { message: thrown.message, data: thrown.data };
  }
  throw new Error('Expected the call to be refused, but it resolved');
}

/**
 * #87 narrowed the Provider arm's revision reads, so `getAssignmentRevision`
 * now returns a union. Narrowing by ASSERTION rather than by widening
 * `commercial()` to accept both shapes is deliberate: a widened helper would
 * compare `undefined` against `undefined` for the two rate-card columns and
 * pass, turning the member-side price-immutability checks below into vacuous
 * ones the day somebody points them at a Provider client.
 */
function memberRevision(revision: Doc<'assignmentRevisions'> | Omit<
  Doc<'assignmentRevisions'>,
  'rateCardVersionId' | 'rateLineId' | 'acceptedByUserId'
>): Doc<'assignmentRevisions'> {
  expect(revision).toHaveProperty('rateCardVersionId');
  expect(revision).toHaveProperty('rateLineId');
  return revision as Doc<'assignmentRevisions'>;
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

test('planner resolves the one Assignment pricing cell without Rate Card catalogue access', async () => {
  const f = await fixture('assignment-rate-planner');
  const planner = await provision(f.t, 'assignment-rate-planner-member');
  await f.owner.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: planner.userId,
    role: 'planner',
  });

  await expect(planner.client.query(resolveAssignmentRate, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).resolves.toEqual({
    kind: 'resolved',
    rateCardId: f.rateCardId,
    rateCardName: 'assignment-rate-planner Card',
    rateCardVersionId: f.rateCardVersionId,
    rateLineId: f.rateLineId,
    unitAmount: 12_345,
    currency: 'COP',
  });
});

test('Assignment rate lookup reports every ambiguous card without exposing submit-ready Rate Line ids', async () => {
  const f = await fixture('assignment-rate-ambiguous');
  const secondCardId = await f.owner.client.mutation(createRateCard, {
    organizationId: f.organizationId,
    providerId: f.providerId,
    name: 'Second published card',
  });
  const secondVersionId = await f.owner.client.mutation(createInitialDraftVersion, {
    rateCardId: secondCardId,
    currency: 'USD',
  });
  await f.owner.client.mutation(addRateLine, {
    rateCardVersionId: secondVersionId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
    unitAmount: 54_321,
  });
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId: secondVersionId });

  const result = await f.owner.client.query(resolveAssignmentRate, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  });
  expect(result.kind).toBe('ambiguous');
  if (result.kind !== 'ambiguous') throw new Error('Expected an ambiguous pricing result');
  expect(result.candidates).toEqual([
    {
      rateCardId: f.rateCardId,
      rateCardName: 'assignment-rate-ambiguous Card',
      rateCardVersionId: f.rateCardVersionId,
      unitAmount: 12_345,
      currency: 'COP',
    },
    {
      rateCardId: secondCardId,
      rateCardName: 'Second published card',
      rateCardVersionId: secondVersionId,
      unitAmount: 54_321,
      currency: 'USD',
    },
  ]);
  for (const candidate of result.candidates) expect(candidate).not.toHaveProperty('rateLineId');
});

test('Assignment rate lookup returns noRateLine as an ordinary unpriceable result', async () => {
  const f = await fixture('assignment-rate-missing');
  const unpricedClassId = await f.owner.client.mutation(createVehicleClass, {
    organizationId: f.organizationId,
    key: 'unpricedClass',
    name: 'Unpriced Class',
  });
  await expect(f.owner.client.query(resolveAssignmentRate, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    vehicleClassId: unpricedClassId,
    modality: 'transfer',
  })).resolves.toEqual({ kind: 'unpriceable', reason: 'noRateLine' });
});

test('Assignment rate lookup excludes archived Rate Cards from missing and ambiguous results', async () => {
  const f = await fixture('assignment-rate-archived-card');
  const finder = vi.spyOn(rateCardModel, 'findRateForAssignment');
  await f.t.run(async (ctx) => ctx.db.patch(f.rateCardId, { status: 'archived' }));
  const args = {
    serviceId: f.serviceId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition' as const,
  };
  await expect(f.owner.client.query(resolveAssignmentRate, args))
    .resolves.toEqual({ kind: 'unpriceable', reason: 'noRateLine' });
  expect(finder).not.toHaveBeenCalled();

  const activeCardId = await f.owner.client.mutation(createRateCard, {
    organizationId: f.organizationId,
    providerId: f.providerId,
    name: 'Active replacement card',
  });
  const activeVersionId = await f.owner.client.mutation(createInitialDraftVersion, {
    rateCardId: activeCardId,
    currency: 'USD',
  });
  const activeLineId = await f.owner.client.mutation(addRateLine, {
    rateCardVersionId: activeVersionId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
    unitAmount: 54_321,
  });
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId: activeVersionId });

  await expect(f.owner.client.query(resolveAssignmentRate, args)).resolves.toEqual({
    kind: 'resolved',
    rateCardId: activeCardId,
    rateCardName: 'Active replacement card',
    rateCardVersionId: activeVersionId,
    rateLineId: activeLineId,
    unitAmount: 54_321,
    currency: 'USD',
  });
  expect(finder).toHaveBeenCalledTimes(1);
  finder.mockRestore();
});

test('Assignment rate lookup refuses to resolve from a partial read above the Rate Card cap', async () => {
  const f = await fixture('assignment-rate-card-limit');
  await f.t.run(async (ctx) => {
    for (let cardNumber = 2; cardNumber <= 101; cardNumber += 1) {
      await ctx.db.insert('rateCards', {
        organizationId: f.organizationId,
        providerId: f.providerId,
        name: `Unpublished card ${cardNumber}`,
        status: 'active',
      });
    }
  });
  await expect(f.owner.client.query(resolveAssignmentRate, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).resolves.toEqual({ kind: 'unpriceable', reason: 'rateCardLimitExceeded' });
});

test('Assignment rate lookup resolves a published cell at exactly the Rate Card cap', async () => {
  const f = await fixture('assignment-rate-card-boundary');
  await f.t.run(async (ctx) => {
    for (let cardNumber = 2; cardNumber <= maxRateCardsPerRateLookup; cardNumber += 1) {
      await ctx.db.insert('rateCards', {
        organizationId: f.organizationId,
        providerId: f.providerId,
        name: `Unpublished card ${cardNumber}`,
        status: 'active',
      });
    }
  });
  await expect(f.owner.client.query(resolveAssignmentRate, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).resolves.toEqual({
    kind: 'resolved',
    rateCardId: f.rateCardId,
    rateCardName: 'assignment-rate-card-boundary Card',
    rateCardVersionId: f.rateCardVersionId,
    rateLineId: f.rateLineId,
    unitAmount: 12_345,
    currency: 'COP',
  });
});

test('Assignment rate lookup refuses Provider principals, non-members, and every member below planner', async () => {
  const f = await fixture('assignment-rate-access');
  const provider = await grantFixtureProvider(f, 'assignment-rate-provider', 'Rate Provider Firm');
  const outsider = await provision(f.t, 'assignment-rate-outsider');
  const viewer = await provision(f.t, 'assignment-rate-viewer');
  await f.owner.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: viewer.userId,
    role: 'viewer',
  });
  // `operator` is the role directly beneath the floor, so it is the one that
  // catches an accidental drop from planner. Testing only `viewer` would leave
  // a one-rung slip — the likeliest mistake — completely unguarded.
  const operator = await provision(f.t, 'assignment-rate-operator');
  await f.owner.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: operator.userId,
    role: 'operator',
  });
  const args = {
    serviceId: f.serviceId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition' as const,
  };
  const refused: readonly { name: string; client: typeof provider.client }[] = [
    { name: 'granted Provider principal', client: provider.client },
    { name: 'non-member', client: outsider.client },
    { name: 'viewer member', client: viewer.client },
    { name: 'operator member', client: operator.client },
  ];
  for (const { name, client } of refused) {
    await expect(client.query(resolveAssignmentRate, args), name)
      .rejects.toMatchObject({ data: { code: inaccessible } });
  }
});

test('Assignment rate lookup refuses archived Provider and Vehicle Class references', async () => {
  const archivedProvider = await fixture('assignment-rate-archived-provider');
  await archivedProvider.owner.client.mutation(archiveProvider, { providerId: archivedProvider.providerId });
  await expect(archivedProvider.owner.client.query(resolveAssignmentRate, {
    serviceId: archivedProvider.serviceId,
    providerId: archivedProvider.providerId,
    vehicleClassId: archivedProvider.vehicleClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });

  const archivedClass = await fixture('assignment-rate-archived-class');
  await archivedClass.owner.client.mutation(archiveVehicleClass, { vehicleClassId: archivedClass.vehicleClassId });
  await expect(archivedClass.owner.client.query(resolveAssignmentRate, {
    serviceId: archivedClass.serviceId,
    providerId: archivedClass.providerId,
    vehicleClassId: archivedClass.vehicleClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('Service Assignment rows are member-only for Provider principals and non-members', async () => {
  const f = await fixture('assignment-rows-access');
  const provider = await grantFixtureProvider(f, 'assignment-rows-provider', 'Rows Provider Firm');
  const outsider = await provision(f.t, 'assignment-rows-outsider');
  for (const client of [provider.client, outsider.client]) {
    await expect(client.query(listServiceAssignmentRows, { serviceId: f.serviceId }))
      .rejects.toMatchObject({ data: { code: inaccessible } });
  }
});

test('Service Assignment rows resolve for members at the viewer role floor', async () => {
  const f = await fixture('assignment-rows-viewer-floor');
  const viewer = await provision(f.t, 'assignment-rows-viewer');
  await f.owner.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: viewer.userId,
    role: 'viewer',
  });

  await expect(
    viewer.client.query(listServiceAssignmentRows, { serviceId: f.serviceId }),
    'viewer member',
  ).resolves.toMatchObject([{ assignment: { _id: f.assignmentId } }]);
});

test('Service Assignment rows reject a current pointer to a different Assignment revision', async () => {
  const f = await fixture('assignment-rows-current-assignment');
  const otherAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 20,
  });
  const otherRevisionId = await f.owner.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    assignmentId: otherAssignmentId,
  });
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: otherRevisionId });
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { currentRevisionId: otherRevisionId }));
  const rows = await f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId });
  expect(rows.find((row) => row.assignment._id === f.assignmentId)?.currentRevision).toBeNull();
});

test('Service Assignment rows reject a current pointer to a foreign-organization revision', async () => {
  const f = await fixture('assignment-rows-current-org');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign revision organization',
    slug: 'assignment-rows-current-org-foreign',
  });
  const foreignRevisionId = await f.t.run((ctx) => ctx.db.insert('assignmentRevisions', {
    organizationId: foreignOrganizationId,
    assignmentId: f.assignmentId,
    revisionNumber: 99,
    status: 'accepted',
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
    quantity: 1,
    rateCardVersionId: f.rateCardVersionId,
    rateLineId: f.rateLineId,
    unitAmount: 12_345,
    currency: 'COP',
    lineTotal: 12_345,
  }));
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { currentRevisionId: foreignRevisionId }));
  const rows = await f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId });
  expect(rows[0]?.currentRevision).toBeNull();
  expect(rows[0]?.latestRevision).toBeNull();
});

test('Service Assignment rows refuse a row whose organization disagrees with its Service', async () => {
  const f = await fixture('assignment-rows-foreign-assignment');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign Assignment organization',
    slug: 'assignment-rows-foreign-assignment-org',
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { organizationId: foreignOrganizationId }));
  await expect(f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('Service Assignment rows refuse a row whose Project disagrees with its Service', async () => {
  const f = await fixture('assignment-rows-foreign-assignment-project');
  const other = await insertService(f.t, f.organizationId, 'Foreign Assignment project');
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { projectId: other.projectId }));
  await expect(f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('Service Assignment rows reject a current pointer to a non-accepted revision', async () => {
  const f = await fixture('assignment-rows-current-status');
  const draftRevisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { currentRevisionId: draftRevisionId }));
  const rows = await f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId });
  expect(rows[0]?.currentRevision).toBeNull();
});

test('Service Assignment rows degrade foreign Provider, Vehicle Class, and Cost Centre joins to null', async () => {
  const f = await fixture('assignment-rows-foreign-joins');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign joins organization',
    slug: 'assignment-rows-foreign-joins-org',
  });
  const foreignProviderId = await f.owner.client.mutation(createProvider, {
    organizationId: foreignOrganizationId,
    name: 'Foreign Provider',
  });
  const foreignVehicleClassId = await f.owner.client.mutation(createVehicleClass, {
    organizationId: foreignOrganizationId,
    key: 'foreignClass',
    name: 'Foreign Class',
  });
  const foreignCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: foreignOrganizationId,
    key: 'foreignCost',
    name: 'Foreign Cost Centre',
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.assignmentId, {
      providerId: foreignProviderId,
      costCentreId: foreignCostCentreId,
    });
    await ctx.db.insert('assignmentRevisions', {
      organizationId: f.organizationId,
      assignmentId: f.assignmentId,
      revisionNumber: 1,
      status: 'draft',
      vehicleClassId: foreignVehicleClassId,
      modality: 'disposition',
      quantity: 1,
      rateCardVersionId: f.rateCardVersionId,
      rateLineId: f.rateLineId,
      unitAmount: 12_345,
      currency: 'COP',
      lineTotal: 12_345,
    });
  });
  const rows = await f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId });
  expect(rows[0]).toMatchObject({ provider: null, vehicleClass: null, costCentre: null });
});

test('Service Assignment rows distinguish the accepted current Revision from a newer draft', async () => {
  const f = await fixture('assignment-rows-revisions');
  const costCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'operations',
    name: 'Operations Cost Centre',
  });
  const acceptedRevisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: acceptedRevisionId });
  const newerVehicleClassId = await f.owner.client.mutation(createVehicleClass, {
    organizationId: f.organizationId,
    key: 'newerClass',
    name: 'Newer Draft Class',
  });
  const newerRateCardId = await f.owner.client.mutation(createRateCard, {
    organizationId: f.organizationId,
    providerId: f.providerId,
    name: 'Newer Draft Card',
  });
  const newerVersionId = await f.owner.client.mutation(createInitialDraftVersion, {
    rateCardId: newerRateCardId,
    currency: 'COP',
  });
  const newerRateLineId = await f.owner.client.mutation(addRateLine, {
    rateCardVersionId: newerVersionId,
    vehicleClassId: newerVehicleClassId,
    modality: 'disposition',
    unitAmount: 22_000,
  });
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId: newerVersionId });
  const draftRevisionId = await f.owner.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    vehicleClassId: newerVehicleClassId,
    quantity: 4,
    rateCardVersionId: newerVersionId,
    rateLineId: newerRateLineId,
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { costCentreId }));
  const earlierAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 5,
  });
  const rows = await f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId });
  expect(rows.map((row) => row.assignment._id)).toEqual([earlierAssignmentId, f.assignmentId]);
  const pricedRow = rows[1];
  expect(pricedRow?.currentRevision).toMatchObject({ _id: acceptedRevisionId, revisionNumber: 1, status: 'accepted' });
  expect(pricedRow?.latestRevision).toMatchObject({ _id: draftRevisionId, revisionNumber: 2, status: 'draft' });
  expect(pricedRow?.provider).toEqual({
    _id: f.providerId,
    name: 'assignment-rows-revisions Provider',
    status: 'active',
  });
  expect(pricedRow?.vehicleClass).toEqual({
    _id: f.vehicleClassId,
    name: 'assignment-rows-revisions Class',
    status: 'active',
  });
  expect(pricedRow?.costCentre).toEqual({
    _id: costCentreId,
    key: 'operations',
    name: 'Operations Cost Centre',
    status: 'active',
  });
});

test('Service Assignment rows degrade missing catalogue documents to null', async () => {
  const f = await fixture('assignment-rows-missing-joins');
  const costCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'removed',
    name: 'Removed Cost Centre',
  });
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.assignmentId, { costCentreId });
    await ctx.db.delete(f.providerId);
    await ctx.db.delete(f.vehicleClassId);
    await ctx.db.delete(costCentreId);
  });
  const rows = await f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId });
  expect(rows[0]).toMatchObject({ provider: null, vehicleClass: null, costCentre: null });
});

test('new Assignment queries refuse when the Service and Project organizations disagree', async () => {
  const f = await fixture('assignment-query-project-mismatch');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign Project organization',
    slug: 'assignment-query-project-mismatch-org',
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.projectId, { organizationId: foreignOrganizationId }));
  await expect(f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.owner.client.query(resolveAssignmentRate, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('Assignment rate lookup refuses foreign Provider and Vehicle Class references', async () => {
  const f = await fixture('assignment-rate-foreign-references');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign Rate Lookup organization',
    slug: 'assignment-rate-foreign-references-org',
  });
  const foreignProviderId = await f.owner.client.mutation(createProvider, {
    organizationId: foreignOrganizationId,
    name: 'Foreign Rate Provider',
  });
  const foreignVehicleClassId = await f.owner.client.mutation(createVehicleClass, {
    organizationId: foreignOrganizationId,
    key: 'foreignRateClass',
    name: 'Foreign Rate Class',
  });
  await expect(f.owner.client.query(resolveAssignmentRate, {
    serviceId: f.serviceId,
    providerId: foreignProviderId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.owner.client.query(resolveAssignmentRate, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    vehicleClassId: foreignVehicleClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('Service Assignment row reads stop at the declared per-Service bound', async () => {
  const f = await fixture('assignment-rows-bound');
  await f.t.run(async (ctx) => {
    for (let rowNumber = 0; rowNumber < 200; rowNumber += 1) {
      await ctx.db.insert('assignments', {
        organizationId: f.organizationId,
        serviceId: f.serviceId,
        projectId: f.projectId,
        providerId: f.providerId,
        position: 1_000 + rowNumber,
        executionStatus: 'unassigned',
      });
    }
  });
  const rows = await f.owner.client.query(listServiceAssignmentRows, { serviceId: f.serviceId });
  expect(rows).toHaveLength(200);
  expect(rows[0]?.assignment.position).toBe(10);
  expect(rows[199]?.assignment.position).toBe(1_198);
});

test('Assignment revision history first page starts with the highest revision across multiple pages', async () => {
  const f = await fixture('assignment-revisions-descending');
  for (let quantity = 1; quantity <= 11; quantity += 1) {
    await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity });
  }
  const page = await f.owner.client.query(listAssignmentRevisions, {
    assignmentId: f.assignmentId,
    paginationOpts: firstPage,
  });
  expect(page.isDone).toBe(false);
  expect(page.page[0]?.revisionNumber).toBe(11);
});

test('creation derives tenant and Project from the Service, trims notes, and prices an immutable snapshot', async () => {
  const f = await fixture('assignment-create');
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({
    organizationId: f.organizationId,
    projectId: f.projectId,
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 10,
    notes: 'first bus',
    executionStatus: 'unassigned',
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

test('explicit Cost Centre references reject foreign, fabricated, and archived ids generically', async () => {
  const f = await fixture('assignment-cost-centre-invalid');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign Cost Centre organization',
    slug: 'assignment-cost-centre-foreign',
  });
  const foreignCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: foreignOrganizationId,
    key: 'foreignCharge',
    name: 'Foreign charge',
  });
  const fabricatedCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'removedCharge',
    name: 'Removed charge',
  });
  await f.owner.client.mutation(archiveCostCentre, { costCentreId: fabricatedCostCentreId });
  await f.owner.client.mutation(deleteCostCentre, { costCentreId: fabricatedCostCentreId });
  const archivedCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'archivedCharge',
    name: 'Archived charge',
  });
  await f.owner.client.mutation(archiveCostCentre, { costCentreId: archivedCostCentreId });

  for (const costCentreId of [foreignCostCentreId, fabricatedCostCentreId, archivedCostCentreId]) {
    await expect(f.owner.client.mutation(createAssignment, {
      serviceId: f.serviceId,
      providerId: f.providerId,
      costCentreId,
      position: 20,
    })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
});

test('omitting a Cost Centre leaves Assignment attribution absent', async () => {
  const f = await fixture('assignment-cost-centre-absent');
  const assignment = await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId });
  // Absent means the key is not stored at all, not stored as undefined.
  expect(assignment).not.toHaveProperty('costCentreId');
});

test('Event Cost Centre defaults materialize while an explicit Cost Centre overrides them', async () => {
  const f = await fixture('assignment-cost-centre-default');
  const eventCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'eventCharge',
    name: 'Event charge',
  });
  const explicitCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'explicitCharge',
    name: 'Explicit charge',
  });
  await f.owner.client.mutation(updateEvent, {
    eventId: f.eventId,
    clientCostCentreId: eventCostCentreId,
  });

  const inheritedAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 20,
  });
  const explicitAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    costCentreId: explicitCostCentreId,
    position: 30,
  });

  expect(await f.owner.client.query(getAssignment, { assignmentId: inheritedAssignmentId }))
    .toMatchObject({ costCentreId: eventCostCentreId });
  expect(await f.owner.client.query(getAssignment, { assignmentId: explicitAssignmentId }))
    .toMatchObject({ costCentreId: explicitCostCentreId });
});

test('changing the Event Cost Centre affects only Assignments created afterward', async () => {
  const f = await fixture('assignment-cost-centre-materialized');
  const firstCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'firstCharge',
    name: 'First charge',
  });
  const secondCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'secondCharge',
    name: 'Second charge',
  });
  await f.owner.client.mutation(updateEvent, {
    eventId: f.eventId,
    clientCostCentreId: firstCostCentreId,
  });
  const firstAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 20,
  });

  await f.owner.client.mutation(updateEvent, {
    eventId: f.eventId,
    clientCostCentreId: secondCostCentreId,
  });
  const secondAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 30,
  });

  expect(await f.owner.client.query(getAssignment, { assignmentId: firstAssignmentId }))
    .toMatchObject({ costCentreId: firstCostCentreId });
  expect(await f.owner.client.query(getAssignment, { assignmentId: secondAssignmentId }))
    .toMatchObject({ costCentreId: secondCostCentreId });
});

test('an archived Event Cost Centre is still inherited by a new Assignment', async () => {
  const f = await fixture('assignment-cost-centre-archived-default');
  const costCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'historicalCharge',
    name: 'Historical charge',
  });
  await f.owner.client.mutation(updateEvent, { eventId: f.eventId, clientCostCentreId: costCentreId });
  await f.owner.client.mutation(archiveCostCentre, { costCentreId });

  const assignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 20,
  });
  expect(await f.owner.client.query(getAssignment, { assignmentId }))
    .toMatchObject({ costCentreId });
});

test('Cost Centre deletion is blocked only while an Assignment still references it', async () => {
  const f = await fixture('assignment-cost-centre-delete');
  const costCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'deletionCharge',
    name: 'Deletion charge',
  });
  const assignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    costCentreId,
    position: 20,
  });
  await f.owner.client.mutation(archiveCostCentre, { costCentreId });

  await expect(f.owner.client.mutation(deleteCostCentre, { costCentreId }))
    .rejects.toMatchObject({ data: { code: 'costCentreDeleteBlocked' } });
  await f.owner.client.mutation(removeAssignment, { assignmentId });
  await expect(f.owner.client.mutation(deleteCostCentre, { costCentreId })).resolves.toBeNull();
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(costCentreId)).toBeNull();
  });
});

test('Revision snapshots store every pricing input and preserve arithmetic in a non-COP currency', async () => {
  const f = await fixture('assignment-full-snapshot', 'USD');
  const firstId = await f.owner.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    quantity: 2,
  });
  const secondId = await f.owner.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    quantity: 7,
  });

  expect(await f.owner.client.query(getAssignmentRevision, { revisionId: firstId })).toMatchObject({
    organizationId: f.organizationId,
    assignmentId: f.assignmentId,
    revisionNumber: 1,
    status: 'draft',
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
    quantity: 2,
    rateCardVersionId: f.rateCardVersionId,
    rateLineId: f.rateLineId,
    unitAmount: 12_345,
    currency: 'USD',
    lineTotal: 24_690,
  });
  expect(await f.owner.client.query(getAssignmentRevision, { revisionId: secondId })).toMatchObject({
    organizationId: f.organizationId,
    assignmentId: f.assignmentId,
    revisionNumber: 2,
    status: 'draft',
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
    quantity: 7,
    rateCardVersionId: f.rateCardVersionId,
    rateLineId: f.rateLineId,
    unitAmount: 12_345,
    currency: 'USD',
    lineTotal: 86_415,
  });
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
  expect(commercial(memberRevision(after))).toEqual(commercial(memberRevision(before)));
  expect(after.lineTotal).toBe(37_035);
});

test('I7: concurrent Revision creation assigns distinct, gapless server numbers', async () => {
  const f = await fixture('assignment-concurrent-create');
  const ids = await Promise.all([
    f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 7 }),
    f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 3 }),
    f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 5 }),
  ]);
  expect(new Set(ids)).toHaveLength(3);
  const rows = await f.owner.client.query(listAssignmentRevisions, { assignmentId: f.assignmentId, paginationOpts: firstPage });
  expect(rows.page.map((row) => row.revisionNumber)).toEqual([3, 2, 1]);
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
  const cancelledRevisionId = await cancelled.owner.client.mutation(createAssignmentRevision, cancelled.revisionArgs);
  await cancelled.owner.client.mutation(changeServiceStatus, { serviceId: cancelled.serviceId, status: 'cancelled' });
  await expect(cancelled.owner.client.mutation(createAssignment, {
    serviceId: cancelled.serviceId,
    providerId: cancelled.providerId,
    position: 20,
  })).rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });
  await expect(cancelled.owner.client.mutation(createAssignmentRevision, cancelled.revisionArgs))
    .rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });
  await expect(cancelled.owner.client.mutation(acceptAssignmentRevision, { revisionId: cancelledRevisionId }))
    .rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });
  await expect(cancelled.owner.client.mutation(declineAssignmentRevision, { revisionId: cancelledRevisionId, reason: 'no longer needed' }))
    .rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });

  const frozen = await fixture('assignment-frozen');
  const frozenRevisionId = await frozen.owner.client.mutation(createAssignmentRevision, frozen.revisionArgs);
  await frozen.owner.client.mutation(archiveProject, { projectId: frozen.projectId });
  await expect(frozen.owner.client.mutation(createAssignment, {
    serviceId: frozen.serviceId,
    providerId: frozen.providerId,
    position: 20,
  })).rejects.toMatchObject({ data: { code: 'serviceProjectReadOnly' } });
  await expect(frozen.owner.client.mutation(createAssignmentRevision, frozen.revisionArgs))
    .rejects.toMatchObject({ data: { code: 'serviceProjectReadOnly' } });
  await expect(frozen.owner.client.mutation(acceptAssignmentRevision, { revisionId: frozenRevisionId }))
    .rejects.toMatchObject({ data: { code: 'serviceProjectReadOnly' } });
  await expect(frozen.owner.client.mutation(declineAssignmentRevision, { revisionId: frozenRevisionId, reason: 'no longer needed' }))
    .rejects.toMatchObject({ data: { code: 'serviceProjectReadOnly' } });
});

test('viewer and operator are refused while planner can use every Assignment write door', async () => {
  for (const role of ['viewer', 'operator'] as const) {
    const f = await fixture(`assignment-role-${role}`);
    const member = await provision(f.t, `assignment-role-${role}-member`);
    await f.owner.client.mutation(addMember, { organizationId: f.organizationId, userId: member.userId, role });
    const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
    await expect(member.client.mutation(createAssignment, {
      serviceId: f.serviceId,
      providerId: f.providerId,
      position: 20,
    })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(member.client.mutation(createAssignmentRevision, f.revisionArgs))
      .rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(member.client.mutation(acceptAssignmentRevision, { revisionId }))
      .rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(member.client.mutation(declineAssignmentRevision, { revisionId, reason: 'not mine to decline' }))
      .rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(member.client.mutation(removeAssignment, { assignmentId: f.assignmentId }))
      .rejects.toMatchObject({ data: { code: inaccessible } });
  }

  const f = await fixture('assignment-role-planner');
  const planner = await provision(f.t, 'assignment-role-planner-member');
  await f.owner.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: planner.userId,
    role: 'planner',
  });
  const removableId = await planner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 20,
  });
  await expect(planner.client.mutation(removeAssignment, { assignmentId: removableId })).resolves.toBeNull();
  const declinedId = await planner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await expect(planner.client.mutation(declineAssignmentRevision, {
    revisionId: declinedId,
    reason: 'Terms no longer fit the plan',
  })).resolves.toBeNull();
  const acceptedId = await planner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  await expect(planner.client.mutation(acceptAssignmentRevision, { revisionId: acceptedId })).resolves.toBeNull();
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
    'counterAssignmentRevision',
    'declineAssignmentRevision',
    'removeAssignment',
    'transitionAssignmentExecution',
    'recordAssignmentCheckpoint',
    'recordAssignmentAdjustments',
  ]);

  const f = await fixture('assignment-immutable');
  const firstId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  const before = await f.owner.client.query(getAssignmentRevision, { revisionId: firstId });
  await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  expect(
    commercial(memberRevision(await f.owner.client.query(getAssignmentRevision, { revisionId: firstId }))),
  ).toEqual(commercial(memberRevision(before)));
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

test('acceptance stores a bounded timestamp and the accepting actor rather than the Assignment owner', async () => {
  const f = await fixture('assignment-acceptance-provenance');
  const acceptingPlanner = await provision(f.t, 'assignment-acceptance-planner');
  await f.owner.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: acceptingPlanner.userId,
    role: 'planner',
  });
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  const startedAt = Date.now();
  await acceptingPlanner.client.mutation(acceptAssignmentRevision, { revisionId });
  const finishedAt = Date.now();
  const revision = await f.owner.client.query(getAssignmentRevision, { revisionId });
  expect(revision.acceptedAt).toBeGreaterThanOrEqual(startedAt);
  expect(revision.acceptedAt).toBeLessThanOrEqual(finishedAt);
  expect(revision).toMatchObject({ acceptedByUserId: acceptingPlanner.userId });
  expect(revision).not.toMatchObject({ acceptedByUserId: f.owner.userId });
});

test('currentRevisionId is present iff one Revision is accepted across acceptance, supersession, and decline', async () => {
  const f = await fixture('assignment-current-mirror');
  const firstId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  const secondId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: firstId });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({ currentRevisionId: firstId });
  await f.owner.client.mutation(declineAssignmentRevision, { revisionId: secondId, reason: 'declined' });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({ currentRevisionId: firstId });
  expect(await f.owner.client.query(getAssignmentRevision, { revisionId: secondId })).toMatchObject({ status: 'declined', declinedReason: 'declined' });

  const thirdId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 5 });
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: thirdId });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({ currentRevisionId: thirdId });
  expect(await f.owner.client.query(getAssignmentRevision, { revisionId: firstId })).toMatchObject({ status: 'superseded' });

  await expect(f.owner.client.mutation(declineAssignmentRevision, { revisionId: firstId, reason: 'no longer needed' }))
    .rejects.toMatchObject({ data: { code: 'assignmentRevisionNotDeclinable' } });
  await expect(f.owner.client.mutation(declineAssignmentRevision, { revisionId: secondId, reason: 'no longer needed' }))
    .rejects.toMatchObject({ data: { code: 'assignmentRevisionNotDeclinable' } });
  await expect(f.owner.client.mutation(declineAssignmentRevision, { revisionId: thirdId, reason: 'no longer needed' }))
    .rejects.toMatchObject({ data: { code: 'assignmentRevisionNotDeclinable' } });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({ currentRevisionId: thirdId });
  const accepted = await f.owner.client.query(getAssignmentRevision, { revisionId: thirdId });
  expect(accepted).toMatchObject({
    status: 'accepted',
    acceptedByUserId: f.owner.userId,
  });
  expect(accepted.acceptedAt).toBeGreaterThan(0);
});

test('a corrupted currentRevisionId mirror refuses both acceptance and decline', async () => {
  const f = await fixture('assignment-corrupt-mirror');
  const acceptedId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: acceptedId });
  const draftId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 4 });
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { currentRevisionId: draftId }));
  await expect(f.owner.client.mutation(acceptAssignmentRevision, { revisionId: draftId }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.owner.client.mutation(declineAssignmentRevision, { revisionId: acceptedId, reason: 'no longer needed' }))
    .rejects.toMatchObject({ data: { code: 'assignmentRevisionNotDeclinable' } });
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
  expect([...revisions1.page, ...revisions2.page].map((row) => row._id)).toEqual([revision2, revision1]);

  const sources = import.meta.glob('../convex/assignments/model.ts', { query: '?raw', import: 'default', eager: true });
  const source = Object.values(sources)[0] ?? '';
  for (const index of ['by_service_position', 'by_project_provider_position', 'by_project_position', 'by_assignment_revision', 'by_assignment_status']) {
    expect(source).toContain(`withIndex('${index}'`);
  }
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
  const rateCardId = await f.owner.client.mutation(createRateCard, {
    organizationId: f.organizationId,
    providerId: granted.providerId,
    name: 'Writer Firm Card',
  });
  const rateCardVersionId = await f.owner.client.mutation(createInitialDraftVersion, {
    rateCardId,
    currency: 'COP',
  });
  const rateLineId = await f.owner.client.mutation(addRateLine, {
    rateCardVersionId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
    unitAmount: 44_000,
  });
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId });

  await expect(granted.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: granted.providerId,
    position: 40,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(granted.client.mutation(createAssignmentRevision, {
    assignmentId: ownId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
    quantity: 2,
    rateCardVersionId,
    rateLineId,
  }))
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

test('listDispatchDay pages Services by start time, preserves half-open bounds, and orders complete child rows', async () => {
  const f = await fixture('dispatch-day-order');
  await insertFixtureService(f, { name: 'Lower outside', startsAt: 999 });
  const firstId = await insertFixtureService(f, {
    name: 'First included',
    startsAt: 1_000,
    endsAt: 1_400,
    status: 'confirmed',
  });
  const secondId = await insertFixtureService(f, { name: 'Second included', startsAt: 1_500 });
  await insertFixtureService(f, { name: 'Upper outside', startsAt: 2_000 });
  await f.t.run(async (ctx) => {
    await ctx.db.insert('assignments', {
      organizationId: f.organizationId,
      serviceId: firstId,
      projectId: f.projectId,
      providerId: f.providerId,
      position: 30,
      executionStatus: 'unassigned',
    });
    await ctx.db.insert('assignments', {
      organizationId: f.organizationId,
      serviceId: firstId,
      projectId: f.projectId,
      providerId: f.providerId,
      position: 5,
      executionStatus: 'unassigned',
    });
  });

  const page = await f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    from: 1_000,
    to: 2_000,
    paginationOpts: firstPage,
  });
  expect(page.page.map((entry) => entry.service._id), 'Services follow by_project_startsAt order')
    .toEqual([firstId, secondId]);
  expect(page.page[0]?.rows.map((row) => row.assignment.position), 'rows follow by_service_position order')
    .toEqual([5, 30]);
  expect(page.page[0]?.service, 'the coordinator board discloses the stored Service column values').toEqual({
    _id: firstId,
    name: 'First included',
    startsAt: 1_000,
    endsAt: 1_400,
    status: 'confirmed',
    eventId: f.eventId,
  });

  const filtered = await f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    from: 1_000,
    to: 2_000,
    status: 'assigned',
    paginationOpts: firstPage,
  });
  expect(filtered.page.map((entry) => entry.service._id), 'assignment filters retain every Service page entry')
    .toEqual([firstId, secondId]);
  expect(filtered.page[0]?.rows, 'a Service whose rows filter away remains explicit').toEqual([]);
  expect(filtered.page[1]?.rows, 'an originally empty Service remains explicit').toEqual([]);
});

test('dispatch day windows reject spans over 31 days, non-integer bounds, and non-increasing ranges', async () => {
  const f = await fixture('dispatch-day-window');
  const invalidWindows = [
    { from: 0, to: 31 * 24 * 60 * 60 * 1_000 + 1 },
    { from: 0.5, to: 1_000 },
    { from: 1_000, to: 1_000 },
  ];
  for (const window of invalidWindows) {
    await expect(f.owner.client.query(listDispatchDay, {
      projectId: f.projectId,
      ...window,
      paginationOpts: firstPage,
    }), `invalid window ${window.from}..${window.to} is refused`)
      .rejects.toMatchObject({ data: { code: 'assignmentDispatchWindowInvalid' } });
  }

  await expect(f.owner.client.query(dispatchDayReadiness, {
    projectId: f.projectId,
    from: 10,
    to: 9,
  }), 'readiness uses the shared dispatch window gate')
    .rejects.toMatchObject({ data: { code: 'assignmentDispatchWindowInvalid' } });

  const firm = await makeGrantedProvider(f, 'dispatch-window-provider-firm', 'Dispatch Window Provider');
  await expect(firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: Number.NaN,
    to: 10,
    paginationOpts: firstPage,
  }), 'Provider board uses the shared dispatch window gate')
    .rejects.toMatchObject({ data: { code: 'assignmentDispatchWindowInvalid' } });
});

test('listDispatchDay uses the Event time range and refuses an Event from another Project', async () => {
  const f = await fixture('dispatch-day-event');
  const otherEventId = await f.t.run(async (ctx) => ctx.db.insert('events', {
    organizationId: f.organizationId,
    projectId: f.projectId,
    name: 'Other same-project Event',
    status: 'active',
    startsAt: 0,
  }));
  const selectedId = await insertFixtureService(f, { name: 'Selected event Service', startsAt: 1_000 });
  const otherId = await insertFixtureService(f, {
    name: 'Other event Service',
    startsAt: 1_100,
    eventId: otherEventId,
  });
  const selected = await f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    eventId: f.eventId,
    from: 900,
    to: 1_200,
    paginationOpts: firstPage,
  });
  expect(selected.page.map((entry) => entry.service._id), 'Event range includes only the selected Event')
    .toEqual([selectedId]);
  expect(selected.page.map((entry) => entry.service._id), 'same-project peer Event is excluded by the index')
    .not.toContain(otherId);

  const foreignEventId = await f.t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', {
      organizationId: f.organizationId,
      name: 'Foreign Project',
      status: 'active',
    });
    return ctx.db.insert('events', {
      organizationId: f.organizationId,
      projectId,
      name: 'Foreign Project Event',
      status: 'active',
      startsAt: 0,
    });
  });
  await expect(f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    eventId: foreignEventId,
    from: 900,
    to: 1_200,
    paginationOpts: firstPage,
  }), 'Event ownership is re-derived from stored rows')
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listDispatchDay refuses Provider principals and authenticated non-members', async () => {
  const f = await fixture('dispatch-day-member-only');
  const firm = await makeGrantedProvider(f, 'dispatch-day-provider-firm', 'Dispatch Day Provider');
  const outsider = await provision(f.t, 'dispatch-day-outsider');
  const args = { projectId: f.projectId, from: 0, to: 10, paginationOpts: firstPage };
  await expect(firm.client.query(listDispatchDay, args), 'Provider principal cannot enter the coordinator board')
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.query(listDispatchDay, args), 'non-member cannot enter the coordinator board')
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('dispatchDayReadiness refuses Provider principals and authenticated non-members', async () => {
  const f = await fixture('dispatch-readiness-member-only');
  const firm = await makeGrantedProvider(f, 'dispatch-readiness-provider-firm', 'Readiness Provider');
  const outsider = await provision(f.t, 'dispatch-readiness-outsider');
  const args = { projectId: f.projectId, from: 0, to: 10 };
  await expect(firm.client.query(dispatchDayReadiness, args), 'Provider principal cannot read coordinator aggregates')
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.query(dispatchDayReadiness, args), 'non-member cannot read coordinator aggregates')
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listProviderDispatchDay refuses coordinator members and authenticated non-members', async () => {
  const f = await fixture('provider-dispatch-provider-only');
  const outsider = await provision(f.t, 'provider-dispatch-provider-only-outsider');
  const args = { projectId: f.projectId, from: 0, to: 10, paginationOpts: firstPage };
  await expect(f.owner.client.query(listProviderDispatchDay, args), 'member cannot enter the Provider board')
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.query(listProviderDispatchDay, args), 'non-member cannot enter the Provider board')
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listProviderDispatchDay requests both Assignment and linked-Service capabilities', () => {
  const sources = import.meta.glob('../convex/assignments/model.ts', { query: '?raw', import: 'default', eager: true });
  const source = Object.values(sources)[0] ?? '';
  const functionBody = source.slice(
    source.indexOf('export async function listProviderDispatchDay'),
    source.indexOf('async function paginateProviderDispatchAssignments'),
  );
  expect(functionBody.match(/requirePrincipalForProject\(ctx, args\.projectId, 'readAssignment'\)/g))
    .toHaveLength(1);
  expect(functionBody.match(/requirePrincipalForProject\(ctx, args\.projectId, 'readLinkedServiceProjection'\)/g))
    .toHaveLength(1);
});

test('listProviderDispatchDay exposes only Services carrying the Provider own narrowed rows and rechecks revocation', async () => {
  const f = await fixture('provider-dispatch-day');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const ownServiceId = await insertFixtureService(f, { name: 'Provider own Service', startsAt: 200 });
  await insertFixtureService(f, { name: 'Unrelated Service', startsAt: 300 });
  const firm = await makeGrantedProvider(f, 'provider-dispatch-firm', 'Provider Dispatch Firm');
  const assignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: ownServiceId,
    providerId: firm.providerId,
    position: 20,
  });
  await f.t.run(async (ctx) => ctx.db.patch(assignmentId, {
    costCentreId: undefined,
    notExecutedAmount: 10,
    additionalCharges: 20,
    additionalDetail: 'coordinator only',
  }));

  const page = await firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 400,
    paginationOpts: firstPage,
  });
  expect(page.page.map((entry) => entry.service._id), 'only a Service with this Provider Assignment is disclosed')
    .toEqual([ownServiceId]);
  // The strict public return validator is the primary enforcement of this
  // shell. This assertion documents the same contract at the model boundary.
  expect(Object.keys(page.page[0]?.service ?? {}), 'Provider Service shell is exactly id plus start')
    .toEqual(['_id', 'startsAt']);
  expect(page.page[0]?.service.startsAt, 'Provider Service start retains its stored value').toBe(200);
  expectNoForbiddenProviderKeys(page.page[0]?.assignment ?? {});

  await f.owner.client.mutation(revokeProviderAccessGrant, { grantId: firm.grantId });
  await expect(firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 400,
    paginationOpts: firstPage,
  }), 'revocation removes access on the immediately following query')
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listProviderDispatchDay includes from and excludes both sides of its half-open day window', async () => {
  const f = await fixture('provider-dispatch-window');
  const firm = await makeGrantedProvider(f, 'provider-dispatch-window-firm', 'Window Firm');
  const beforeId = await insertFixtureService(f, { name: 'Before window', startsAt: 99 });
  const fromId = await insertFixtureService(f, { name: 'At from', startsAt: 100 });
  const toId = await insertFixtureService(f, { name: 'At to', startsAt: 200 });
  const afterId = await insertFixtureService(f, { name: 'After window', startsAt: 201 });
  const assignmentIds = await f.t.run(async (ctx) => {
    const ids: Id<'assignments'>[] = [];
    for (const [serviceId, position] of [
      [beforeId, 20], [fromId, 30], [toId, 40], [afterId, 50],
    ] as const) {
      ids.push(await ctx.db.insert('assignments', {
        organizationId: f.organizationId,
        serviceId,
        projectId: f.projectId,
        providerId: firm.providerId,
        position,
        executionStatus: 'unassigned',
      }));
    }
    return ids;
  });

  const page = await firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 100,
    to: 200,
    paginationOpts: firstPage,
  });
  const returned = page.page.map((entry) => entry.assignment._id);
  expect(returned, 'an Assignment before from is excluded').not.toContain(assignmentIds[0]);
  expect(returned, 'an Assignment exactly at from is included').toContain(assignmentIds[1]);
  expect(returned, 'an Assignment exactly at to is excluded').not.toContain(assignmentIds[2]);
  expect(returned, 'an Assignment after to is excluded').not.toContain(assignmentIds[3]);
});

test('listProviderDispatchDay returns same-position Assignments from different Services', async () => {
  const f = await fixture('provider-dispatch-same-position');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const otherServiceId = await insertFixtureService(f, { name: 'Same position peer', startsAt: 110 });
  const firm = await makeGrantedProvider(f, 'provider-dispatch-same-position-firm', 'Same Position Firm');
  const firstId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: firm.providerId,
    position: 20,
  });
  const secondId = await f.owner.client.mutation(createAssignment, {
    serviceId: otherServiceId,
    providerId: firm.providerId,
    position: 20,
  });

  const page = await firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 200,
    paginationOpts: firstPage,
  });
  expect(page.page.map((entry) => entry.assignment._id)).toEqual([firstId, secondId]);
});

test('listProviderDispatchDay rejects fractional page sizes and clamps oversized pages to 200 Assignments', async () => {
  const f = await fixture('provider-dispatch-page-bound');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const secondServiceId = await insertFixtureService(f, { name: 'Provider page bound peer', startsAt: 110 });
  const firm = await makeGrantedProvider(f, 'provider-dispatch-page-bound-firm', 'Page Bound Firm');
  await f.t.run(async (ctx) => {
    for (let index = 0; index < 201; index += 1) {
      await ctx.db.insert('assignments', {
        organizationId: f.organizationId,
        serviceId: index < 200 ? f.serviceId : secondServiceId,
        projectId: f.projectId,
        providerId: firm.providerId,
        position: index < 200 ? index : 0,
        executionStatus: 'unassigned',
      });
    }
  });
  await expect(firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 200,
    paginationOpts: { numItems: 1.5, cursor: null },
  })).rejects.toMatchObject({ data: { code: 'paginationNumItemsInvalid' } });
  const page = await firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 200,
    paginationOpts: { numItems: 1_000, cursor: null },
  });
  expect(page.page).toHaveLength(200);
  expect(page.isDone).toBe(false);
});

test('listProviderDispatchDay refuses replaying a cursor under a different status filter', async () => {
  const f = await fixture('provider-dispatch-cursor-status');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const firm = await makeGrantedProvider(f, 'provider-dispatch-cursor-status-firm', 'Cursor Status Firm');
  const assignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: firm.providerId,
    position: 20,
  });
  await f.t.run(async (ctx) => ctx.db.patch(assignmentId, { executionStatus: 'assigned' }));
  const first = await firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 200,
    status: 'assigned',
    paginationOpts: { numItems: 1, cursor: null },
  });
  await expect(firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 200,
    status: 'unassigned',
    paginationOpts: { numItems: 1, cursor: first.continueCursor },
  })).rejects.toMatchObject({ data: { code: 'conflict' } });
});

test('listProviderDispatchDay refuses a linked Service whose Project column disagrees', async () => {
  const f = await fixture('provider-dispatch-service-project-invariant');
  const firm = await makeGrantedProvider(f, 'provider-dispatch-service-project-firm', 'Service Project Firm');
  const assignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: firm.providerId,
    position: 20,
  });
  const foreignProjectId = await f.t.run((ctx) => ctx.db.insert('projects', {
    organizationId: f.organizationId,
    name: 'Provider dispatch foreign Project',
    status: 'active',
  }));
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.serviceId, { projectId: foreignProjectId });
    // The Assignment stays in the requested Project index range; only the
    // authoritative linked Service is corrupted.
    await ctx.db.patch(assignmentId, { projectId: f.projectId });
  });
  await expect(firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 10,
    paginationOpts: firstPage,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listProviderDispatchDay refuses a linked Service whose organization column disagrees', async () => {
  const f = await fixture('provider-dispatch-service-organization-invariant');
  const firm = await makeGrantedProvider(f, 'provider-dispatch-service-org-firm', 'Service Organization Firm');
  await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: firm.providerId,
    position: 20,
  });
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Provider Dispatch Foreign Organization',
    slug: 'provider-dispatch-service-organization-foreign',
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { organizationId: foreignOrganizationId }));
  await expect(firm.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 10,
    paginationOpts: firstPage,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listProviderDispatchDay retains the fail-closed per-row Provider proof', () => {
  const sources = import.meta.glob('../convex/assignments/model.ts', { query: '?raw', import: 'default', eager: true });
  const source = Object.values(sources)[0] ?? '';
  const functionBody = source.slice(
    source.indexOf('export async function listProviderDispatchDay'),
    source.indexOf('async function paginateProviderDispatchAssignments'),
  );
  expect(functionBody).toContain('!principal.accessibleProviderIds.has(assignment.providerId)');
});

test('listProviderDispatchDay retains both linked Service ownership re-derivations', () => {
  const sources = import.meta.glob('../convex/assignments/model.ts', { query: '?raw', import: 'default', eager: true });
  const source = Object.values(sources)[0] ?? '';
  const functionBody = source.slice(
    source.indexOf('export async function listProviderDispatchDay'),
    source.indexOf('async function paginateProviderDispatchAssignments'),
  );
  expect(functionBody).toContain('service.projectId !== args.projectId');
  expect(functionBody).toContain('service.organizationId !== assignment.organizationId');
});

test('listProviderDispatchDay pagination loop retains an explicit iteration ceiling', () => {
  const sources = import.meta.glob('../convex/assignments/model.ts', { query: '?raw', import: 'default', eager: true });
  const source = Object.values(sources)[0] ?? '';
  const functionBody = source.slice(
    source.indexOf('async function paginateProviderDispatchAssignments'),
    source.indexOf('export async function dispatchDayReadiness'),
  );
  expect(functionBody).toContain('if (iterations > numItems) return conflict()');
});

test('listDispatchDay applies Provider and Cost Centre filters to each complete Service child set', async () => {
  const f = await fixture('dispatch-day-row-filters');
  const otherProviderId = await f.owner.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Dispatch Filter Provider',
  });
  const firstCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'dispatchFirst',
    name: 'Dispatch First',
  });
  const secondCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'dispatchSecond',
    name: 'Dispatch Second',
  });
  const secondServiceId = await insertFixtureService(f, {
    name: 'Dispatch filtered peer',
    startsAt: 2,
  });
  const secondAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: secondServiceId,
    providerId: otherProviderId,
    costCentreId: secondCostCentreId,
    position: 20,
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { costCentreId: firstCostCentreId }));

  const providerFiltered = await f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 10,
    providerId: otherProviderId,
    paginationOpts: firstPage,
  });
  expect(providerFiltered.page.flatMap((entry) => entry.rows.map((row) => row.assignment._id)))
    .toEqual([secondAssignmentId]);
  expect(providerFiltered.page, 'Services stay explicit even when their complete child set filters empty')
    .toHaveLength(2);

  const costCentreFiltered = await f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 10,
    costCentreId: firstCostCentreId,
    paginationOpts: firstPage,
  });
  expect(costCentreFiltered.page.flatMap((entry) => entry.rows.map((row) => row.assignment._id)))
    .toEqual([f.assignmentId]);
});

test('listDispatchDay checks Assignment ownership before applying a row filter', async () => {
  const f = await fixture('dispatch-filter-ownership-order');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Dispatch Filter Foreign Organization',
    slug: 'dispatch-filter-ownership-order-foreign',
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, {
    organizationId: foreignOrganizationId,
    executionStatus: 'unassigned',
  }));
  await expect(f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 10,
    status: 'assigned',
    paginationOpts: firstPage,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listDispatchDay refuses a Service whose tenant column disagrees with its Project', async () => {
  const f = await fixture('dispatch-service-organization-invariant');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Dispatch Service Foreign Organization',
    slug: 'dispatch-service-organization-invariant-foreign',
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.serviceId, { organizationId: foreignOrganizationId });
    await ctx.db.patch(f.assignmentId, { organizationId: foreignOrganizationId });
  });
  await expect(f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 10,
    paginationOpts: firstPage,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listDispatchDay rejects fractional page sizes and clamps oversized pages to 200 Services', async () => {
  const f = await fixture('dispatch-day-page-bound');
  await f.t.run(async (ctx) => {
    const base = await ctx.db.get(f.serviceId);
    if (base === null) throw new Error('Expected fixture Service');
    for (let index = 0; index < 200; index += 1) {
      await ctx.db.insert('services', {
        organizationId: base.organizationId,
        projectId: base.projectId,
        eventId: base.eventId,
        serviceKindId: base.serviceKindId,
        serviceKindVersionId: base.serviceKindVersionId,
        name: `Dispatch page bound ${index}`,
        status: 'draft',
        startsAt: 100 + index,
      });
    }
  });
  await expect(f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 1_000,
    paginationOpts: { numItems: 1.5, cursor: null },
  })).rejects.toMatchObject({ data: { code: 'paginationNumItemsInvalid' } });
  const page = await f.owner.client.query(listDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 1_000,
    paginationOpts: { numItems: 1_000, cursor: null },
  });
  expect(page.page).toHaveLength(200);
  expect(page.isDone).toBe(false);
});

test('listProviderDispatchDay keeps page-straddling Assignments flat and returns each exactly once', async () => {
  const f = await fixture('provider-dispatch-straddle');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const firm = await makeGrantedProvider(f, 'provider-dispatch-straddle-firm', 'Straddle Firm');
  const firstAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: firm.providerId,
    position: 20,
  });
  const secondAssignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: firm.providerId,
    position: 30,
  });
  let cursor: string | null = null;
  const assignmentIds: Id<'assignments'>[] = [];
  const serviceIds: Id<'services'>[] = [];
  const groupedClaims: boolean[] = [];
  for (;;) {
    const page: PaginationResult<ProviderDispatchAssignmentEntry> = await firm.client.query(listProviderDispatchDay, {
      projectId: f.projectId,
      from: 0,
      to: 200,
      paginationOpts: { numItems: 1, cursor },
    });
    for (const entry of page.page) {
      assignmentIds.push(entry.assignment._id);
      serviceIds.push(entry.service._id);
      groupedClaims.push(Object.hasOwn(entry, 'rows'));
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(assignmentIds).toEqual([firstAssignmentId, secondAssignmentId]);
  expect(new Set(assignmentIds).size).toBe(2);
  expect(serviceIds).toEqual([f.serviceId, f.serviceId]);
  // The strict public return validator rejects grouped response shapes first;
  // this model-level assertion remains useful documentation of the flat API.
  expect(groupedClaims).toEqual([false, false]);
});

test('listProviderDispatchDay merges two granted firms with a status filter and never exposes a third firm', async () => {
  const f = await fixture('provider-dispatch-multi-status');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const dispatcher = await provision(f.t, 'provider-dispatch-multi-status-user');
  const firmOrganizationId = await dispatcher.client.mutation(createOrganization, {
    name: 'Multi Status Firm',
    slug: 'provider-dispatch-multi-status-firm',
  });
  const providerAId = await f.owner.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Multi Status Provider A',
  });
  const providerBId = await f.owner.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Multi Status Provider B',
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(providerAId, { linkedOrganizationId: firmOrganizationId });
    await ctx.db.patch(providerBId, { linkedOrganizationId: firmOrganizationId });
  });
  await f.owner.client.mutation(grantProjectAccessToProvider, {
    projectId: f.projectId,
    providerId: providerAId,
  });
  await f.owner.client.mutation(grantProjectAccessToProvider, {
    projectId: f.projectId,
    providerId: providerBId,
  });
  const assignmentAId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: providerAId,
    position: 20,
  });
  const assignmentBId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: providerBId,
    position: 30,
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(assignmentAId, { executionStatus: 'assigned' });
    await ctx.db.patch(assignmentBId, { executionStatus: 'confirmed' });
    await ctx.db.patch(f.assignmentId, { executionStatus: 'assigned' });
  });

  const page = await dispatcher.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 200,
    status: 'assigned',
    paginationOpts: firstPage,
  });
  expect(page.page.map((entry) => entry.assignment._id)).toEqual([assignmentAId]);
  expect(page.continueCursor).not.toContain(String(f.providerId));
  expect(page).not.toHaveProperty('splitCursor');
  expect(page).not.toHaveProperty('pageStatus');
});

test('listProviderDispatchDay removes only the revoked firm row on the next dual-firm call', async () => {
  const f = await fixture('provider-dispatch-revocation');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const serviceBId = await insertFixtureService(f, { name: 'Firm B Service', startsAt: 200 });
  const dispatcher = await provision(f.t, 'provider-dispatch-dual-user');
  const firmAId = await dispatcher.client.mutation(createOrganization, {
    name: 'Dispatch Firm A',
    slug: 'provider-dispatch-dual-a',
  });
  const firmBId = await dispatcher.client.mutation(createOrganization, {
    name: 'Dispatch Firm B',
    slug: 'provider-dispatch-dual-b',
  });
  const providerAId = await f.owner.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Dispatch Provider A',
  });
  const providerBId = await f.owner.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Dispatch Provider B',
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(providerAId, { linkedOrganizationId: firmAId });
    await ctx.db.patch(providerBId, { linkedOrganizationId: firmBId });
  });
  const grantAId = await f.owner.client.mutation(grantProjectAccessToProvider, {
    projectId: f.projectId,
    providerId: providerAId,
  });
  await f.owner.client.mutation(grantProjectAccessToProvider, {
    projectId: f.projectId,
    providerId: providerBId,
  });
  await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: providerAId,
    position: 20,
  });
  await f.owner.client.mutation(createAssignment, {
    serviceId: serviceBId,
    providerId: providerBId,
    position: 30,
  });

  const queryDay = () => dispatcher.client.query(listProviderDispatchDay, {
    projectId: f.projectId,
    from: 0,
    to: 300,
    paginationOpts: firstPage,
  });
  expect((await queryDay()).page.map((entry) => entry.service._id), 'both live firms contribute their own Service')
    .toEqual([f.serviceId, serviceBId]);
  await f.owner.client.mutation(revokeProviderAccessGrant, { grantId: grantAId });
  expect((await queryDay()).page.map((entry) => entry.service._id), 'the revoked firm Service disappears immediately')
    .toEqual([serviceBId]);
});

test('listProviderDispatchDay pages two granted firms to exhaustion without loss or duplication', async () => {
  const f = await fixture('provider-dispatch-dual-pagination');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const dispatcher = await provision(f.t, 'provider-dispatch-dual-pagination-user');
  const firmOrganizationId = await dispatcher.client.mutation(createOrganization, {
    name: 'Dual Pagination Firm',
    slug: 'provider-dispatch-dual-pagination-firm',
  });
  const providerIds = await Promise.all(['A', 'B'].map(async (suffix) => {
    const providerId = await f.owner.client.mutation(createProvider, {
      organizationId: f.organizationId,
      name: `Dual Pagination Provider ${suffix}`,
    });
    await f.t.run(async (ctx) => ctx.db.patch(providerId, { linkedOrganizationId: firmOrganizationId }));
    await f.owner.client.mutation(grantProjectAccessToProvider, {
      projectId: f.projectId,
      providerId,
    });
    return providerId;
  }));
  const expected: Id<'assignments'>[] = [];
  for (const [providerId, position] of [
    [providerIds[0], 20], [providerIds[1], 21], [providerIds[0], 30], [providerIds[1], 31],
  ] as const) {
    if (providerId === undefined) throw new Error('Expected Provider id');
    expected.push(await f.owner.client.mutation(createAssignment, {
      serviceId: f.serviceId,
      providerId,
      position,
    }));
  }

  let cursor: string | null = null;
  const seen: Id<'assignments'>[] = [];
  for (;;) {
    const page: PaginationResult<ProviderDispatchAssignmentEntry> = await dispatcher.client.query(listProviderDispatchDay, {
      projectId: f.projectId,
      from: 0,
      to: 200,
      paginationOpts: { numItems: 1, cursor },
    });
    const parsedCursor = JSON.parse(page.continueCursor) as { ranges?: { providerId?: string }[] };
    expect(parsedCursor.ranges?.map((range) => range.providerId), 'cursor ranges use canonical Provider-id order')
      .toEqual([...providerIds].map(String).sort((left, right) => left.localeCompare(right)));
    seen.push(...page.page.map((entry) => entry.assignment._id));
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(new Set(seen), 'every row appears exactly once across dual-firm pages').toEqual(new Set(expected));
  expect(seen).toHaveLength(expected.length);
});

test('dispatchDayReadiness counts only the half-open Service window', async () => {
  const f = await fixture('dispatch-readiness-window');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const assignedServiceId = await insertFixtureService(f, { name: 'Assigned inside', startsAt: 200 });
  const secondAssignedServiceId = await insertFixtureService(f, { name: 'Second assigned inside', startsAt: 250 });
  const lowerOutsideId = await insertFixtureService(f, { name: 'Readiness lower outside', startsAt: 99 });
  const upperOutsideId = await insertFixtureService(f, { name: 'Readiness upper outside', startsAt: 300 });
  await f.t.run(async (ctx) => {
    for (const [serviceId, position, executionStatus] of [
      [assignedServiceId, 20, 'assigned'],
      [secondAssignedServiceId, 25, 'assigned'],
      [lowerOutsideId, 30, 'unassigned'],
      [upperOutsideId, 40, 'unassigned'],
    ] as const) {
      await ctx.db.insert('assignments', {
        organizationId: f.organizationId,
        serviceId,
        projectId: f.projectId,
        providerId: f.providerId,
        position,
        executionStatus,
      });
    }
  });
  expect(await f.owner.client.query(dispatchDayReadiness, {
    projectId: f.projectId,
    from: 100,
    to: 300,
  }), 'readiness counts Assignments only under Services in the requested window')
    .toEqual({ unassigned: 1, total: 3, complete: true });
});

test('Event-scoped dispatch boards include from and exclude to', async () => {
  const f = await fixture('dispatch-event-window-boundaries');
  await f.t.run(async (ctx) => ctx.db.patch(f.serviceId, { startsAt: 100 }));
  const insideId = await insertFixtureService(f, { name: 'Event inside', startsAt: 200 });
  const toId = await insertFixtureService(f, { name: 'Event at to', startsAt: 300 });
  await insertFixtureService(f, { name: 'Event before', startsAt: 99 });
  await insertFixtureService(f, { name: 'Event after', startsAt: 301 });
  await f.t.run(async (ctx) => {
    for (const [serviceId, position] of [[insideId, 20], [toId, 30]] as const) {
      await ctx.db.insert('assignments', {
        organizationId: f.organizationId,
        serviceId,
        projectId: f.projectId,
        providerId: f.providerId,
        position,
        executionStatus: 'assigned',
      });
    }
  });
  const args = { projectId: f.projectId, eventId: f.eventId, from: 100, to: 300 };
  const board = await f.owner.client.query(listDispatchDay, { ...args, paginationOpts: firstPage });
  expect(board.page.map((entry) => entry.service._id)).toEqual([f.serviceId, insideId]);
  expect(await f.owner.client.query(dispatchDayReadiness, args))
    .toEqual({ unassigned: 1, total: 2, complete: true });
});

test('Event-scoped dispatch boards refuse an Event whose organization disagrees with its Project', async () => {
  const f = await fixture('dispatch-event-organization-invariant');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Dispatch Event Foreign Organization',
    slug: 'dispatch-event-organization-invariant-foreign',
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.eventId, { organizationId: foreignOrganizationId }));
  const args = { projectId: f.projectId, eventId: f.eventId, from: 0, to: 10 };
  await expect(f.owner.client.query(listDispatchDay, { ...args, paginationOpts: firstPage }))
    .rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.owner.client.query(dispatchDayReadiness, args))
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('dispatchDayReadiness refuses a Service whose organization disagrees with its Event', async () => {
  const f = await fixture('dispatch-readiness-service-organization-invariant');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Readiness Service Foreign Organization',
    slug: 'dispatch-readiness-service-organization-foreign',
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.serviceId, { organizationId: foreignOrganizationId });
    await ctx.db.patch(f.assignmentId, { organizationId: foreignOrganizationId });
  });
  await expect(f.owner.client.query(dispatchDayReadiness, {
    projectId: f.projectId,
    eventId: f.eventId,
    from: 0,
    to: 10,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('dispatchDayReadiness refuses an Assignment whose organization disagrees with its Service', async () => {
  const f = await fixture('dispatch-readiness-assignment-organization-invariant');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Readiness Assignment Foreign Organization',
    slug: 'dispatch-readiness-assignment-organization-foreign',
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { organizationId: foreignOrganizationId }));
  await expect(f.owner.client.query(dispatchDayReadiness, {
    projectId: f.projectId,
    from: 0,
    to: 10,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('dispatchDayReadiness refuses an Assignment whose Project disagrees with its Service', async () => {
  const f = await fixture('dispatch-readiness-assignment-project-invariant');
  const foreignProjectId = await f.t.run((ctx) => ctx.db.insert('projects', {
    organizationId: f.organizationId,
    name: 'Readiness Assignment Foreign Project',
    status: 'active',
  }));
  await f.t.run(async (ctx) => ctx.db.patch(f.assignmentId, { projectId: foreignProjectId }));
  await expect(f.owner.client.query(dispatchDayReadiness, {
    projectId: f.projectId,
    from: 0,
    to: 10,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('dispatchDayReadiness marks a count incomplete when more than 500 Services are in the day', async () => {
  const f = await fixture('dispatch-readiness-cap');
  await f.t.run(async (ctx) => {
    const base = await ctx.db.get(f.serviceId);
    if (base === null) throw new Error('Expected fixture Service');
    for (let index = 0; index < 501; index += 1) {
      const serviceId = await ctx.db.insert('services', {
        organizationId: base.organizationId,
        projectId: base.projectId,
        eventId: base.eventId,
        serviceKindId: base.serviceKindId,
        serviceKindVersionId: base.serviceKindVersionId,
        name: `Readiness capped ${index}`,
        status: 'draft',
        startsAt: 1_000 + index,
      });
      await ctx.db.insert('assignments', {
        organizationId: f.organizationId,
        serviceId,
        projectId: f.projectId,
        providerId: f.providerId,
        position: 10,
        executionStatus: 'unassigned',
      });
    }
  });
  expect(await f.owner.client.query(dispatchDayReadiness, {
    projectId: f.projectId,
    from: 1_000,
    to: 2_000,
  }), '501 Services make the bounded readiness count explicitly incomplete')
    .toEqual({ unassigned: 500, total: 500, complete: false });
});

test('dispatchDayReadiness marks a count incomplete when the total Assignment budget is exceeded', async () => {
  const f = await fixture('dispatch-readiness-assignment-cap');
  await f.t.run(async (ctx) => {
    const base = await ctx.db.get(f.serviceId);
    if (base === null) throw new Error('Expected fixture Service');
    await ctx.db.patch(f.assignmentId, { executionStatus: 'unassigned' });
    let inserted = 1;
    let serviceNumber = 0;
    while (inserted <= 5_000) {
      const serviceId = serviceNumber === 0
        ? f.serviceId
        : await ctx.db.insert('services', {
            organizationId: base.organizationId,
            projectId: base.projectId,
            eventId: base.eventId,
            serviceKindId: base.serviceKindId,
            serviceKindVersionId: base.serviceKindVersionId,
            name: `Readiness Assignment capped ${serviceNumber}`,
            status: 'draft',
            startsAt: 1_000 + serviceNumber,
          });
      const startingPosition = serviceNumber === 0 ? 1 : 0;
      for (
        let position = startingPosition;
        position < 200 && inserted <= 5_000;
        position += 1
      ) {
        await ctx.db.insert('assignments', {
          organizationId: f.organizationId,
          serviceId,
          projectId: f.projectId,
          providerId: f.providerId,
          position,
          executionStatus: inserted % 2 === 0 ? 'assigned' : 'unassigned',
        });
        inserted += 1;
      }
      serviceNumber += 1;
    }
  });
  const result = await f.owner.client.query(dispatchDayReadiness, {
    projectId: f.projectId,
    from: 0,
    to: 2_000,
  });
  expect(result.complete).toBe(false);
  expect(result.total).toBe(5_000);
});

test('Event-scoped dispatch reads refuse a Service whose denormalized Project disagrees with its Event', async () => {
  const f = await fixture('dispatch-event-project-invariant');
  const foreignProjectId = await f.t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', {
      organizationId: f.organizationId,
      name: 'Same tenant foreign Project',
      status: 'active',
    });
    await ctx.db.patch(f.serviceId, { projectId, startsAt: 100 });
    await ctx.db.patch(f.assignmentId, { projectId });
    return projectId;
  });
  expect(foreignProjectId).not.toBe(f.projectId);
  const args = {
    projectId: f.projectId,
    eventId: f.eventId,
    from: 0,
    to: 200,
  };
  await expect(f.owner.client.query(listDispatchDay, {
    ...args,
    paginationOpts: firstPage,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(f.owner.client.query(dispatchDayReadiness, args))
    .rejects.toMatchObject({ data: { code: inaccessible } });
});

test('unauthenticated Assignment reads and writes refuse real and fabricated ids identically before lookup', async () => {
  const f = await fixture('assignment-unauthenticated');
  const realRevisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  const gone = await f.t.run(async (ctx) => {
    const service = await ctx.db.get(f.serviceId);
    if (service === null) throw new Error('Expected fixture Service');
    const goneServiceId = await ctx.db.insert('services', {
      organizationId: service.organizationId,
      projectId: service.projectId,
      eventId: service.eventId,
      serviceKindId: service.serviceKindId,
      serviceKindVersionId: service.serviceKindVersionId,
      name: 'Gone Service',
      status: 'draft',
      startsAt: 2,
    });
    const goneProjectId = await ctx.db.insert('projects', {
      organizationId: f.organizationId,
      name: 'Gone Project',
      status: 'active',
    });
    const goneAssignmentId = await ctx.db.insert('assignments', {
      organizationId: f.organizationId,
      serviceId: f.serviceId,
      projectId: f.projectId,
      providerId: f.providerId,
      position: 99,
      executionStatus: 'unassigned',
    });
    const goneRevisionId = await ctx.db.insert('assignmentRevisions', {
      organizationId: f.organizationId,
      assignmentId: goneAssignmentId,
      revisionNumber: 1,
      status: 'draft',
      vehicleClassId: f.vehicleClassId,
      modality: 'disposition',
      quantity: 1,
      rateCardVersionId: f.rateCardVersionId,
      rateLineId: f.rateLineId,
      unitAmount: 12_345,
      currency: 'COP',
      lineTotal: 12_345,
    });
    await ctx.db.delete(goneRevisionId);
    await ctx.db.delete(goneAssignmentId);
    await ctx.db.delete(goneServiceId);
    await ctx.db.delete(goneProjectId);
    return { goneProjectId, goneServiceId, goneAssignmentId, goneRevisionId };
  });

  const pairs = [
    [
      () => f.t.query(resolveAssignmentRate, {
        serviceId: f.serviceId,
        providerId: f.providerId,
        vehicleClassId: f.vehicleClassId,
        modality: 'disposition',
      }),
      () => f.t.query(resolveAssignmentRate, {
        serviceId: gone.goneServiceId,
        providerId: f.providerId,
        vehicleClassId: f.vehicleClassId,
        modality: 'disposition',
      }),
    ],
    [
      () => f.t.query(listServiceAssignmentRows, { serviceId: f.serviceId }),
      () => f.t.query(listServiceAssignmentRows, { serviceId: gone.goneServiceId }),
    ],
    // `listServiceAssignments` predates #74 and was never in this list. Deleting
    // its `requireAuthenticatedUser` survived the whole suite, exactly as the two
    // #74 queries did, so the same anonymous oracle was already shipped here: a
    // real Service id answered `unauthenticated` while a fabricated one answered
    // `notFoundOrInaccessible`. Every public door that reads a caller-supplied id
    // belongs in this list, not only the ones a current issue happens to touch.
    [
      () => f.t.query(listServiceAssignments, { serviceId: f.serviceId }),
      () => f.t.query(listServiceAssignments, { serviceId: gone.goneServiceId }),
    ],
    [
      () => f.t.query(listDispatchDay, {
        projectId: f.projectId,
        from: 0,
        to: 10,
        paginationOpts: firstPage,
      }),
      () => f.t.query(listDispatchDay, {
        projectId: gone.goneProjectId,
        from: 0,
        to: 10,
        paginationOpts: firstPage,
      }),
    ],
    [
      () => f.t.query(listProviderDispatchDay, {
        projectId: f.projectId,
        from: 0,
        to: 10,
        paginationOpts: firstPage,
      }),
      () => f.t.query(listProviderDispatchDay, {
        projectId: gone.goneProjectId,
        from: 0,
        to: 10,
        paginationOpts: firstPage,
      }),
    ],
    [
      () => f.t.query(dispatchDayReadiness, { projectId: f.projectId, from: 0, to: 10 }),
      () => f.t.query(dispatchDayReadiness, { projectId: gone.goneProjectId, from: 0, to: 10 }),
    ],
    [
      () => f.t.mutation(createAssignment, { serviceId: f.serviceId, providerId: f.providerId, position: 20 }),
      () => f.t.mutation(createAssignment, { serviceId: gone.goneServiceId, providerId: f.providerId, position: 20 }),
    ],
    [
      () => f.t.mutation(createAssignmentRevision, f.revisionArgs),
      () => f.t.mutation(createAssignmentRevision, { ...f.revisionArgs, assignmentId: gone.goneAssignmentId }),
    ],
    [
      () => f.t.mutation(acceptAssignmentRevision, { revisionId: realRevisionId }),
      () => f.t.mutation(acceptAssignmentRevision, { revisionId: gone.goneRevisionId }),
    ],
    [
      () => f.t.mutation(declineAssignmentRevision, { revisionId: realRevisionId, reason: 'no' }),
      () => f.t.mutation(declineAssignmentRevision, { revisionId: gone.goneRevisionId, reason: 'no' }),
    ],
    [
      () => f.t.mutation(removeAssignment, { assignmentId: f.assignmentId }),
      () => f.t.mutation(removeAssignment, { assignmentId: gone.goneAssignmentId }),
    ],
  ] as const;
  for (const [realCall, fabricatedCall] of pairs) {
    const real = await refusal(realCall());
    const fabricated = await refusal(fabricatedCall());
    expect(fabricated).toEqual(real);
    expect(real.data).toEqual({ code: 'unauthenticated' });
  }
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
  const projectRows = await dispatcher.client.query(listProjectAssignments, {
    projectId: f.projectId,
    paginationOpts: firstPage,
  });
  expect(projectRows.page.map((row) => row._id)).toEqual([assignmentAId, assignmentBId]);
  expect(await dispatcher.client.query(listServiceAssignments, { serviceId: f.serviceId }))
    .toMatchObject([{ _id: assignmentAId }, { _id: assignmentBId }]);

  // The dispatch queue is the only Assignment read path that keys a SINGLE-firm
  // Provider straight into an index and falls back to a post-read filter for a
  // dual-firm one. Both halves of that branch need proving: the union must be
  // complete (firm B is not lost) and it must still exclude the fixture's own
  // ungranted Provider.
  const queue = await dispatcher.client.query(assignmentsAwaitingDispatch, {
    projectId: f.projectId,
    statuses: ['unassigned'],
    paginationOpts: firstPage,
  });
  expect(queue.page.map((row) => row._id)).toEqual([assignmentAId, assignmentBId]);
  for (const row of queue.page) expectNoForbiddenProviderKeys(row);
});

/**
 * Every column the Provider arm may read, as a closed set. Asserting the whole
 * key set — rather than only that `costCentreId` is absent — is what makes
 * `providerAssignmentView` testable in both directions: it fails if a forbidden
 * column starts riding along, AND it fails if an optional column a Provider
 * legitimately needs is silently dropped. The compiler only catches a new
 * REQUIRED column, so optional ones are exactly the class that needs this.
 */
function expectNoForbiddenProviderKeys(row: object): void {
  expect(Object.keys(row).filter((key) => !providerAssignmentKeys.includes(key))).toEqual([]);
  // A row that simply lacks the forbidden columns passes the check above for
  // the wrong reason, so require it to be a real Assignment row first: this is
  // what makes the assertion bite on a call site that forgot to project.
  expect(Object.keys(row)).toEqual(expect.arrayContaining([
    '_id', '_creationTime', 'organizationId', 'serviceId', 'projectId', 'providerId', 'position', 'executionStatus',
  ]));
}

const providerAssignmentKeys = [
  '_creationTime',
  '_id',
  'completedAt',
  'currentRevisionId',
  'dispatchedAt',
  'driverName',
  'driverPhone',
  'executionStatus',
  'fleetVehicleId',
  'notes',
  'notExecutedReason',
  'organizationId',
  'position',
  'projectId',
  'providerId',
  'serviceId',
  'vehiclePlateOverride',
];

test('a granted Provider receives its Assignment without the charge attribution', async () => {
  const f = await fixture('assignment-cost-centre-confinement');
  const firm = await grantFixtureProvider(f, 'assignment-confinement-firm', 'Confinement Firm');
  const costCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'confinedCharge',
    name: 'Confined charge',
  });
  await f.owner.client.mutation(updateEvent, { eventId: f.eventId, clientCostCentreId: costCentreId });
  const assignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 20,
    notes: 'confined supply line',
  });
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    assignmentId,
  });
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId });

  // The attribution must genuinely reach all three coordinator surfaces, or
  // every negative below would pass against a projection that returns nothing
  // and against a write path that never stored the value.
  expect(await f.owner.client.query(getAssignment, { assignmentId }))
    .toMatchObject({ costCentreId });
  expect(await f.owner.client.query(listServiceAssignments, { serviceId: f.serviceId }))
    .toEqual(expect.arrayContaining([expect.objectContaining({ _id: assignmentId, costCentreId })]));
  expect((await f.owner.client.query(listProjectAssignments, { projectId: f.projectId, paginationOpts: firstPage })).page)
    .toEqual(expect.arrayContaining([expect.objectContaining({ _id: assignmentId, costCentreId })]));

  // The Provider sees the row, keeps everything it is entitled to, and loses
  // exactly one column.
  const providerRow = await firm.client.query(getAssignment, { assignmentId });
  expectNoForbiddenProviderKeys(providerRow);
  expect(providerRow).toMatchObject({
    _id: assignmentId,
    providerId: f.providerId,
    position: 20,
    notes: 'confined supply line',
    currentRevisionId: revisionId,
  });

  const serviceRows = await firm.client.query(listServiceAssignments, { serviceId: f.serviceId });
  expect(serviceRows.map((row) => row._id)).toEqual([f.assignmentId, assignmentId]);
  const projectRows = await firm.client.query(listProjectAssignments, {
    projectId: f.projectId,
    paginationOpts: firstPage,
  });
  expect(projectRows.page.map((row) => row._id)).toEqual([f.assignmentId, assignmentId]);
  for (const row of [...serviceRows, ...projectRows.page]) {
    expectNoForbiddenProviderKeys(row);
  }
});

test('the Provider Project list narrows every page while paging to the end', async () => {
  const f = await fixture('assignment-cost-centre-paged');
  const firm = await grantFixtureProvider(f, 'assignment-paged-firm', 'Paged Firm');
  const costCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'pagedCharge',
    name: 'Paged charge',
  });
  await f.owner.client.mutation(updateEvent, { eventId: f.eventId, clientCostCentreId: costCentreId });
  const expected: Id<'assignments'>[] = [f.assignmentId];
  for (const position of [20, 30]) {
    expected.push(await f.owner.client.mutation(createAssignment, {
      serviceId: f.serviceId,
      providerId: f.providerId,
      position,
    }));
  }

  // One row per page, so the projection wrapper has to preserve the cursor and
  // `isDone` it rebuilds — a wrapper that mangles either would truncate the
  // Provider's list to its first row with no other test noticing.
  const seen: Id<'assignments'>[] = [];
  let cursor: string | null = null;
  for (let request = 0; request < 5; request += 1) {
    const page: PaginationResult<Doc<'assignments'>> = await firm.client.query(listProjectAssignments, {
      projectId: f.projectId,
      paginationOpts: { numItems: 1, cursor },
    });
    for (const row of page.page) {
      seen.push(row._id);
      expectNoForbiddenProviderKeys(row);
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(seen).toEqual(expected);
});

test('a granted Provider cannot reach the audit log that records the attribution', async () => {
  const f = await fixture('assignment-cost-centre-audit');
  const firm = await grantFixtureProvider(f, 'assignment-audit-firm', 'Audit Firm');
  const costCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'auditedCharge',
    name: 'Audited charge',
  });
  const assignmentId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    costCentreId,
    position: 20,
  });

  // The attribution is materialized once and no path rewrites it, so this row
  // is the only place the log can answer who a movement was charged to.
  const recorded = await f.owner.client.query(listEntityAuditEvents, {
    organizationId: f.organizationId,
    entityType: 'assignment',
    entityId: assignmentId,
    paginationOpts: firstPage,
  });
  expect(recorded.page.map((event) => event.metadata))
    .toEqual([expect.objectContaining({ costCentreId })]);

  // The log is the second channel the same value travels on, so the Provider
  // arm is refused on both queries...
  for (const refused of [
    firm.client.query(listOrganizationAuditEvents, { organizationId: f.organizationId, paginationOpts: firstPage }),
    firm.client.query(listEntityAuditEvents, {
      organizationId: f.organizationId,
      entityType: 'assignment',
      entityId: assignmentId,
      paginationOpts: firstPage,
    }),
  ]) {
    await expect(refused).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  // ...including the substitution where the role gate legitimately passes,
  // because the firm really is owner of its OWN organization.
  expect((await firm.client.query(listEntityAuditEvents, {
    organizationId: firm.firmOrganizationId,
    entityType: 'assignment',
    entityId: assignmentId,
    paginationOpts: firstPage,
  })).page).toEqual([]);
});

test('inheritance re-proves the Event belongs to the Service tenant', async () => {
  const f = await fixture('assignment-cost-centre-foreign-event');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign Event organization',
    slug: 'assignment-foreign-event',
  });
  const foreign = await insertService(f.t, foreignOrganizationId, 'assignment-foreign-event');
  // Unreachable through any public mutation — `service.eventId` has one writer,
  // behind a gate that already proves this. Fabricated directly so the I4
  // re-proof is pinned before some future re-parenting path makes it reachable,
  // at which point it would otherwise stamp a foreign Cost Centre onto a local
  // Assignment that no update path exists to correct.
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.serviceId, { eventId: foreign.eventId });
  });

  await expect(f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 20,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('a caller-supplied Cost Centre is proven before any lifecycle state is revealed', async () => {
  const f = await fixture('assignment-cost-centre-ordering');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Ordering Cost Centre organization',
    slug: 'assignment-cost-centre-ordering',
  });
  const foreignCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: foreignOrganizationId,
    key: 'orderingCharge',
    name: 'Ordering charge',
  });

  // Position 10 is already taken by the fixture, so a caller who supplies both
  // a foreign Cost Centre and a colliding position must learn nothing about
  // the collision: the reference is proven first, generically.
  await expect(f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    costCentreId: foreignCostCentreId,
    position: 10,
  })).rejects.toMatchObject({ data: { code: inaccessible } });

  // Same rule against a Service whose lifecycle would otherwise refuse the write.
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'cancelled' });
  await expect(f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    costCentreId: foreignCostCentreId,
    position: 20,
  })).rejects.toMatchObject({ data: { code: inaccessible } });
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

test('Assignment position is unique within one Service but reusable by a different Service', async () => {
  const f = await fixture('assignment-position-unique');
  await expect(f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 10,
  })).rejects.toMatchObject({ data: { code: 'conflict' } });

  const otherService = await insertService(f.t, f.organizationId, 'assignment-position-other-service');
  await expect(f.owner.client.mutation(createAssignment, {
    serviceId: otherService.serviceId,
    providerId: f.providerId,
    position: 10,
  })).resolves.toBeDefined();
});

test('archived Provider and Vehicle Class inputs are refused when creating a Revision', async () => {
  const providerFixture = await fixture('assignment-archived-provider-input');
  await providerFixture.owner.client.mutation(archiveProvider, { providerId: providerFixture.providerId });
  await expect(providerFixture.owner.client.mutation(createAssignmentRevision, providerFixture.revisionArgs))
    .rejects.toMatchObject({ data: { code: inaccessible } });

  const classFixture = await fixture('assignment-archived-class-input');
  await classFixture.owner.client.mutation(archiveVehicleClass, { vehicleClassId: classFixture.vehicleClassId });
  await expect(classFixture.owner.client.mutation(createAssignmentRevision, classFixture.revisionArgs))
    .rejects.toMatchObject({ data: { code: inaccessible } });
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
  const thirdId = await f.owner.client.mutation(createAssignmentRevision, { ...f.revisionArgs, quantity: 5 });
  await f.owner.client.mutation(declineAssignmentRevision, { revisionId: thirdId, reason: 'declined' });
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
      'assignmentRevision.created',
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

test('execution preconditions validate vehicle sources, driver, Fleet Vehicle ownership, and Service readiness', async () => {
  const f = await fixture('assignment-execution-preconditions');
  const ownFleetVehicleId = await f.owner.client.mutation(createFleetVehicle, {
    organizationId: f.organizationId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    plate: 'OWN 100',
  });
  const archivedFleetVehicleId = await f.owner.client.mutation(createFleetVehicle, {
    organizationId: f.organizationId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    plate: 'OLD 100',
  });
  await f.owner.client.mutation(archiveFleetVehicle, { fleetVehicleId: archivedFleetVehicleId });
  const otherProviderId = await f.owner.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Other execution Provider',
  });
  const otherProviderVehicleId = await f.owner.client.mutation(createFleetVehicle, {
    organizationId: f.organizationId,
    providerId: otherProviderId,
    vehicleClassId: f.vehicleClassId,
    plate: 'RIV 100',
  });
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign execution organization',
    slug: 'foreign-execution-org',
  });
  const foreignProviderId = await f.owner.client.mutation(createProvider, {
    organizationId: foreignOrganizationId,
    name: 'Foreign execution Provider',
  });
  const foreignClassId = await f.owner.client.mutation(createVehicleClass, {
    organizationId: foreignOrganizationId,
    key: 'foreignExecutionClass',
    name: 'Foreign execution class',
  });
  const foreignVehicleId = await f.owner.client.mutation(createFleetVehicle, {
    organizationId: foreignOrganizationId,
    providerId: foreignProviderId,
    vehicleClassId: foreignClassId,
    plate: 'FOR 100',
  });

  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
  })).rejects.toMatchObject({ data: { code: 'assignmentExecutionVehicleInvalid' } });
  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
    fleetVehicleId: ownFleetVehicleId,
    vehiclePlateOverride: 'SUB 100',
  })).rejects.toMatchObject({ data: { code: 'assignmentExecutionVehicleInvalid' } });
  for (const fleetVehicleId of [foreignVehicleId, archivedFleetVehicleId, otherProviderVehicleId]) {
    await expect(f.owner.client.mutation(transitionAssignmentExecution, {
      assignmentId: f.assignmentId,
      status: 'assigned',
      fleetVehicleId,
    })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
    fleetVehicleId: ownFleetVehicleId,
  });
  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'confirmed',
  })).rejects.toMatchObject({ data: { code: 'assignmentExecutionDriverRequired' } });
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'confirmed',
    driverName: '  María Pérez  ',
    driverPhone: '  +57 300 000 0000  ',
  });
  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'dispatched',
  })).rejects.toMatchObject({ data: { code: 'assignmentExecutionServiceNotConfirmed' } });
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'planned' });
  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'dispatched',
  })).rejects.toMatchObject({ data: { code: 'assignmentExecutionServiceNotConfirmed' } });
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'confirmed' });
  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'dispatched',
  })).resolves.toBeNull();
  await f.owner.client.mutation(archiveFleetVehicle, { fleetVehicleId: ownFleetVehicleId });
  await expect(f.owner.client.mutation(deleteFleetVehicle, {
    fleetVehicleId: ownFleetVehicleId,
  })).rejects.toMatchObject({ data: { code: 'fleetVehicleDeleteBlocked' } });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({
    executionStatus: 'dispatched',
    fleetVehicleId: ownFleetVehicleId,
    driverName: 'María Pérez',
    driverPhone: '+57 300 000 0000',
    dispatchedAt: expect.any(Number),
  });
});

test('operator and Provider execution access cannot cross the member-only adjustment gate', async () => {
  const f = await fixture('assignment-execution-security');
  const operator = await provision(f.t, 'assignment-execution-operator');
  await f.owner.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: operator.userId,
    role: 'operator',
  });
  await expect(operator.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
    vehiclePlateOverride: 'OP 100',
  })).resolves.toBeNull();
  await expect(operator.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    additionalCharges: 100,
  })).rejects.toMatchObject({ data: { code: inaccessible } });

  const firm = await grantFixtureProvider(f, 'assignment-security-firm', 'Security Firm');
  await expect(firm.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'confirmed',
    driverName: 'Provider Driver',
    driverPhone: '+57 311 111 1111',
  })).resolves.toBeNull();
  await expect(firm.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    additionalCharges: 999_999,
  })).rejects.toMatchObject({ data: { code: inaccessible } });

  const viewer = await provision(f.t, 'assignment-execution-viewer');
  await f.owner.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: viewer.userId,
    role: 'viewer',
  });
  for (const call of [
    viewer.client.mutation(transitionAssignmentExecution, {
      assignmentId: f.assignmentId,
      status: 'dispatched',
    }),
    viewer.client.mutation(recordAssignmentAdjustments, {
      assignmentId: f.assignmentId,
      additionalCharges: 1,
    }),
  ]) await expect(call).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('ungranted, revoked, and differently scoped Providers are refused on both execution mutations', async () => {
  for (const scenario of ['ungranted', 'revoked', 'differentProject'] as const) {
    const f = await fixture(`assignment-execution-${scenario}`);
    const firm = await provision(f.t, `assignment-execution-${scenario}-firm`);
    const firmOrganizationId = await firm.client.mutation(createOrganization, {
      name: `${scenario} firm`,
      slug: `assignment-${scenario.toLowerCase()}-firm`,
    });
    await f.t.run(async (ctx) => ctx.db.patch(f.providerId, { linkedOrganizationId: firmOrganizationId }));
    if (scenario === 'revoked') {
      const grantId = await f.owner.client.mutation(grantProjectAccessToProvider, {
        projectId: f.projectId,
        providerId: f.providerId,
      });
      await f.owner.client.mutation(revokeProviderAccessGrant, { grantId });
    }
    if (scenario === 'differentProject') {
      const other = await insertService(f.t, f.organizationId, `${scenario} other`);
      await f.owner.client.mutation(grantProjectAccessToProvider, {
        projectId: other.projectId,
        providerId: f.providerId,
      });
    }
    for (const call of [
      firm.client.mutation(transitionAssignmentExecution, {
        assignmentId: f.assignmentId,
        status: 'assigned',
        vehiclePlateOverride: 'NO 100',
      }),
      firm.client.mutation(recordAssignmentAdjustments, {
        assignmentId: f.assignmentId,
        additionalCharges: 1,
      }),
    ]) await expect(call).rejects.toMatchObject({ data: { code: inaccessible } });
  }
});

test('adjustments require accepted terms, reject a negative net, and never patch the accepted Revision', async () => {
  const f = await fixture('assignment-adjustments');
  await expect(f.owner.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    additionalCharges: 100,
  })).rejects.toMatchObject({ data: { code: 'assignmentAcceptedRevisionRequired' } });
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId });
  const before = await f.owner.client.query(getAssignmentRevision, { revisionId });
  await expect(f.owner.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    notExecutedAmount: before.lineTotal + 1,
  })).rejects.toMatchObject({ data: { code: 'moneyAmountNegative' } });
  await f.owner.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    notExecutedAmount: 500,
    additionalCharges: 750,
    additionalDetail: '  Peaje adicional  ',
  });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId })).toMatchObject({
    notExecutedAmount: 500,
    additionalCharges: 750,
    additionalDetail: 'Peaje adicional',
  });
  const after = await f.owner.client.query(getAssignmentRevision, { revisionId });
  expect({ lineTotal: after.lineTotal, unitAmount: after.unitAmount, currency: after.currency })
    .toEqual({ lineTotal: before.lineTotal, unitAmount: before.unitAmount, currency: before.currency });
});

test('a cancelled Service still records that a movement did not happen and what it cost', async () => {
  const f = await fixture('assignment-execution-cancelled-billing');
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId });
  const strandedId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 40,
  });
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'cancelled' });

  // Everything else about the Assignment is frozen...
  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
    vehiclePlateOverride: 'CAN 200',
  })).rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });

  // ...but the two writes that record the cancellation itself must stay open,
  // or a service cancelled at 03:00 strands its Assignments and its fee.
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'notExecuted',
    notExecutedReason: 'Cancelled by the client overnight',
  });
  await f.owner.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    notExecutedAmount: 1_000,
  });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId }))
    .toMatchObject({ executionStatus: 'notExecuted', notExecutedAmount: 1_000 });
  // Each terminal has its own audit action; without this only the two mid-lifecycle
  // ones are ever asserted.
  expect((await f.owner.client.query(listEntityAuditEvents, {
    organizationId: f.organizationId,
    entityType: 'assignment',
    entityId: f.assignmentId,
    paginationOpts: firstPage,
  })).page.map((event) => event.action)).toContain('assignment.notExecuted');

  // The Project freeze is the boundary that does apply — to BOTH of the writes
  // the cancelled Service still allows, not just the money one.
  await f.owner.client.mutation(archiveProject, { projectId: f.projectId });
  await expect(f.owner.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    additionalCharges: 5,
  })).rejects.toMatchObject({ data: { code: 'serviceProjectReadOnly' } });
  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: strandedId,
    status: 'notExecuted',
    notExecutedReason: 'Too late',
  })).rejects.toMatchObject({ data: { code: 'serviceProjectReadOnly' } });
});

test('a not-executed reason is bounded and never rides along on another transition', async () => {
  const f = await fixture('assignment-execution-reason-bound');
  // Without a bound HERE, any holder of writeExecution — a granted Provider
  // included — writes an unbounded string onto the coordinator's row through a
  // transition whose own gate never inspects the reason.
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
    vehiclePlateOverride: 'RSN 100',
    notExecutedReason: 'x'.repeat(5_000),
  });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId }))
    .not.toHaveProperty('notExecutedReason');

  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'notExecuted',
    notExecutedReason: 'x'.repeat(1_001),
  })).rejects.toMatchObject({ data: { code: 'assignmentNotExecutedReasonInvalid' } });
});

test('every caller-supplied execution text is trimmed and bounded', async () => {
  const f = await fixture('assignment-execution-text-bounds');
  const cases = [
    { field: 'vehiclePlateOverride', value: 'P'.repeat(33), code: 'assignmentVehiclePlateOverrideInvalid' },
    { field: 'vehiclePlateOverride', value: '   ', code: 'assignmentVehiclePlateOverrideInvalid' },
    { field: 'driverName', value: 'D'.repeat(201), code: 'assignmentExecutionDriverRequired' },
    { field: 'driverPhone', value: '9'.repeat(65), code: 'assignmentExecutionDriverPhoneInvalid' },
  ];
  for (const { field, value, code } of cases) {
    await expect(f.owner.client.mutation(transitionAssignmentExecution, {
      assignmentId: f.assignmentId,
      status: 'assigned',
      ...(field === 'vehiclePlateOverride' ? {} : { vehiclePlateOverride: 'TXT 100' }),
      [field]: value,
    })).rejects.toMatchObject({ data: { code } });
  }
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
    vehiclePlateOverride: '  TRM 100  ',
  });
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId }))
    .toMatchObject({ vehiclePlateOverride: 'TRM 100' });
});

test('recording adjustments is audited, and a no-op records nothing', async () => {
  const f = await fixture('assignment-execution-adjustment-audit');
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId });
  await f.owner.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    additionalCharges: 250,
  });

  const audited = async () => (await f.owner.client.query(listEntityAuditEvents, {
    organizationId: f.organizationId,
    entityType: 'assignment',
    entityId: f.assignmentId,
    paginationOpts: firstPage,
  })).page.filter((event) => event.action === 'assignment.adjustmentsRecorded');

  // The net payable moves even though the accepted Revision cannot, so the log
  // has to answer who moved it.
  expect(await audited()).toEqual([
    expect.objectContaining({ metadata: expect.objectContaining({ changedFields: 'additionalCharges' }) }),
  ]);

  await f.owner.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    additionalCharges: 250,
  });
  expect(await audited()).toHaveLength(1);
});

test('the dispatch queue caps an oversized page request at its own ceiling', async () => {
  const f = await fixture('assignment-dispatch-queue-cap');
  // Inserted directly: this test is about the read path's ceiling, and 201
  // round-trips through the create mutation would only be slower, not truer.
  await f.t.run(async (ctx) => {
    for (let index = 0; index < 201; index += 1) {
      await ctx.db.insert('assignments', {
        organizationId: f.organizationId,
        serviceId: f.serviceId,
        projectId: f.projectId,
        providerId: f.providerId,
        position: 1_000 + index,
        executionStatus: 'unassigned',
      });
    }
  });

  // A caller asking for everything gets one bounded page, not the Project's
  // whole Assignment set — the read the pagination API exists to prevent (I6).
  const page = await f.owner.client.query(assignmentsAwaitingDispatch, {
    projectId: f.projectId,
    statuses: ['unassigned'],
    paginationOpts: { numItems: 5_000_000, cursor: null },
  });
  expect(page.page).toHaveLength(200);
  expect(page.isDone).toBe(false);
});

test('the dispatch queue refuses an unbounded page request', async () => {
  const f = await fixture('assignment-execution-queue-bounds');
  for (const numItems of [Number.POSITIVE_INFINITY, Number.NaN, 0, -5, 2.5]) {
    await expect(f.owner.client.query(assignmentsAwaitingDispatch, {
      projectId: f.projectId,
      statuses: ['unassigned'],
      paginationOpts: { numItems, cursor: null },
    })).rejects.toMatchObject({ data: { code: 'paginationNumItemsInvalid' } });
  }
  await expect(f.owner.client.query(assignmentsAwaitingDispatch, {
    projectId: f.projectId,
    statuses: Array.from({ length: 50 }, () => 'unassigned' as const),
    paginationOpts: firstPage,
  })).rejects.toMatchObject({ data: { code: 'paginationNumItemsInvalid' } });
});

test('the execution lifecycle runs end to end and both terminals are terminal', async () => {
  const f = await fixture('assignment-execution-lifecycle');
  const step = (status: 'assigned' | 'confirmed' | 'dispatched' | 'completed', extra: Record<string, string> = {}) =>
    f.owner.client.mutation(transitionAssignmentExecution, { assignmentId: f.assignmentId, status, ...extra });

  // Skipping ahead is refused before anything else, so the happy path below
  // cannot be reached by accident.
  await expect(step('dispatched')).rejects
    .toMatchObject({ data: { code: 'assignmentExecutionStatusTransitionInvalid' } });

  await step('assigned', { vehiclePlateOverride: 'LIF 100' });
  const early = await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId });
  expect(early).not.toHaveProperty('dispatchedAt');
  expect(early).not.toHaveProperty('completedAt');
  await step('confirmed', { driverName: 'Ana Restrepo' });
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'planned' });
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'confirmed' });
  await step('dispatched');
  await step('completed');

  const row = await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId });
  expect(row).toMatchObject({ executionStatus: 'completed' });
  expect(row.dispatchedAt).toEqual(expect.any(Number));
  expect(row.completedAt).toEqual(expect.any(Number));

  await expect(step('assigned', { vehiclePlateOverride: 'LIF 200' })).rejects
    .toMatchObject({ data: { code: 'assignmentExecutionTerminal' } });
});

test('a dispatched Assignment can still be completed after its Service closes out', async () => {
  const f = await fixture('assignment-execution-completed-service');
  const step = (status: 'assigned' | 'confirmed' | 'dispatched' | 'completed', extra: Record<string, string> = {}) =>
    f.owner.client.mutation(transitionAssignmentExecution, { assignmentId: f.assignmentId, status, ...extra });
  await step('assigned', { vehiclePlateOverride: 'CLS 100' });
  await step('confirmed', { driverName: 'Iván Gómez' });
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'planned' });
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'confirmed' });
  await step('dispatched');
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'active' });
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'completed' });

  // Closing the Service must not leave "it did not happen" as the only
  // reachable terminal for a bus that demonstrably went.
  await step('completed');
  expect(await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId }))
    .toMatchObject({ executionStatus: 'completed' });
});

test('unassignment clears the stored vehicle and driver, and reassignment clears the driver', async () => {
  const f = await fixture('assignment-execution-clearing');
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
    vehiclePlateOverride: 'CLR 100',
  });
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'confirmed',
    driverName: 'Sara Nieto',
    driverPhone: '+57 300 000 0000',
  });

  await f.owner.client.mutation(transitionAssignmentExecution, { assignmentId: f.assignmentId, status: 'assigned' });
  const reassigned = await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId });
  expect(reassigned).toMatchObject({ vehiclePlateOverride: 'CLR 100' });
  expect(reassigned).not.toHaveProperty('driverName');
  expect(reassigned).not.toHaveProperty('driverPhone');

  // The clearing has to reach the DATABASE, not merely the pure gate's return.
  await f.owner.client.mutation(transitionAssignmentExecution, { assignmentId: f.assignmentId, status: 'unassigned' });
  const cleared = await f.owner.client.query(getAssignment, { assignmentId: f.assignmentId });
  expect(cleared).toMatchObject({ executionStatus: 'unassigned' });
  for (const field of ['vehiclePlateOverride', 'fleetVehicleId', 'driverName', 'driverPhone']) {
    expect(cleared).not.toHaveProperty(field);
  }
});

test('a row can never name two vehicles, whichever transition adds the second', async () => {
  const f = await fixture('assignment-execution-two-vehicles');
  const fleetVehicleId = await f.owner.client.mutation(createFleetVehicle, {
    organizationId: f.organizationId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    plate: 'TWO123',
  });
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
    vehiclePlateOverride: 'TWO 100',
  });
  // The plate survives the transition, so supplying a Fleet Vehicle on the NEXT
  // one would leave the row naming two different vehicles.
  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'confirmed',
    driverName: 'Dual Driver',
    fleetVehicleId,
  })).rejects.toMatchObject({ data: { code: 'assignmentExecutionVehicleInvalid' } });
});

test('adjustment amounts go through the money boundary in both directions', async () => {
  const f = await fixture('assignment-execution-adjustment-bounds');
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId });
  // A negative amount widens the net in the payee's favour and would otherwise
  // pass, because `assignmentNet` only refuses a net BELOW zero.
  for (const amounts of [
    { notExecutedAmount: -1 },
    { additionalCharges: -1 },
    { additionalCharges: 10.5 },
  ]) {
    await expect(f.owner.client.mutation(recordAssignmentAdjustments, { assignmentId: f.assignmentId, ...amounts }))
      .rejects.toMatchObject({ data: { code: expect.stringMatching(/^moneyAmount/) } });
  }
});

test('accepting cheaper terms cannot strand the net below zero', async () => {
  const f = await fixture('assignment-execution-cheaper-terms');
  const firstRevisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId: firstRevisionId });
  const agreed = await f.owner.client.query(getAssignmentRevision, { revisionId: firstRevisionId });
  await f.owner.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    notExecutedAmount: agreed.lineTotal,
  });

  // Halving the quantity halves the line total, so the stored adjustment would
  // exceed it and no read could price the Assignment afterwards.
  const cheaperId = await f.owner.client.mutation(createAssignmentRevision, {
    ...f.revisionArgs,
    quantity: 1,
  });
  await expect(f.owner.client.mutation(acceptAssignmentRevision, { revisionId: cheaperId }))
    .rejects.toMatchObject({ data: { code: 'moneyAmountNegative' } });
});

test('Service cancellation preserves every execution status and freezes later execution writes', async () => {
  const f = await fixture('assignment-execution-cancellation');
  const secondId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 20,
  });
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: secondId,
    status: 'assigned',
    vehiclePlateOverride: 'CAN 100',
  });
  const before = await f.t.run(async (ctx) => {
    const rows = await ctx.db.query('assignments').withIndex('by_service_position', (q) => q.eq('serviceId', f.serviceId)).collect();
    return rows.map((row) => [row._id, row.executionStatus] as const);
  });
  await f.owner.client.mutation(changeServiceStatus, { serviceId: f.serviceId, status: 'cancelled' });
  const after = await f.t.run(async (ctx) => {
    const rows = await ctx.db.query('assignments').withIndex('by_service_position', (q) => q.eq('serviceId', f.serviceId)).collect();
    return rows.map((row) => [row._id, row.executionStatus] as const);
  });
  expect(after).toEqual(before);
  await expect(f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: secondId,
    status: 'confirmed',
    driverName: 'Late Driver',
  })).rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });
});

test('dispatch queue reads only requested indexed statuses, paginates by position, and narrows Provider rows', async () => {
  const f = await fixture('assignment-dispatch-queue');
  const firm = await grantFixtureProvider(f, 'assignment-queue-firm', 'Queue Firm');
  const rivalProviderId = await f.owner.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Queue Rival',
  });
  const ownAssignedId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 30,
  });
  const rivalAssignedId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: rivalProviderId,
    position: 20,
  });
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: ownAssignedId,
    status: 'assigned',
    vehiclePlateOverride: 'OWN 300',
  });
  await f.owner.client.mutation(transitionAssignmentExecution, {
    assignmentId: rivalAssignedId,
    status: 'assigned',
    vehiclePlateOverride: 'RIV 200',
  });

  // Created LAST but positioned FIRST, so a merge comparator that ordered by
  // creation time instead of position would produce a different sequence.
  const latecomerId = await f.owner.client.mutation(createAssignment, {
    serviceId: f.serviceId,
    providerId: f.providerId,
    position: 5,
  });

  const seen: Id<'assignments'>[] = [];
  let cursor: string | null = null;
  let finished = false;
  for (let request = 0; request < 8; request += 1) {
    const result: PaginationResult<Doc<'assignments'>> = await f.owner.client.query(assignmentsAwaitingDispatch, {
      projectId: f.projectId,
      statuses: ['assigned', 'unassigned'],
      paginationOpts: { numItems: 1, cursor },
    });
    seen.push(...result.page.map((row) => row._id));
    if (result.isDone) { finished = true; break; }
    cursor = result.continueCursor;
  }
  // The loop must end because the queue SAID it was done, not because the
  // request budget ran out — otherwise a queue that never reports completion
  // pages forever and no test notices.
  expect(finished).toBe(true);
  expect(seen).toEqual([latecomerId, f.assignmentId, rivalAssignedId, ownAssignedId]);


  // The Provider's row must carry the forbidden columns before it is read, or
  // the projection assertion below passes against an empty document.
  const queueCostCentreId = await f.owner.client.mutation(createCostCentre, {
    organizationId: f.organizationId,
    key: 'queueCharge',
    name: 'Queue charge',
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(ownAssignedId, {
      costCentreId: queueCostCentreId,
      notExecutedAmount: 10,
      additionalCharges: 20,
      additionalDetail: 'queue detail',
    });
  });
  const providerPage = await firm.client.query(assignmentsAwaitingDispatch, {
    projectId: f.projectId,
    statuses: ['assigned'],
    paginationOpts: firstPage,
  });
  expect(providerPage.page.map((row) => row._id)).toEqual([ownAssignedId]);
  expectNoForbiddenProviderKeys(providerPage.page[0] ?? {});
  expect(await firm.client.query(assignmentsAwaitingDispatch, {
    projectId: f.projectId,
    statuses: ['confirmed'],
    paginationOpts: firstPage,
  })).toMatchObject({ page: [] });

  const source = Object.values(import.meta.glob('../convex/assignments/model.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }))[0] ?? '';
  expect(source).toContain("withIndex('by_project_execution_position'");
  expect(source).not.toContain('.collect()');
});

test('Provider execution shaping is exhaustive and execution audit metadata contains no driver PII', async () => {
  const f = await fixture('assignment-execution-shaping');
  const firm = await grantFixtureProvider(f, 'assignment-shaping-firm', 'Shaping Firm');
  const revisionId = await f.owner.client.mutation(createAssignmentRevision, f.revisionArgs);
  await f.owner.client.mutation(acceptAssignmentRevision, { revisionId });
  await f.owner.client.mutation(recordAssignmentAdjustments, {
    assignmentId: f.assignmentId,
    notExecutedAmount: 10,
    additionalCharges: 20,
    additionalDetail: 'Coordinator-only adjustment',
  });
  await firm.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'assigned',
    vehiclePlateOverride: 'SUB 900',
  });
  const driverName = 'PII Driver Name';
  const driverPhone = '+57 399 999 9999';
  await firm.client.mutation(transitionAssignmentExecution, {
    assignmentId: f.assignmentId,
    status: 'confirmed',
    driverName,
    driverPhone,
  });
  const providerRow = await firm.client.query(getAssignment, { assignmentId: f.assignmentId });
  expect(providerRow).toMatchObject({ executionStatus: 'confirmed', driverName, driverPhone, vehiclePlateOverride: 'SUB 900' });
  expectNoForbiddenProviderKeys(providerRow);
  expect(providerRow).not.toHaveProperty('notExecutedAmount');
  expect(providerRow).not.toHaveProperty('additionalCharges');
  expect(providerRow).not.toHaveProperty('additionalDetail');

  const seenProviderKeys = new Set(Object.keys(providerRow));
  for (const key of providerAssignmentKeys) {
    if (['completedAt', 'dispatchedAt', 'fleetVehicleId', 'notExecutedReason'].includes(key)) continue;
    expect(seenProviderKeys.has(key)).toBe(true);
  }
  await f.t.run(async (ctx) => {
    const audits = await ctx.db.query('auditEvents').withIndex('by_org', (q) => q.eq('organizationId', f.organizationId)).collect();
    const executionAudits = audits.filter((row) =>
      row.action === 'assignment.vehicleAssigned' || row.action === 'assignment.driverAssigned',
    );
    expect(executionAudits).toHaveLength(2);
    expect(executionAudits.every((row) => row.onBehalfOfProviderId === f.providerId)).toBe(true);
    const allMetadata = audits.map((row) => JSON.stringify(row.metadata)).join('\n');
    expect(allMetadata).not.toContain(driverName);
    expect(allMetadata).not.toContain(driverPhone);
  });
});
