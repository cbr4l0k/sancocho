import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { normalizeSearchText } from '../convex/lib/search';
import schema from '../convex/schema';
import { enableSeedMutations, modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const seedCordilleraOperations = internal.seed.cordillera.seedCordilleraOperations;
const seedProviderOrganizations = internal.seed.providerOrganization.seedProviderOrganizations;
const resetTenantOperations = internal.seed.reset.resetTenantOperations;
const listProviderDispatchDay = api.assignments.queries.listProviderDispatchDay;
const dispatchDayReadiness = api.assignments.queries.dispatchDayReadiness;

const issuer = 'https://example.clerk.accounts.dev';
const providerSeedIssuer = 'https://seed.priamo.internal';
const slug = 'cordillera-demo';
const projectName = 'Cordillera 2026';
const airportCoordinationName = 'Coordinación aeropuerto';
const andesProviderName = 'Transportes Andes SAS';
const altiplanoProviderName = 'Rutas del Altiplano SAS';
const andesRateCardName = 'Tarifario Cordillera 2026';
const paramoCostCentreKey = 'paramo';
const venueName = 'Parque Simón Bolívar — Cordillera';

// 12 September 2026, Bogotá UTC−5 year round. Half-open local day in ms.
const festivalDayFrom = Date.UTC(2026, 8, 12, 5, 0, 0);
const festivalDayTo = Date.UTC(2026, 8, 13, 5, 0, 0);

const committedAcceptedLineTotal = 4_552_000_000;
const acceptedRevisionCount = 82;
const cancelledWriteOffTotal = 125_000_000;
const cancelledAssignmentCount = 3;
const expectedCheckpointCount = 95;
const h1TransferMinorUnits = 18_500_000;
const h1DispositionMinorUnits = 64_000_000;
const sprinterDispositionMinorUnits = 81_000_000;
const eventBudgetMinorUnits = 11_000_000_000;

const expectedServiceStatusCounts: Record<Doc<'services'>['status'], number> = {
  completed: 17,
  active: 23,
  confirmed: 40,
  cancelled: 3,
  planned: 6,
  draft: 1,
};

type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;

enableSeedMutations();

function expectedExecutionStatus(
  status: Doc<'services'>['status'],
): Doc<'assignments'>['executionStatus'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'active':
      return 'dispatched';
    case 'confirmed':
      return 'confirmed';
    case 'cancelled':
      return 'notExecuted';
    case 'planned':
      return 'unassigned';
    case 'draft':
      return 'unassigned';
  }
}

async function tenant(t: SchemaTest) {
  const client = t.withIdentity({
    issuer,
    subject: 'cordillera-owner',
    name: 'Owner',
    email: 'owner@example.com',
    emailVerified: true,
  });
  await client.mutation(ensureUser, {});
  const organizationId = await client.mutation(createOrganization, { name: 'Cordillera Ops', slug });
  return { client, organizationId };
}

async function seedCoordinator(t: SchemaTest) {
  const { client, organizationId } = await tenant(t);
  await t.mutation(seedCordilleraOperations, { organizationSlug: slug });
  const project = await t.run(async (ctx) => {
    const projects = await ctx.db.query('projects').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    const row = projects.find((projectRow) => projectRow.name === projectName);
    if (row === undefined) throw new Error('Expected the Cordillera project');
    return row;
  });
  return { client, organizationId, project };
}

async function commercialCounts(t: SchemaTest, organizationId: Id<'organizations'>, projectId: Id<'projects'>) {
  return t.run(async (ctx) => ({
    providers: (await ctx.db.query('providers').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).length,
    rateCards: (await ctx.db.query('rateCards').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).length,
    rateLines: (await ctx.db.query('rateLines').collect()).filter((row) => row.organizationId === organizationId).length,
    vehicleClasses: (await ctx.db.query('vehicleClasses').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).length,
    costCentres: (await ctx.db.query('costCentres').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).length,
    fleetVehicles: (await ctx.db.query('fleetVehicles').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).length,
    assignments: (await ctx.db.query('assignments').withIndex('by_project_position', (q) => q.eq('projectId', projectId)).collect()).length,
    assignmentRevisions: (await ctx.db.query('assignmentRevisions').collect()).filter((row) => row.organizationId === organizationId).length,
    assignmentCheckpoints: (await ctx.db.query('assignmentCheckpoints').collect()).filter((row) => row.organizationId === organizationId).length,
  }));
}

