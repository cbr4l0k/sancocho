import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { modules, seedOptInVariable } from './helpers';

// Deployment environment variables reach Convex functions through `process.env`;
// declared locally because this package carries no Node type dependency.
declare const process: { env: Record<string, string | undefined> };

const provisionExistingOrganizations = internal.seed.mutations.provisionExistingOrganizations;

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const archiveServiceKind = api.serviceKinds.mutations.archiveServiceKind;
const createServiceKind = api.serviceKinds.mutations.createServiceKind;
const createInitialDraftVersion = api.serviceKinds.mutations.createInitialDraftVersion;
const getServiceKindVersion = api.serviceKinds.queries.getServiceKindVersion;
const getServiceKind = api.serviceKinds.queries.getServiceKind;
const listPublishedServiceKinds = api.serviceKinds.queries.listPublishedServiceKinds;
const listBuiltinFieldDefinitions = api.fields.queries.listBuiltinFieldDefinitions;
const listFieldDefinitions = api.fields.queries.listFieldDefinitions;
const getFieldDefinitionsByIds = api.fields.queries.getFieldDefinitionsByIds;

const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 20, cursor: null };
const inaccessible = 'notFoundOrInaccessible';

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: ReturnType<typeof convexTest>, subject: string) {
  const client = t.withIdentity(identity(subject));
  await client.mutation(ensureUser, {});
  return client;
}

const expectedCompositions = new Map<string, readonly [string, boolean][]>([
  ['airportArrivalTransfer', [['pickupLocation', true], ['destination', true], ['passengerCount', true], ['flightNumber', true], ['terminal', false], ['luggageCount', false], ['wheelchairCount', false], ['contactPerson', false], ['notes', false]]],
  ['airportDepartureTransfer', [['pickupLocation', true], ['destination', true], ['passengerCount', true], ['flightNumber', true], ['terminal', false], ['luggageCount', false], ['wheelchairCount', false], ['contactPerson', false], ['notes', false]]],
  ['pointToPointTransfer', [['pickupLocation', true], ['destination', true], ['passengerCount', true], ['luggageCount', false], ['wheelchairCount', false], ['contactPerson', false], ['notes', false]]],
  ['shuttleService', [['pickupLocation', true], ['destination', true], ['passengerCount', true], ['notes', false]]],
]);

test('a new organization atomically receives the shared catalogue and four published starter serviceKinds', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'starter-owner');
  const organizationId = await owner.mutation(createOrganization, { name: 'Starter', slug: 'starter-provisioning' });

  // This works without the demonstration-seed opt-in: built-ins are product
  // bootstrap, while ordinary queries remain the only read surface a client uses.
  const builtins = await owner.query(listBuiltinFieldDefinitions, { paginationOpts: firstPage });
  expect(builtins.page.map((field) => field.key).sort()).toEqual([
    'contactPerson', 'destination', 'flightNumber', 'luggageCount', 'notes', 'passengerCount', 'pickupLocation', 'terminal', 'wheelchairCount',
  ]);
  expect(await owner.query(listFieldDefinitions, { organizationId, paginationOpts: firstPage })).toMatchObject({ page: [] });

  const serviceKinds = await owner.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage });
  expect(serviceKinds.page.map((entry) => [entry.serviceKind.key, entry.serviceKind.name]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))).toEqual([
    ['airportArrivalTransfer', 'Airport Arrival Transfer'],
    ['airportDepartureTransfer', 'Airport Departure Transfer'],
    ['pointToPointTransfer', 'Point to Point Transfer'],
    ['shuttleService', 'Shuttle Service'],
  ]);
  expect(serviceKinds.page.every((entry) => entry.publishedVersion.versionNumber === 1 && entry.publishedVersion.publishedAt !== undefined)).toBe(true);

  for (const entry of serviceKinds.page) {
    const version = await owner.query(getServiceKindVersion, { serviceKindVersionId: entry.publishedVersion._id });
    const definitionIds = version.serviceKindFields.map((field) => field.fieldDefinitionId);
    const definitions = await owner.query(getFieldDefinitionsByIds, { organizationId, fieldDefinitionIds: definitionIds });
    const keys = new Map(definitions.map((definition) => [definition._id, definition.key]));
    expect(version.serviceKindFields
      .sort((left, right) => left.position - right.position)
      .map((field) => [keys.get(field.fieldDefinitionId), field.required]))
      .toEqual(expectedCompositions.get(entry.serviceKind.key));
  }
});

