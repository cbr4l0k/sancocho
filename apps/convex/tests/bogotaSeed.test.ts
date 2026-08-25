import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { enableSeedMutations, modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const listPublishedRecipes = api.recipes.queries.listPublishedRecipes;
const listLocations = api.locations.queries.listLocations;
const listProjectEvents = api.events.queries.listProjectEvents;
const resetTenantOperations = internal.seed.reset.resetTenantOperations;
const seedBogotaOperations = internal.seed.bogota.seedBogotaOperations;

const issuer = 'https://example.clerk.accounts.dev';
const slug = 'bogota-demo';
const firstPage = { numItems: 50, cursor: null };

enableSeedMutations();

async function tenant(t: ReturnType<typeof convexTest>) {
  const client = t.withIdentity({ issuer, subject: 'bogota-owner', name: 'Owner', email: 'owner@example.com', emailVerified: true });
  await client.mutation(ensureUser, {});
  const organizationId = await client.mutation(createOrganization, { name: 'Bogotá Ops', slug });
  return { client, organizationId };
}

test('the Bogota seed fills an existing organization with locations, a project and services', async () => {
  const t = convexTest(schema, modules);
  const { client, organizationId } = await tenant(t);

  const result = await t.mutation(seedBogotaOperations, { organizationSlug: slug });
  expect(result).toMatchObject({ locations: 8, services: 6, projectName: 'FEP' });

  const locations = await client.query(listLocations, { organizationId, paginationOpts: firstPage });
  expect(locations.page.map((row) => row.name)).toContain('El Dorado T1 — Llegadas internacionales');
  // Every seeded location is in Bogotá: latitude just above 4°N, longitude near -74°.
  expect(locations.page.every((row) => row.latitude !== undefined && row.latitude > 4.5 && row.latitude < 5)).toBe(true);
  expect(locations.page.every((row) => row.longitude !== undefined && row.longitude > -74.3 && row.longitude < -73.9)).toBe(true);

  const projects = await client.query(api.projects.queries.listProjects, { organizationId, paginationOpts: firstPage });
  const project = projects.page.find((row) => row.name === 'FEP');
  if (project === undefined) throw new Error('Expected the seeded FEP project');

  const events = await client.query(listProjectEvents, { projectId: project._id, paginationOpts: firstPage });
  expect(events.page).toHaveLength(6);
  // The statuses are walked through the real transition matrix, so a demo shows
  // more than a wall of drafts — and a jump would have been refused on the way.
  const statuses = events.page.map((row) => row.status).sort();
  expect(statuses).toEqual(['cancelled', 'confirmed', 'confirmed', 'draft', 'planned', 'planned']);
  // Every service's startsAt is an absolute instant inside the project window.
  expect(events.page.every((row) => row.startsAt > (project.startsAt ?? 0) && row.startsAt < (project.endsAt ?? Infinity))).toBe(true);
});

test('the seed reuses the starter recipes rather than creating its own', async () => {
  const t = convexTest(schema, modules);
  const { client, organizationId } = await tenant(t);
  await t.mutation(seedBogotaOperations, { organizationSlug: slug });

  const recipes = await client.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage });
  expect(recipes.page.map((entry) => entry.recipe.key).sort()).toEqual([
    'airportArrivalTransfer', 'airportDepartureTransfer', 'pointToPointTransfer', 'shuttleService',
  ]);
});

test('the seed refuses an organization slug that does not exist', async () => {
  const t = convexTest(schema, modules);
  await tenant(t);
  await expect(t.mutation(seedBogotaOperations, { organizationSlug: 'no-such-tenant' })).rejects.toMatchObject({
    data: { code: 'seedOrganizationMissing' },
  });
});

test('the reset clears operational data but keeps the user, organization and projects', async () => {
  const t = convexTest(schema, modules);
  const { client, organizationId } = await tenant(t);
  await t.mutation(seedBogotaOperations, { organizationSlug: slug });

  const cleared = await t.mutation(resetTenantOperations, {});
  expect(cleared).toMatchObject({ events: 6, locations: 8, eventRecipes: 4, fieldDefinitions: 9 });

  // Gone: the four things the reset is for.
  expect(await client.query(listLocations, { organizationId, paginationOpts: firstPage })).toMatchObject({ page: [] });
  expect(await client.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage })).toMatchObject({ page: [] });

  // Kept: the tenant itself, so a developer stays signed in and keeps their project.
  const organizations = await client.query(api.organizations.queries.listMyOrganizations, {});
  expect(organizations.map(({ organization }) => organization._id)).toEqual([organizationId]);
  const projects = await client.query(api.projects.queries.listProjects, { organizationId, paginationOpts: firstPage });
  expect(projects.page.map((row) => row.name)).toEqual(['FEP']);

  // Kept: audit history for what survived; dropped for what did not.
  await t.run(async (ctx) => {
    const audits = await ctx.db.query('auditEvents').collect();
    expect(audits.some((audit) => audit.entityType === 'organization')).toBe(true);
    expect(audits.some((audit) => audit.entityType === 'project')).toBe(true);
    expect(audits.some((audit) => ['event', 'location', 'eventRecipe', 'fieldDefinition'].includes(audit.entityType))).toBe(false);
  });
});