test('accepted Assignment Revisions store the workbook committed total in COP minor units', async () => {
  const t = convexTest(schema, modules);
  const { organizationId, project } = await seedCoordinator(t);

  await t.run(async (ctx) => {
    const assignments = await ctx.db.query('assignments').withIndex('by_project_position', (q) => q.eq('projectId', project._id)).collect();
    const revisions: Doc<'assignmentRevisions'>[] = [];
    for (const assignment of assignments) {
      const rows = await ctx.db.query('assignmentRevisions').withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id)).collect();
      revisions.push(...rows);
    }
    const accepted = revisions.filter((revision) => revision.status === 'accepted');
    expect(accepted).toHaveLength(acceptedRevisionCount);

    let committed = 0;
    for (const revision of accepted) {
      expect(revision.currency).toBe('COP');
      expect(revision.revisionNumber).toBe(1);
      expect(revision.quantity).toBe(1);
      expect(revision.lineTotal).toBe(revision.unitAmount * revision.quantity);
      const rateLine = await ctx.db.get(revision.rateLineId);
      if (rateLine === null) throw new Error('Expected the Rate Line behind an accepted revision');
      expect(rateLine.organizationId).toBe(organizationId);
      expect(revision.unitAmount).toBe(rateLine.unitAmount);
      committed += revision.lineTotal;
    }
    expect(committed).toBe(committedAcceptedLineTotal);
  });
}, 30_000);

test('published Andes rate lines store H1 transfer, H1 disposition and Sprinter disposition in minor units', async () => {
  const t = convexTest(schema, modules);
  const { organizationId } = await seedCoordinator(t);

  await t.run(async (ctx) => {
    const cards = await ctx.db.query('rateCards').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    expect(cards).toHaveLength(2);
    const versions = await ctx.db.query('rateCardVersions').collect();
    const published = versions.filter((version) => version.organizationId === organizationId && version.status === 'published');
    expect(published).toHaveLength(2);
    for (const version of published) {
      expect(version.versionNumber).toBe(1);
      const card = await ctx.db.get(version.rateCardId);
      if (card === null) throw new Error('Expected the Rate Card behind a published version');
      expect(card.currentPublishedVersionId).toBe(version._id);
    }

    const andesCard = cards.find((card) => card.name === andesRateCardName);
    if (andesCard === undefined) throw new Error('Expected the Andes Cordillera rate card');
    const publishedVersionId = andesCard.currentPublishedVersionId;
    if (publishedVersionId === undefined) throw new Error('Expected Andes to have a published Rate Card Version');
    const classes = await ctx.db.query('vehicleClasses').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    const h1 = classes.find((vehicleClass) => vehicleClass.name === 'H1');
    const sprinter = classes.find((vehicleClass) => vehicleClass.name === 'Sprinter');
    if (h1 === undefined || sprinter === undefined) throw new Error('Expected H1 and Sprinter vehicle classes');
    const lines = await ctx.db.query('rateLines').withIndex('by_version', (q) => q.eq('rateCardVersionId', publishedVersionId)).collect();
    const h1Transfer = lines.find((line) => line.vehicleClassId === h1._id && line.modality === 'transfer');
    const h1Disposition = lines.find((line) => line.vehicleClassId === h1._id && line.modality === 'disposition');
    const sprinterDisposition = lines.find((line) => line.vehicleClassId === sprinter._id && line.modality === 'disposition');
    if (h1Transfer === undefined || h1Disposition === undefined || sprinterDisposition === undefined) {
      throw new Error('Expected the Andes H1 transfer, H1 disposition and Sprinter disposition cells');
    }
    expect(h1Transfer.unitAmount).toBe(h1TransferMinorUnits);
    expect(h1Disposition.unitAmount).toBe(h1DispositionMinorUnits);
    expect(sprinterDisposition.unitAmount).toBe(sprinterDispositionMinorUnits);
  });
}, 30_000);

test('cancelled Assignments write off the accepted revision lineTotal and sum to 125000000', async () => {
  const t = convexTest(schema, modules);
  const { project } = await seedCoordinator(t);

  await t.run(async (ctx) => {
    const assignments = await ctx.db.query('assignments').withIndex('by_project_position', (q) => q.eq('projectId', project._id)).collect();
    const cancelled = assignments.filter((assignment) => assignment.executionStatus === 'notExecuted');
    expect(cancelled).toHaveLength(cancelledAssignmentCount);
    let writeOff = 0;
    for (const assignment of cancelled) {
      if (assignment.currentRevisionId === undefined) throw new Error('Expected accepted terms on a cancelled Assignment');
      const revision = await ctx.db.get(assignment.currentRevisionId);
      if (revision === null) throw new Error('Expected the current revision of a cancelled Assignment');
      expect(assignment.notExecutedAmount).toBe(revision.lineTotal);
      if (assignment.notExecutedAmount === undefined) throw new Error('Expected a stored not-executed amount');
      writeOff += assignment.notExecutedAmount;
    }
    expect(writeOff).toBe(cancelledWriteOffTotal);
  });
}, 30_000);