test('catalogue provisioning is shared across organizations and remains opaque to non-members', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'shared-owner');
  const outsider = await provision(t, 'shared-outsider');
  const firstOrganizationId = await owner.mutation(createOrganization, { name: 'First', slug: 'shared-first' });
  const secondOrganizationId = await owner.mutation(createOrganization, { name: 'Second', slug: 'shared-second' });
  const builtins = await owner.query(listBuiltinFieldDefinitions, { paginationOpts: firstPage });
  expect(builtins.page).toHaveLength(9);
  await t.run(async (ctx) => {
    expect(await ctx.db.query('fieldDefinitions').withIndex('by_org_key', (q) => q.eq('organizationId', undefined)).collect()).toHaveLength(9);
  });

  const firstServiceKinds = await owner.query(listPublishedServiceKinds, { organizationId: firstOrganizationId, paginationOpts: firstPage });
  expect((await owner.query(listPublishedServiceKinds, { organizationId: secondOrganizationId, paginationOpts: firstPage })).page).toHaveLength(4);
  const serviceKindId = firstServiceKinds.page[0]?.serviceKind._id;
  if (serviceKindId === undefined) throw new Error('Expected a provisioned starter serviceKind');
  await expect(outsider.query(listPublishedServiceKinds, { organizationId: firstOrganizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.query(getServiceKind, { serviceKindId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.query(listFieldDefinitions, { organizationId: firstOrganizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listPublishedServiceKinds omits archived and draft-only serviceKinds and is membership-gated', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'picker-owner');
  const outsider = await provision(t, 'picker-outsider');
  const organizationId = await owner.mutation(createOrganization, { name: 'Picker', slug: 'picker-provisioning' });
  const before = await owner.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage });
  const archived = before.page.find((entry) => entry.serviceKind.key === 'shuttleService');
  if (archived === undefined) throw new Error('Expected the provisioned shuttle serviceKind');
  await owner.mutation(archiveServiceKind, { serviceKindId: archived.serviceKind._id });
  const draftServiceKindId = await owner.mutation(createServiceKind, { organizationId, key: 'draftOnlyTransfer', name: 'Draft only transfer' });
  await owner.mutation(createInitialDraftVersion, { serviceKindId: draftServiceKindId });

  const after = await owner.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage });
  expect(after.page.map((entry) => entry.serviceKind.key).sort()).toEqual([
    'airportArrivalTransfer', 'airportDepartureTransfer', 'pointToPointTransfer',
  ]);
  await expect(outsider.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('the backfill provisions organizations that predate starter provisioning, idempotently', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'backfill-owner');
  const organizationId = await owner.mutation(createOrganization, { name: 'Legacy', slug: 'legacy-provisioning' });

  // Emulate a tenant created before `createOrganization` provisioned anything by
  // stripping its serviceKinds back out at the table level. Raw writes manufacture
  // the pre-change state only; every assertion below still reads through the
  // ordinary public query.
  await t.run(async (ctx) => {
    for (const version of await ctx.db.query('serviceKindVersions').collect()) await ctx.db.delete(version._id);
    for (const field of await ctx.db.query('serviceKindFields').collect()) await ctx.db.delete(field._id);
    for (const serviceKind of await ctx.db.query('serviceKinds').collect()) await ctx.db.delete(serviceKind._id);
  });
  expect(await owner.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage })).toMatchObject({ page: [] });

  process.env[seedOptInVariable] = 'true';
  try {
    await t.mutation(provisionExistingOrganizations, {});
    const restored = await owner.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage });
    expect(restored.page.map((entry) => entry.serviceKind.key).sort()).toEqual([
      'airportArrivalTransfer', 'airportDepartureTransfer', 'pointToPointTransfer', 'shuttleService',
    ]);

    // Idempotent: a second sweep must not duplicate a serviceKind or a version.
    await t.mutation(provisionExistingOrganizations, {});
    const again = await owner.query(listPublishedServiceKinds, { organizationId, paginationOpts: firstPage });
    expect(again.page.length).toBe(4);
  } finally {
    delete process.env[seedOptInVariable];
  }

  // The deployment opt-in is the guard; `internalMutation` alone is not.
  await expect(t.mutation(provisionExistingOrganizations, {})).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
});
