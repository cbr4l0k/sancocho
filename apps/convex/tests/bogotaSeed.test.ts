import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { enableSeedMutations, modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const listPublishedServiceKinds = api.serviceKinds.queries.listPublishedServiceKinds;
const listLocations = api.locations.queries.listLocations;
const listProjectServices = api.services.queries.listProjectServices;
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

  const services = await client.query(listProjectServices, { projectId: project._id, paginationOpts: firstPage });
  expect(services.page).toHaveLength(6);
  // The statuses are walked through the real transition matrix, so a demo shows
  // more than a wall of drafts — and a jump would have been refused on the way.
  const statuses = services.page.map((row) => row.status).sort();
  expect(statuses).toEqual(['cancelled', 'confirmed', 'confirmed', 'draft', 'planned', 'planned']);
  // Every service's startsAt is an absolute instant inside the project window.
  expect(services.page.every((row) => row.startsAt > (project.startsAt ?? 0) && row.startsAt < (project.endsAt ?? Infinity))).toBe(true);
});

test('the seed reuses the starter serviceKinds rather than creating its own', async () => {
  const t = convexTest(schema, modules);
  const { client, organizationId } = await tenant(t);
  await t.mutation(seedBogotaOperations, { organizationSlug: slug });

  const serviceKinds = await client.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage });
  expect(serviceKinds.page.map((entry) => entry.serviceKind.key).sort()).toEqual([
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
  expect(cleared).toMatchObject({ services: 6, locations: 8, serviceKinds: 4, fieldDefinitions: 9 });

  // Gone: the four things the reset is for.
  expect(await client.query(listLocations, { organizationId, paginationOpts: firstPage })).toMatchObject({ page: [] });
  expect(await client.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage })).toMatchObject({ page: [] });

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
    expect(audits.some((audit) => ['service', 'location', 'serviceKind', 'fieldDefinition'].includes(audit.entityType))).toBe(false);
  });
});

test('seeding again after a reset restores the same demonstration', async () => {
  const t = convexTest(schema, modules);
  const { client, organizationId } = await tenant(t);
  await t.mutation(seedBogotaOperations, { organizationSlug: slug });
  await t.mutation(resetTenantOperations, {});
  const again = await t.mutation(seedBogotaOperations, { organizationSlug: slug });

  expect(again).toMatchObject({ locations: 8, services: 6 });
  const serviceKinds = await client.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage });
  expect(serviceKinds.page).toHaveLength(4);
});

test('the reset and the seed both refuse without the deployment opt-in', async () => {
  const t = convexTest(schema, modules);
  await tenant(t);
  // `enableSeedMutations` sets the flag for each test; drop it to prove the guard
  // is what permits these, not `internalMutation` alone.
  delete process.env.PRIAMO_ENABLE_SEED;
  await expect(t.mutation(resetTenantOperations, {})).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
  await expect(t.mutation(seedBogotaOperations, { organizationSlug: slug })).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
});