test('Service status agrees with Assignment executionStatus, including the coord-airport exception', async () => {
  const t = convexTest(schema, modules);
  const { project } = await seedCoordinator(t);

  await t.run(async (ctx) => {
    const services = await ctx.db.query('services').withIndex('by_project', (q) => q.eq('projectId', project._id)).collect();
    expect(services).toHaveLength(90);
    const byStatus: Record<Doc<'services'>['status'], number> = {
      completed: 0,
      active: 0,
      confirmed: 0,
      cancelled: 0,
      planned: 0,
      draft: 0,
    };
    let airportCoordinationSeen = false;
    for (const service of services) {
      byStatus[service.status] += 1;
      const assignments = await ctx.db.query('assignments').withIndex('by_service_position', (q) => q.eq('serviceId', service._id)).collect();
      expect(assignments).toHaveLength(1);
      const assignment = assignments[0];
      if (assignment === undefined) throw new Error('Expected an Assignment for every seeded Service');
      if (service.name === airportCoordinationName) {
        airportCoordinationSeen = true;
        expect(service.status).toBe('active');
        expect(assignment.executionStatus).toBe('unassigned');
        const revisions = await ctx.db.query('assignmentRevisions').withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id)).collect();
        expect(revisions).toHaveLength(0);
        continue;
      }
      expect(assignment.executionStatus).toBe(expectedExecutionStatus(service.status));
    }
    expect(airportCoordinationSeen).toBe(true);
    expect(byStatus).toEqual(expectedServiceStatusCounts);
  });
}, 30_000);

test('every Fleet Vehicle named by an execution belongs to that Assignment\'s own provider', async () => {
  const t = convexTest(schema, modules);
  const { organizationId, project } = await seedCoordinator(t);

  await t.run(async (ctx) => {
    const providers = await ctx.db.query('providers').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    const altiplano = providers.find((provider) => provider.name === altiplanoProviderName);
    if (altiplano === undefined) throw new Error('Expected Rutas del Altiplano SAS');
    const serviceKinds = await ctx.db.query('serviceKinds').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    const crewKind = serviceKinds.find((serviceKind) => serviceKind.key === 'festivalCrewShuttle');
    if (crewKind === undefined) throw new Error('Expected the crew shuttle Service Kind');
    const plateField = (await ctx.db.query('fieldDefinitions').withIndex('by_org_key', (q) => q.eq('organizationId', organizationId)).collect())
      .find((field) => field.key === 'vehiclePlate');
    if (plateField === undefined) throw new Error('Expected the vehiclePlate field');
    const fleetVehicles = await ctx.db.query('fleetVehicles').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    const services = await ctx.db.query('services').withIndex('by_project', (q) => q.eq('projectId', project._id)).collect();

    for (const service of services) {
      const assignments = await ctx.db.query('assignments').withIndex('by_service_position', (q) => q.eq('serviceId', service._id)).collect();
      const assignment = assignments[0];
      if (assignment === undefined) throw new Error('Expected an Assignment for every seeded Service');
      if (service.serviceKindId === crewKind._id) {
        expect(assignment.providerId).toBe(altiplano._id);
      }
      if (assignment.fleetVehicleId !== undefined) {
        const vehicle = await ctx.db.get(assignment.fleetVehicleId);
        if (vehicle === null) throw new Error('Expected the Fleet Vehicle named by an execution');
        expect(vehicle.providerId).toBe(assignment.providerId);
      }
      if (assignment.executionStatus === 'unassigned' || assignment.executionStatus === 'notExecuted') continue;
      const values = await ctx.db.query('serviceFieldValues').withIndex('by_service_field', (q) => q.eq('serviceId', service._id)).collect();
      const plateValue = values.find((stored) => stored.fieldDefinitionId === plateField._id);
      if (plateValue === undefined) continue;
      const storedPlate = plateValue.value;
      if (storedPlate.kind !== 'text') continue;
      const named = fleetVehicles.find((vehicle) => vehicle.plate === storedPlate.value);
      if (named === undefined) continue;
      expect(assignment.fleetVehicleId).toBe(named._id);
      expect(named.providerId).toBe(assignment.providerId);
    }
  });
}, 30_000);