/**
 * A reset sweeps `events`, `eventRecipes`, `recipeVersions`, and `locations` —
 * every table the maintained statistics counters mirror — so it must sweep
 * the counters with them, or the statistics surface keeps reporting entities
 * that no longer exist, and accumulates further onto that stale count with
 * every subsequent reset+reseed generation.
 */
test('a reset clears the statistics counters along with the tables they mirror, and reseeding does not accumulate onto stale counts', async () => {
  const t = convexTest(schema, modules);
  const { client, organizationId } = await tenant(t);
  await t.mutation(seedBogotaOperations, { organizationSlug: slug });

  // Before reset: the seed's own real writes (provisioning + publishing the
  // starter recipes, creating locations and services) already left non-zero
  // statistics — this is what a stale post-reset read would be mistaken for.
  await expect(client.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(4);
  await expect(client.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(8);
  const beforeServiceCounts = await client.query(api.statistics.queries.getServiceStatusCounts, { organizationId });
  expect(beforeServiceCounts.reduce((sum, row) => sum + row.count, 0)).toBe(6);
  // The seeded services carry real `passengerCount`/`wheelchairCount`
  // BUILT-IN field values (the starter recipes bind them — see
  // fields/builtins.ts), so `statisticsSemanticCounters` is non-zero here
  // too. This table was added to the reset sweep alongside
  // `statisticsCounters`/`statisticsTotals` in seed/reset.ts, but nothing in
  // this file ever asserted it — exactly the defect class the previous #34
  // audit caught reset leaving stale (see the doc comment above).
  const beforePassengers = await client.query(api.statistics.queries.getPassengerTotals, { organizationId });
  expect(beforePassengers.total.value).toBeGreaterThan(0);
  expect(beforePassengers.eventCount.value).toBeGreaterThan(0);

  await t.mutation(resetTenantOperations, {});

  // After reset: recipes and locations were fully swept, so their counters
  // must read exactly zero, not the pre-reset totals.
  await expect(client.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(0);
  await expect(client.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(0);
  const afterServiceCounts = await client.query(api.statistics.queries.getServiceStatusCounts, { organizationId });
  expect(afterServiceCounts.every((row) => row.count === 0)).toBe(true);
  // The semantic counters must be swept too — a reset that clears every
  // event but leaves `statisticsSemanticCounters` standing would keep
  // reporting passengers for services that no longer exist.
  await expect(client.query(api.statistics.queries.getPassengerTotals, { organizationId })).resolves.toEqual({
    total: { value: 0, isTruncated: false }, eventCount: { value: 0, isTruncated: false },
  });

  // Re-seeding recreates the same 4 starter recipes (their keys were freed by
  // the reset) and the same 8 locations and 6 services: the count must land
  // back on exactly those numbers, not double them, proving the reset did not
  // merely fail to clear silently accumulating counters.
  await t.mutation(seedBogotaOperations, { organizationSlug: slug });
  await expect(client.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(4);
  await expect(client.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(8);
  // The re-seeded passenger total must land back on exactly the same value
  // as before reset — not doubled (a leftover-counter bug) and not zero (a
  // rebuild that never ran).
  const afterReseedPassengers = await client.query(api.statistics.queries.getPassengerTotals, { organizationId });
  expect(afterReseedPassengers).toEqual(beforePassengers);
});

test('seeding again after a reset restores the same demonstration', async () => {
  const t = convexTest(schema, modules);
  const { client, organizationId } = await tenant(t);
  await t.mutation(seedBogotaOperations, { organizationSlug: slug });
  await t.mutation(resetTenantOperations, {});
  const again = await t.mutation(seedBogotaOperations, { organizationSlug: slug });

  expect(again).toMatchObject({ locations: 8, services: 6 });
  const recipes = await client.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage });
  expect(recipes.page).toHaveLength(4);
});

test('the reset and the seed both refuse without the deployment opt-in', async () => {
  const t = convexTest(schema, modules);
  await tenant(t);
  // `enableSeedMutations` sets the flag for each test; drop it to prove the guard
  // is what permits these, not `internalMutation` alone.
  delete process.env.SANCOCHO_ENABLE_SEED;
  await expect(t.mutation(resetTenantOperations, {})).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
  await expect(t.mutation(seedBogotaOperations, { organizationSlug: slug })).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
});