test('re-running the Cordillera seed does not duplicate commercial rows', async () => {
  const t = convexTest(schema, modules);
  const { organizationId, project } = await seedCoordinator(t);
  const before = await commercialCounts(t, organizationId, project._id);
  expect(before).toMatchObject({
    providers: 2,
    rateCards: 2,
    costCentres: 6,
    fleetVehicles: 8,
    assignments: 90,
    assignmentRevisions: 88,
    assignmentCheckpoints: expectedCheckpointCount,
  });

  await expect(t.mutation(seedCordilleraOperations, { organizationSlug: slug })).resolves.toMatchObject({
    providers: 2,
    rateCards: 2,
    fleetVehicles: 8,
    assignments: 0,
    assignmentRevisions: 0,
    assignmentCheckpoints: 0,
  });

  const after = await commercialCounts(t, organizationId, project._id);
  expect(after).toEqual(before);
}, 40_000);

test('resetTenantOperations leaves no assignment rows and no audit pointing at a deleted entity', async () => {
  const t = convexTest(schema, modules);
  await seedCoordinator(t);
  await t.mutation(resetTenantOperations, {});

  await t.run(async (ctx) => {
    expect(await ctx.db.query('assignments').collect()).toHaveLength(0);
    expect(await ctx.db.query('assignmentRevisions').collect()).toHaveLength(0);
    expect(await ctx.db.query('assignmentCheckpoints').collect()).toHaveLength(0);

    const remainingIds = new Set<string>();
    for (const row of [
      ...(await ctx.db.query('organizations').collect()),
      ...(await ctx.db.query('organizationMemberships').collect()),
      ...(await ctx.db.query('projects').collect()),
      ...(await ctx.db.query('events').collect()),
      ...(await ctx.db.query('fieldDefinitions').collect()),
      ...(await ctx.db.query('serviceKinds').collect()),
      ...(await ctx.db.query('serviceKindVersions').collect()),
      ...(await ctx.db.query('serviceKindFields').collect()),
      ...(await ctx.db.query('services').collect()),
      ...(await ctx.db.query('locations').collect()),
      ...(await ctx.db.query('costCentres').collect()),
      ...(await ctx.db.query('providers').collect()),
      ...(await ctx.db.query('rateCards').collect()),
      ...(await ctx.db.query('rateCardVersions').collect()),
      ...(await ctx.db.query('assignments').collect()),
      ...(await ctx.db.query('assignmentRevisions').collect()),
      ...(await ctx.db.query('assignmentCheckpoints').collect()),
      ...(await ctx.db.query('providerAccessGrants').collect()),
      ...(await ctx.db.query('organizationInvitations').collect()),
      ...(await ctx.db.query('vehicleClasses').collect()),
      ...(await ctx.db.query('fleetVehicles').collect()),
      ...(await ctx.db.query('serviceRelationships').collect()),
    ]) {
      remainingIds.add(String(row._id));
    }
    const audits = await ctx.db.query('auditEvents').collect();
    for (const audit of audits) {
      expect(remainingIds.has(audit.entityId), `${audit.entityType} ${audit.entityId} must still resolve`).toBe(true);
    }
  });
}, 40_000);

test('dispatchDayReadiness on 12 September 2026 reports a non-zero unassigned', async () => {
  const t = convexTest(schema, modules);
  const { client, project } = await seedCoordinator(t);
  const readiness = await client.query(dispatchDayReadiness, {
    projectId: project._id,
    from: festivalDayFrom,
    to: festivalDayTo,
  });
  expect(readiness.unassigned).toBeGreaterThan(0);
}, 30_000);

test('the provider arm resolves for Transportes Andes and refuses Rutas del Altiplano', async () => {
  const t = convexTest(schema, modules);
  const { project } = await seedCoordinator(t);
  await t.mutation(seedProviderOrganizations, { organizationSlug: slug });

  const andes = t.withIdentity({
    issuer: providerSeedIssuer,
    subject: 'provider-organization:transportes-andes',
    email: 'operaciones@transportesandes.invalid',
    emailVerified: true,
  });
  const altiplano = t.withIdentity({
    issuer: providerSeedIssuer,
    subject: 'provider-organization:rutas-altiplano',
    email: 'despacho@rutasaltiplano.invalid',
    emailVerified: true,
  });
  const dispatchArgs = {
    projectId: project._id,
    from: festivalDayFrom,
    to: festivalDayTo,
    paginationOpts: { numItems: 200, cursor: null },
  };

  const andesPage = await andes.query(listProviderDispatchDay, dispatchArgs);
  expect(andesPage.page.length).toBeGreaterThan(0);

  await expect(altiplano.query(listProviderDispatchDay, dispatchArgs)).rejects.toMatchObject({
    data: { code: 'notFoundOrInaccessible' },
  });

  await t.run(async (ctx) => {
    const assignments = await ctx.db.query('assignments').withIndex('by_project_position', (q) => q.eq('projectId', project._id)).collect();
    const countered: Doc<'assignmentRevisions'>[] = [];
    for (const assignment of assignments) {
      const revisions = await ctx.db.query('assignmentRevisions').withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id)).collect();
      for (const revision of revisions) {
        if (revision.proposedOnBehalfOfProviderId !== undefined) countered.push(revision);
      }
    }
    expect(countered).toHaveLength(1);
    const counter = countered[0];
    if (counter === undefined) throw new Error('Expected the seeded Provider counter');
    const assignment = await ctx.db.get(counter.assignmentId);
    if (assignment === null) throw new Error('Expected the Assignment belonging to the counter');
    expect(assignment.executionStatus).toBe('unassigned');
    const siblings = await ctx.db.query('assignmentRevisions').withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id)).collect();
    const coordinatorOffer = siblings.find((revision) =>
      revision.proposedOnBehalfOfProviderId === undefined && revision.status === 'draft',
    );
    expect(coordinatorOffer).toBeDefined();
  });
}, 40_000);

test('workbook cargo classes resolve to the starter rows and the Event carries the festival budget', async () => {
  const t = convexTest(schema, modules);
  const { organizationId, project } = await seedCoordinator(t);

  await t.run(async (ctx) => {
    const classes = await ctx.db.query('vehicleClasses').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    const cargoVan = classes.filter((vehicleClass) => normalizeSearchText(vehicleClass.name) === 'cargo van');
    const cargoTruck = classes.filter((vehicleClass) => normalizeSearchText(vehicleClass.name) === 'cargo truck');
    expect(cargoVan).toHaveLength(1);
    expect(cargoTruck).toHaveLength(1);

    const events = await ctx.db.query('events').withIndex('by_project_startsAt', (q) => q.eq('projectId', project._id)).collect();
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('Expected the Cordillera Event');
    expect(event.budgetAmount).toBe(eventBudgetMinorUnits);
    expect(event.budgetCurrency).toBe('COP');
    if (event.venueLocationId === undefined) throw new Error('Expected the Event venue');
    const venue = await ctx.db.get(event.venueLocationId);
    if (venue === null) throw new Error('Expected the venue Location');
    expect(venue.name).toBe(venueName);
    if (event.clientCostCentreId === undefined) throw new Error('Expected the Event client cost centre');
    const costCentre = await ctx.db.get(event.clientCostCentreId);
    if (costCentre === null) throw new Error('Expected the paramo cost centre');
    expect(costCentre.key).toBe(paramoCostCentreKey);
    const memberships = await ctx.db.query('organizationMemberships').withIndex('by_org_user', (q) => q.eq('organizationId', organizationId)).collect();
    const owner = memberships.find((membership) => membership.role === 'owner');
    if (owner === undefined) throw new Error('Expected the seeding owner membership');
    expect(event.accountableUserId).toBe(owner.userId);
  });
}, 30_000);

test('the seed writes 95 assignment checkpoints', async () => {
  // Expected to fail from roughly September 2027: recordAssignmentCheckpoint
  // refuses an occurredAt more than ±365 days from Date.now(), and the demo's
  // festival is a fixed September 2026 week. That failure is the intended
  // signal that the dates need re-anchoring. The seed itself keeps working
  // because checkpoints are observations and never status — it skips them
  // rather than rolling back.
  const t = convexTest(schema, modules);
  const { organizationId } = await seedCoordinator(t);

  await t.run(async (ctx) => {
    const checkpoints = (await ctx.db.query('assignmentCheckpoints').collect())
      .filter((checkpoint) => checkpoint.organizationId === organizationId);
    expect(checkpoints).toHaveLength(expectedCheckpointCount);
  });
}, 30_000);
