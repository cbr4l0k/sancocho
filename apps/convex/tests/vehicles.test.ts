import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules, seedOptInVariable } from './helpers';

/**
 * Vehicle Classes (what is planned and priced) and Fleet Vehicles (the plate
 * that arrives) — issue #65.
 *
 * Four tests this issue's scope names live elsewhere by construction, and are
 * deliberately NOT stubbed here because they could only pass vacuously:
 *
 *  - "a Fleet Vehicle from Provider X cannot be attached to Provider Y's
 *    Assignment" is #67; `assignments` does not exist.
 *  - "a granted Provider may USE its matching vehicle" is #69; `writeExecution`
 *    has no write path.
 *  - "class or vehicle deletion refused while referenced by a rate line" is #66.
 *  - "…while referenced by an assignment" is #67.
 *
 * The half of the cross-principal rule that IS testable today — a granted
 * Provider Principal cannot ENUMERATE either catalogue — is tested below, since
 * #71 landed both the grants table and the gate.
 */

// Deployment environment variables reach Convex functions through `process.env`.
declare const process: { env: Record<string, string | undefined> };

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProject = api.projects.mutations.createProject;
const createProvider = api.providers.mutations.createProvider;
const archiveProvider = api.providers.mutations.archiveProvider;
const deleteProvider = api.providers.mutations.deleteProvider;
const grantProjectAccessToProvider = api.providers.mutations.grantProjectAccessToProvider;

const createVehicleClass = api.vehicles.mutations.createVehicleClass;
const updateVehicleClass = api.vehicles.mutations.updateVehicleClass;
const archiveVehicleClass = api.vehicles.mutations.archiveVehicleClass;
const deleteVehicleClass = api.vehicles.mutations.deleteVehicleClass;
const getVehicleClass = api.vehicles.queries.getVehicleClass;
const listVehicleClasses = api.vehicles.queries.listVehicleClasses;

const createFleetVehicle = api.vehicles.mutations.createFleetVehicle;
const updateFleetVehicle = api.vehicles.mutations.updateFleetVehicle;
const archiveFleetVehicle = api.vehicles.mutations.archiveFleetVehicle;
const deleteFleetVehicle = api.vehicles.mutations.deleteFleetVehicle;
const getFleetVehicle = api.vehicles.queries.getFleetVehicle;
const listFleetVehicles = api.vehicles.queries.listFleetVehicles;

const provisionExistingOrganizations = internal.seed.mutations.provisionExistingOrganizations;

const inaccessible = 'notFoundOrInaccessible';
const unauthenticated = 'unauthenticated';
const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 25, cursor: null };

/** The starter catalogue every organization receives at creation time. */
const starterKeys = ['cargoTruck', 'cargoVan', 'coach', 'minibus', 'sedan', 'suv', 'van'];

type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId: Id<'users'> = await client.mutation(ensureUser, {});
  return { client, userId };
}

/** A coordinator tenant with one Provider and one tenant-authored Vehicle Class. */
async function fixture(t: SchemaTest, slug: string) {
  const owner = await provision(t, `vehicles-owner-${slug}`);
  const organizationId: Id<'organizations'> = await owner.client.mutation(createOrganization, { name: 'Andes Producciones', slug });
  const providerId: Id<'providers'> = await owner.client.mutation(createProvider, { organizationId, name: 'TransAndes SAS' });
  const vehicleClassId: Id<'vehicleClasses'> = await owner.client.mutation(createVehicleClass, {
    organizationId,
    key: 'sprinter18',
    name: 'Sprinter 18 pax',
    description: 'Sprinter configured for eighteen passengers.',
    passengerCapacity: 18,
  });
  return { owner, organizationId, providerId, vehicleClassId };
}

function auditsFor(
  t: SchemaTest,
  organizationId: Id<'organizations'>,
  entityType: 'vehicleClass' | 'fleetVehicle',
  entityId: string,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', entityType).eq('entityId', entityId))
      .collect(),
  );
}

// ---------------------------------------------------------------------------
// Vehicle Classes
// ---------------------------------------------------------------------------

test('Vehicle Class creation trims the name, derives searchable text from key AND name, and starts active', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, vehicleClassId } = await fixture(t, 'vehicles-create');

  await t.run(async (ctx) => {
    expect(await ctx.db.get(vehicleClassId)).toMatchObject({
      organizationId,
      key: 'sprinter18',
      name: 'Sprinter 18 pax',
      description: 'Sprinter configured for eighteen passengers.',
      passengerCapacity: 18,
      // Server-derived from key AND name; never client-supplied (I4).
      searchText: 'sprinter18 sprinter 18 pax',
      status: 'active',
    });
  });

  const trimmedId = await owner.client.mutation(createVehicleClass, { organizationId, key: 'duster', name: '  Duster  ' });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(trimmedId)).toMatchObject({ name: 'Duster', searchText: 'duster duster' });
  });

  // The derived column is not merely stored: it is what search actually reads,
  // by the KEY as well as by the name.
  await expect(owner.client.query(listVehicleClasses, { organizationId, paginationOpts: firstPage, search: 'sprinter18' })).resolves.toMatchObject({
    page: [{ _id: vehicleClassId }],
  });
  await expect(owner.client.query(listVehicleClasses, { organizationId, paginationOpts: firstPage, search: 'Sprinter 18 pax' })).resolves.toMatchObject({
    page: [{ _id: vehicleClassId }],
  });

  // A rename re-derives it against the STORED key, so search follows the name.
  await owner.client.mutation(updateVehicleClass, { vehicleClassId, name: 'Sprinter Ejecutiva' });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(vehicleClassId))?.searchText).toBe('sprinter18 sprinter ejecutiva');
  });
  await expect(owner.client.query(listVehicleClasses, { organizationId, paginationOpts: firstPage, search: 'ejecutiva' })).resolves.toMatchObject({
    page: [{ _id: vehicleClassId }],
  });
});

test('Vehicle Class keys are unique per organization and scoped to the tenant', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await fixture(t, 'vehicles-keys');

  await expect(owner.client.mutation(createVehicleClass, { organizationId, key: 'sprinter18', name: 'Another Sprinter' })).rejects.toMatchObject({
    data: { code: 'conflict' },
  });
  // A starter key is an ordinary tenant key and collides the same way.
  await expect(owner.client.mutation(createVehicleClass, { organizationId, key: 'coach', name: 'Bus grande' })).rejects.toMatchObject({
    data: { code: 'conflict' },
  });
  // The constraint is per-tenant, not global.
  const otherOrganizationId = await owner.client.mutation(createOrganization, { name: 'Otra', slug: 'vehicles-keys-other' });
  await expect(owner.client.mutation(createVehicleClass, { organizationId: otherOrganizationId, key: 'sprinter18', name: 'Sprinter 18 pax' })).resolves.toBeDefined();

  for (const key of ['A', 'x', 'Sprinter', '18pax', 'has space', 'has-hyphen', 'a'.repeat(65)]) {
    await expect(owner.client.mutation(createVehicleClass, { organizationId, key, name: 'Rejected' })).rejects.toMatchObject({
      data: { code: 'vehicleClassKeyInvalid' },
    });
  }
});

test('Vehicle Class free-form columns and passenger capacity are bounded', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, vehicleClassId } = await fixture(t, 'vehicles-bounds');

  await expect(owner.client.mutation(createVehicleClass, { organizationId, key: 'blank', name: '   ' })).rejects.toMatchObject({
    data: { code: 'entityNameInvalid' },
  });
  await expect(
    owner.client.mutation(createVehicleClass, { organizationId, key: 'longDesc', name: 'Long', description: 'x'.repeat(2001) }),
  ).rejects.toMatchObject({ data: { code: 'vehicleClassDescriptionTooLong' } });
  await expect(
    owner.client.mutation(createVehicleClass, { organizationId, key: 'longCargo', name: 'Long', cargoCapacityNote: 'x'.repeat(201) }),
  ).rejects.toMatchObject({ data: { code: 'vehicleClassCargoNoteTooLong' } });
  for (const passengerCapacity of [-1, 1.5, 1001, Number.NaN]) {
    await expect(
      owner.client.mutation(createVehicleClass, { organizationId, key: 'badCapacity', name: 'Bad', passengerCapacity }),
    ).rejects.toMatchObject({ data: { code: 'vehicleClassCapacityInvalid' } });
    await expect(owner.client.mutation(updateVehicleClass, { vehicleClassId, passengerCapacity })).rejects.toMatchObject({
      data: { code: 'vehicleClassCapacityInvalid' },
    });
  }
  // Nothing rejected reached the database.
  await t.run(async (ctx) => {
    expect(await ctx.db.get(vehicleClassId)).toMatchObject({ passengerCapacity: 18 });
  });
});

test('the starter Vehicle Class catalogue is provisioned at creation and re-provisioning is idempotent per key', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'vehicles-starter-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Starter', slug: 'vehicles-starter' });

  const provisioned = await owner.client.query(listVehicleClasses, { organizationId, paginationOpts: firstPage });
  expect(provisioned.page.map((row) => row.key).sort()).toEqual(starterKeys);
  expect(provisioned.page.every((row) => row.status === 'active' && row.organizationId === organizationId)).toBe(true);
  expect(provisioned.page.find((row) => row.key === 'coach')).toMatchObject({ name: 'Coach', passengerCapacity: 45 });
  expect(provisioned.page.find((row) => row.key === 'cargoVan')?.cargoCapacityNote).toBeDefined();
  // A tenant edits a starter row like any other: it is vocabulary, not an enum.
  const sedanId = provisioned.page.find((row) => row.key === 'sedan')?._id;
  if (sedanId === undefined) throw new Error('Expected the provisioned sedan class');
  await expect(owner.client.mutation(updateVehicleClass, { vehicleClassId: sedanId, name: 'Gama media' })).resolves.toBeNull();

  // The tenant deletes exactly one starter class...
  const coachId = provisioned.page.find((row) => row.key === 'coach')?._id;
  if (coachId === undefined) throw new Error('Expected the provisioned coach class');
  await owner.client.mutation(archiveVehicleClass, { vehicleClassId: coachId });
  await owner.client.mutation(deleteVehicleClass, { vehicleClassId: coachId });
  expect((await owner.client.query(listVehicleClasses, { organizationId, paginationOpts: firstPage })).page).toHaveLength(6);

  process.env[seedOptInVariable] = 'true';
  try {
    // ...and re-provisioning restores only that one. A global "already ran" flag
    // would restore nothing; a missing skip would duplicate the other six.
    await t.mutation(provisionExistingOrganizations, {});
    const restored = await owner.client.query(listVehicleClasses, { organizationId, paginationOpts: firstPage });
    expect(restored.page.map((row) => row.key).sort()).toEqual(starterKeys);
    expect(restored.page).toHaveLength(7);
    // The tenant's own edit survived: the skip is per key, not a rewrite.
    expect(restored.page.find((row) => row.key === 'sedan')?.name).toBe('Gama media');

    // A second sweep changes nothing at all.
    await t.mutation(provisionExistingOrganizations, {});
    const again = await owner.client.query(listVehicleClasses, { organizationId, paginationOpts: firstPage });
    expect(again.page).toHaveLength(7);
    expect(again.page.map((row) => row.key).sort()).toEqual(starterKeys);
    expect(again.page.find((row) => row.key === 'sedan')?.name).toBe('Gama media');
  } finally {
    delete process.env[seedOptInVariable];
  }

  // Read at the table level too: a duplicate hidden past `numItems` would still
  // be a duplicate, and the public page cannot prove its own completeness.
  await t.run(async (ctx) => {
    const rows = await ctx.db.query('vehicleClasses').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.key)).size).toBe(7);
  });
});

test('archived Vehicle Classes stay readable but refuse every update', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, vehicleClassId } = await fixture(t, 'vehicles-class-archived');
  await owner.client.mutation(archiveVehicleClass, { vehicleClassId });

  const archived = { data: { code: 'vehicleClassArchived' } };
  await expect(owner.client.mutation(updateVehicleClass, { vehicleClassId, name: 'No' })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateVehicleClass, { vehicleClassId, description: 'No' })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateVehicleClass, { vehicleClassId, passengerCapacity: 9 })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateVehicleClass, { vehicleClassId, cargoCapacityNote: 'No' })).rejects.toMatchObject(archived);
  await t.run(async (ctx) => {
    expect(await ctx.db.get(vehicleClassId)).toMatchObject({ name: 'Sprinter 18 pax', passengerCapacity: 18, status: 'archived' });
  });
  await expect(owner.client.query(getVehicleClass, { vehicleClassId })).resolves.toMatchObject({ status: 'archived' });

  // An archived class is also unusable as a NEW reference, and the refusal is
  // the generic error — a caller must not learn a class exists but is archived.
  const providerId = await owner.client.mutation(createProvider, { organizationId, name: 'Otro proveedor' });
  await expect(
    owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'XYZ 999' }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('an unreferenced Vehicle Class deletes after archival; one a Fleet Vehicle still names is refused', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-class-delete');

  await expect(owner.client.mutation(deleteVehicleClass, { vehicleClassId })).rejects.toMatchObject({
    data: { code: 'vehicleClassArchiveRequired' },
  });

  const fleetVehicleId = await owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'ABC 123' });
  await owner.client.mutation(archiveVehicleClass, { vehicleClassId });
  await expect(owner.client.mutation(deleteVehicleClass, { vehicleClassId })).rejects.toMatchObject({
    data: { code: 'vehicleClassDeleteBlocked' },
  });
  // Archiving the referencing vehicle does not release the class: the reference
  // is the row, not its status.
  await owner.client.mutation(archiveFleetVehicle, { fleetVehicleId });
  await expect(owner.client.mutation(deleteVehicleClass, { vehicleClassId })).rejects.toMatchObject({
    data: { code: 'vehicleClassDeleteBlocked' },
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(vehicleClassId)).not.toBeNull();
  });

  // Destroying the last referencing vehicle releases it.
  await owner.client.mutation(deleteFleetVehicle, { fleetVehicleId });
  await expect(owner.client.mutation(deleteVehicleClass, { vehicleClassId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(vehicleClassId)).toBeNull();
  });
  await expect(owner.client.query(getVehicleClass, { vehicleClassId })).rejects.toMatchObject({ data: { code: inaccessible } });
});

// ---------------------------------------------------------------------------
// Fleet Vehicles
// ---------------------------------------------------------------------------

test('a Fleet Vehicle stores the typed plate, derives its normalised key and search text, and starts active', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-fleet-create');
  const fleetVehicleId = await owner.client.mutation(createFleetVehicle, {
    organizationId,
    providerId,
    vehicleClassId,
    plate: '  abc-123  ',
    label: '  Van 4  ',
    year: 2019,
    notes: 'Night shift only',
  });

  await t.run(async (ctx) => {
    expect(await ctx.db.get(fleetVehicleId)).toMatchObject({
      organizationId,
      providerId,
      vehicleClassId,
      // The display value is what was typed, trimmed — not the key.
      plate: 'abc-123',
      // Server-derived, never client-supplied (I4).
      plateKey: 'ABC123',
      label: 'Van 4',
      year: 2019,
      notes: 'Night shift only',
      searchText: 'abc 123 abc123 van 4',
      status: 'active',
    });
  });

  // The derived text is what search reads, in EITHER spelling.
  for (const search of ['abc123', 'abc-123', 'ABC 123', 'van 4']) {
    await expect(owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, search })).resolves.toMatchObject({
      page: [{ _id: fleetVehicleId }],
    });
  }

  // A re-plate re-derives both the key and the search text.
  await owner.client.mutation(updateFleetVehicle, { fleetVehicleId, plate: 'XYZ-789' });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(fleetVehicleId)).toMatchObject({ plate: 'XYZ-789', plateKey: 'XYZ789', searchText: 'xyz 789 xyz789 van 4' });
  });
  await expect(owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, search: 'xyz789' })).resolves.toMatchObject({
    page: [{ _id: fleetVehicleId }],
  });
  await expect(owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, search: 'abc123' })).resolves.toMatchObject({ page: [] });
});

test('plates are unique per organization across formatting variants', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-plate-unique');
  const secondProviderId = await owner.client.mutation(createProvider, { organizationId, name: 'Otro proveedor' });
  const firstId = await owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'ABC 123' });

  // Real formatting variants of one plate, not a byte-identical resubmit.
  for (const duplicate of ['ABC 123', 'abc-123', '  abc123  ', 'a.b.c.1.2.3', 'AbC 123']) {
    await expect(
      owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: duplicate }),
    ).rejects.toMatchObject({ data: { code: 'conflict' } });
    // A DIFFERENT Provider does not get its own namespace: the key is the tenant's.
    await expect(
      owner.client.mutation(createFleetVehicle, { organizationId, providerId: secondProviderId, vehicleClassId, plate: duplicate }),
    ).rejects.toMatchObject({ data: { code: 'conflict' } });
  }

  // A genuinely different plate is unaffected...
  const secondId = await owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'ABC 124' });
  // ...and the constraint is per-tenant, not global.
  const other = await fixture(t, 'vehicles-plate-unique-other');
  await expect(
    other.owner.client.mutation(createFleetVehicle, {
      organizationId: other.organizationId,
      providerId: other.providerId,
      vehicleClassId: other.vehicleClassId,
      plate: 'abc123',
    }),
  ).resolves.toBeDefined();

  // A re-plate cannot edit its way past the same rule...
  await expect(owner.client.mutation(updateFleetVehicle, { fleetVehicleId: secondId, plate: 'abc-123' })).rejects.toMatchObject({
    data: { code: 'conflict' },
  });
  // ...but re-formatting a row's OWN plate is not a collision with itself.
  await expect(owner.client.mutation(updateFleetVehicle, { fleetVehicleId: firstId, plate: 'ABC-123' })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(firstId)).toMatchObject({ plate: 'ABC-123', plateKey: 'ABC123' });
    expect(await ctx.db.get(secondId)).toMatchObject({ plate: 'ABC 124', plateKey: 'ABC124' });
    const rows = await ctx.db.query('fleetVehicles').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    expect(rows).toHaveLength(2);
  });

  for (const plate of ['', '   ', '---', 'x'.repeat(33)]) {
    await expect(
      owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate }),
    ).rejects.toMatchObject({ data: { code: 'fleetVehiclePlateInvalid' } });
  }
});

test('a Fleet Vehicle proves both referenced ids belong to the coordinator organization, at insert and at update', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-cross-org');
  const foreign = await fixture(t, 'vehicles-cross-org-foreign');
  const fleetVehicleId = await owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'AAA 111' });

  // A cross-organization PROVIDER, with a class the caller does own.
  await expect(
    owner.client.mutation(createFleetVehicle, { organizationId, providerId: foreign.providerId, vehicleClassId, plate: 'BBB 222' }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.client.mutation(updateFleetVehicle, { fleetVehicleId, providerId: foreign.providerId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });

  // A cross-organization CLASS, with a provider the caller does own. Asserted
  // separately so one check standing in for both cannot pass this test.
  await expect(
    owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId: foreign.vehicleClassId, plate: 'CCC 333' }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.client.mutation(updateFleetVehicle, { fleetVehicleId, vehicleClassId: foreign.vehicleClassId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });

  // A fabricated id of either kind is exactly as opaque (I9).
  const goneProviderId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('providers', { organizationId, name: 'Gone', searchText: 'gone', status: 'active' });
    await ctx.db.delete(id);
    return id;
  });
  const goneClassId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('vehicleClasses', { organizationId, key: 'gone', name: 'Gone', searchText: 'gone', status: 'active' });
    await ctx.db.delete(id);
    return id;
  });
  await expect(
    owner.client.mutation(createFleetVehicle, { organizationId, providerId: goneProviderId, vehicleClassId, plate: 'DDD 444' }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId: goneClassId, plate: 'EEE 555' }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  // An ARCHIVED foreign Provider is refused with the same generic code: a caller
  // must not learn that another tenant's Provider exists but is out of service.
  await foreign.owner.client.mutation(archiveProvider, { providerId: foreign.providerId });
  await expect(
    owner.client.mutation(createFleetVehicle, { organizationId, providerId: foreign.providerId, vehicleClassId, plate: 'FFF 666' }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  // Nothing rejected reached the database, and the row still names its own pair.
  await t.run(async (ctx) => {
    expect(await ctx.db.get(fleetVehicleId)).toMatchObject({ providerId, vehicleClassId, plate: 'AAA 111' });
    const rows = await ctx.db.query('fleetVehicles').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    expect(rows).toHaveLength(1);
  });

  // Re-pointing at another Provider and Class the tenant DOES own is allowed.
  const secondProviderId = await owner.client.mutation(createProvider, { organizationId, name: 'Segundo proveedor' });
  const secondClassId = await owner.client.mutation(createVehicleClass, { organizationId, key: 'coachPlus', name: 'Coach Plus' });
  await expect(
    owner.client.mutation(updateFleetVehicle, { fleetVehicleId, providerId: secondProviderId, vehicleClassId: secondClassId }),
  ).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(fleetVehicleId)).toMatchObject({ providerId: secondProviderId, vehicleClassId: secondClassId });
  });
});

test('archived Fleet Vehicles stay readable but refuse every update', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-fleet-archived');
  const fleetVehicleId = await owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'ABC 123', label: 'Van 4' });
  const secondClassId = await owner.client.mutation(createVehicleClass, { organizationId, key: 'coachPlus', name: 'Coach Plus' });
  await owner.client.mutation(archiveFleetVehicle, { fleetVehicleId });

  const archived = { data: { code: 'fleetVehicleArchived' } };
  await expect(owner.client.mutation(updateFleetVehicle, { fleetVehicleId, plate: 'ZZZ 999' })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateFleetVehicle, { fleetVehicleId, label: 'No' })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateFleetVehicle, { fleetVehicleId, year: 2001 })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateFleetVehicle, { fleetVehicleId, notes: 'No' })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateFleetVehicle, { fleetVehicleId, vehicleClassId: secondClassId })).rejects.toMatchObject(archived);
  await t.run(async (ctx) => {
    expect(await ctx.db.get(fleetVehicleId)).toMatchObject({ plate: 'ABC 123', label: 'Van 4', vehicleClassId, status: 'archived' });
  });
  await expect(owner.client.query(getFleetVehicle, { fleetVehicleId })).resolves.toMatchObject({ status: 'archived' });
  // Archiving is idempotent and records no second row.
  await expect(owner.client.mutation(archiveFleetVehicle, { fleetVehicleId })).resolves.toBeNull();
});

test('Fleet Vehicle free-form columns and model year are bounded', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-fleet-bounds');
  const base = { organizationId, providerId, vehicleClassId };

  await expect(owner.client.mutation(createFleetVehicle, { ...base, plate: 'AAA 111', label: 'x'.repeat(201) })).rejects.toMatchObject({
    data: { code: 'fleetVehicleLabelInvalid' },
  });
  await expect(owner.client.mutation(createFleetVehicle, { ...base, plate: 'AAA 111', notes: 'x'.repeat(2001) })).rejects.toMatchObject({
    data: { code: 'fleetVehicleNotesTooLong' },
  });
  for (const year of [1899, 2201, 2019.5, Number.NaN]) {
    await expect(owner.client.mutation(createFleetVehicle, { ...base, plate: 'AAA 111', year })).rejects.toMatchObject({
      data: { code: 'fleetVehicleYearInvalid' },
    });
  }
  await t.run(async (ctx) => {
    expect(await ctx.db.query('fleetVehicles').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).toHaveLength(0);
  });
});

test('an unreferenced Fleet Vehicle deletes after archival, and its Provider cannot be destroyed while it exists', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-fleet-delete');
  const fleetVehicleId = await owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'ABC 123' });

  await expect(owner.client.mutation(deleteFleetVehicle, { fleetVehicleId })).rejects.toMatchObject({
    data: { code: 'fleetVehicleArchiveRequired' },
  });

  // The Provider delete guard gained a third referencer with this issue.
  await owner.client.mutation(archiveProvider, { providerId });
  await expect(owner.client.mutation(deleteProvider, { providerId })).rejects.toMatchObject({ data: { code: 'providerDeleteBlocked' } });
  await owner.client.mutation(archiveFleetVehicle, { fleetVehicleId });
  // An ARCHIVED vehicle still pins its Provider: the reference is the row.
  await expect(owner.client.mutation(deleteProvider, { providerId })).rejects.toMatchObject({ data: { code: 'providerDeleteBlocked' } });

  await expect(owner.client.mutation(deleteFleetVehicle, { fleetVehicleId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(fleetVehicleId)).toBeNull();
  });
  await expect(owner.client.query(getFleetVehicle, { fleetVehicleId })).rejects.toMatchObject({ data: { code: inaccessible } });
  // Destroying the last vehicle releases the Provider.
  await expect(owner.client.mutation(deleteProvider, { providerId })).resolves.toBeNull();
});

// ---------------------------------------------------------------------------
// Indexed filters and pagination (I6)
// ---------------------------------------------------------------------------

test('Provider and Class filters narrow the query, not an already-fetched page', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-filters');
  const otherProviderId = await owner.client.mutation(createProvider, { organizationId, name: 'Buses del Norte' });
  const otherClassId = await owner.client.mutation(createVehicleClass, { organizationId, key: 'coachPlus', name: 'Coach Plus' });

  // Four rows per (Provider, Class) pair, interleaved on purpose: a filter
  // applied to an already-fetched page would return at most one row for
  // `numItems: 2`, so a short first page is the signature of a post-page filter.
  // Multiple rows per bucket also mean a scoped and an unscoped query can never
  // look identical.
  const created = new Map<string, Id<'fleetVehicles'>[]>();
  for (const [providerIndex, provider] of [providerId, otherProviderId].entries()) {
    for (const [classIndex, klass] of [vehicleClassId, otherClassId].entries()) {
      const bucket: Id<'fleetVehicles'>[] = [];
      for (let index = 0; index < 4; index += 1) {
        bucket.push(
          await owner.client.mutation(createFleetVehicle, {
            organizationId,
            providerId: provider,
            vehicleClassId: klass,
            plate: `P${providerIndex}C${classIndex}N${index}`,
          }),
        );
      }
      created.set(`${providerIndex}-${classIndex}`, bucket);
    }
  }
  const idsFor = (...keys: string[]) => keys.flatMap((key) => created.get(key) ?? []).sort();

  const unfiltered = await owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage });
  expect(unfiltered.page).toHaveLength(16);

  const byProvider = await owner.client.query(listFleetVehicles, { organizationId, paginationOpts: { numItems: 2, cursor: null }, providerId });
  expect(byProvider.page).toHaveLength(2);
  expect(byProvider.page.every((row) => row.providerId === providerId)).toBe(true);
  const byProviderRest = await owner.client.query(listFleetVehicles, {
    organizationId,
    paginationOpts: { numItems: 20, cursor: byProvider.continueCursor },
    providerId,
  });
  expect([...byProvider.page, ...byProviderRest.page].map((row) => row._id).sort()).toEqual(idsFor('0-0', '0-1'));

  const byClass = await owner.client.query(listFleetVehicles, { organizationId, paginationOpts: { numItems: 2, cursor: null }, vehicleClassId });
  expect(byClass.page).toHaveLength(2);
  const byClassRest = await owner.client.query(listFleetVehicles, {
    organizationId,
    paginationOpts: { numItems: 20, cursor: byClass.continueCursor },
    vehicleClassId,
  });
  expect([...byClass.page, ...byClassRest.page].map((row) => row._id).sort()).toEqual(idsFor('0-0', '1-0'));

  const both = await owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, providerId, vehicleClassId });
  expect(both.page.map((row) => row._id).sort()).toEqual(idsFor('0-0'));
  expect(both.page).toHaveLength(4);

  // The filters compose with status on the same indexes, before pagination.
  const archivedId = idsFor('0-0')[0];
  if (archivedId === undefined) throw new Error('Expected a vehicle to archive');
  await owner.client.mutation(archiveFleetVehicle, { fleetVehicleId: archivedId });
  await expect(
    owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, providerId, vehicleClassId, status: 'archived' }),
  ).resolves.toMatchObject({ page: [{ _id: archivedId }] });
  const activePair = await owner.client.query(listFleetVehicles, {
    organizationId, paginationOpts: firstPage, providerId, vehicleClassId, status: 'active',
  });
  expect(activePair.page).toHaveLength(3);
  const archivedAll = await owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, status: 'archived' });
  expect(archivedAll.page.map((row) => row._id)).toEqual([archivedId]);
  const activeByProvider = await owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, providerId, status: 'active' });
  expect(activeByProvider.page).toHaveLength(7);
  const activeByClass = await owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, vehicleClassId, status: 'active' });
  expect(activeByClass.page).toHaveLength(7);

  // Search composes with both filters through the search index, never after it.
  await expect(
    owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, search: 'P0C0N1', providerId, vehicleClassId }),
  ).resolves.toMatchObject({ page: [{ _id: idsFor('0-0')[1] }] });
  await expect(
    owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, search: 'P0C0N1', providerId: otherProviderId }),
  ).resolves.toMatchObject({ page: [] });
  await expect(owner.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, search: 'x'.repeat(101) })).rejects.toMatchObject({
    data: { code: 'searchTermTooLong' },
  });
});

test('vehicle lists paginate with a continuation cursor and a correct second page', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-pagination');
  const plates = ['AAA 111', 'BBB 222', 'CCC 333'];
  const fleetIds: Id<'fleetVehicles'>[] = [];
  for (const plate of plates) {
    fleetIds.push(await owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate }));
  }
  const foreign = await fixture(t, 'vehicles-pagination-foreign');
  await foreign.owner.client.mutation(createFleetVehicle, {
    organizationId: foreign.organizationId, providerId: foreign.providerId, vehicleClassId: foreign.vehicleClassId, plate: 'ZZZ 999',
  });

  const firstFleet = await owner.client.query(listFleetVehicles, { organizationId, paginationOpts: { numItems: 2, cursor: null } });
  expect(firstFleet.page).toHaveLength(2);
  expect(firstFleet.isDone).toBe(false);
  expect(firstFleet.continueCursor).not.toBe('');
  const secondFleet = await owner.client.query(listFleetVehicles, { organizationId, paginationOpts: { numItems: 2, cursor: firstFleet.continueCursor } });
  expect(secondFleet.page).toHaveLength(1);
  expect(secondFleet.isDone).toBe(true);
  expect([...firstFleet.page, ...secondFleet.page].map((row) => row._id).sort()).toEqual([...fleetIds].sort());
  expect([...firstFleet.page, ...secondFleet.page].every((row) => row.organizationId === organizationId)).toBe(true);

  // The class catalogue pages the same way: seven starter rows plus one authored.
  const firstClasses = await owner.client.query(listVehicleClasses, { organizationId, paginationOpts: { numItems: 5, cursor: null } });
  expect(firstClasses.page).toHaveLength(5);
  expect(firstClasses.isDone).toBe(false);
  const secondClasses = await owner.client.query(listVehicleClasses, { organizationId, paginationOpts: { numItems: 5, cursor: firstClasses.continueCursor } });
  expect(secondClasses.page).toHaveLength(3);
  expect(secondClasses.isDone).toBe(true);
  const allKeys = [...firstClasses.page, ...secondClasses.page].map((row) => row.key).sort();
  expect(allKeys).toEqual([...starterKeys, 'sprinter18'].sort());
  expect(new Set([...firstClasses.page, ...secondClasses.page].map((row) => row._id)).size).toBe(8);
});

// ---------------------------------------------------------------------------
// Authorization: role floor, opacity, and the second principal arm
// ---------------------------------------------------------------------------

test('a planner is below the configuration floor on every catalogue write, while reads stay open to members', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-roles');
  const fleetVehicleId = await owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'ABC 123' });
  const planner = await provision(t, 'vehicles-planner');
  const viewer = await provision(t, 'vehicles-viewer');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });

  for (const below of [planner, viewer]) {
    const refused = { data: { code: inaccessible } };
    await expect(below.client.mutation(createVehicleClass, { organizationId, key: 'forbidden', name: 'Forbidden' })).rejects.toMatchObject(refused);
    await expect(below.client.mutation(updateVehicleClass, { vehicleClassId, name: 'No' })).rejects.toMatchObject(refused);
    await expect(below.client.mutation(archiveVehicleClass, { vehicleClassId })).rejects.toMatchObject(refused);
    await expect(below.client.mutation(deleteVehicleClass, { vehicleClassId })).rejects.toMatchObject(refused);
    await expect(
      below.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'NOP 000' }),
    ).rejects.toMatchObject(refused);
    await expect(below.client.mutation(updateFleetVehicle, { fleetVehicleId, plate: 'NOP 000' })).rejects.toMatchObject(refused);
    await expect(below.client.mutation(archiveFleetVehicle, { fleetVehicleId })).rejects.toMatchObject(refused);
    await expect(below.client.mutation(deleteFleetVehicle, { fleetVehicleId })).rejects.toMatchObject(refused);

    // Reads stay open to any member of the tenant.
    await expect(below.client.query(getVehicleClass, { vehicleClassId })).resolves.toMatchObject({ _id: vehicleClassId });
    await expect(below.client.query(getFleetVehicle, { fleetVehicleId })).resolves.toMatchObject({ _id: fleetVehicleId });
    await expect(below.client.query(listVehicleClasses, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({
      page: expect.arrayContaining([expect.objectContaining({ _id: vehicleClassId })]),
    });
    await expect(below.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({
      page: [expect.objectContaining({ _id: fleetVehicleId })],
    });
  }

  // Nothing either of them attempted reached the database.
  await t.run(async (ctx) => {
    expect(await ctx.db.get(vehicleClassId)).toMatchObject({ name: 'Sprinter 18 pax', status: 'active' });
    expect(await ctx.db.get(fleetVehicleId)).toMatchObject({ plate: 'ABC 123', status: 'active' });
  });
});

test('every public vehicle function is opaque to unauthenticated, fabricated, foreign, and non-member callers', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId, vehicleClassId } = await fixture(t, 'vehicles-opacity');
  const fleetVehicleId = await owner.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'ABC 123' });
  const outsider = await provision(t, 'vehicles-outsider');

  const missingClassId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('vehicleClasses', { organizationId, key: 'temp', name: 'Temporary', searchText: 'temp temporary', status: 'active' });
    await ctx.db.delete(id);
    return id;
  });
  const missingVehicleId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('fleetVehicles', {
      organizationId, providerId, vehicleClassId, plate: 'TMP 000', plateKey: 'TMP000', searchText: 'tmp 000 tmp000', status: 'active',
    });
    await ctx.db.delete(id);
    return id;
  });

  for (const id of [vehicleClassId, missingClassId]) {
    await expect(t.query(getVehicleClass, { vehicleClassId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(updateVehicleClass, { vehicleClassId: id, name: 'No' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(archiveVehicleClass, { vehicleClassId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(deleteVehicleClass, { vehicleClassId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(outsider.client.query(getVehicleClass, { vehicleClassId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(updateVehicleClass, { vehicleClassId: id, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(archiveVehicleClass, { vehicleClassId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(deleteVehicleClass, { vehicleClassId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  for (const id of [fleetVehicleId, missingVehicleId]) {
    await expect(t.query(getFleetVehicle, { fleetVehicleId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(updateFleetVehicle, { fleetVehicleId: id, plate: 'NOP 000' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(archiveFleetVehicle, { fleetVehicleId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(deleteFleetVehicle, { fleetVehicleId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(outsider.client.query(getFleetVehicle, { fleetVehicleId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(updateFleetVehicle, { fleetVehicleId: id, plate: 'NOP 000' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(archiveFleetVehicle, { fleetVehicleId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(deleteFleetVehicle, { fleetVehicleId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  const goneOrganizationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', { name: 'Gone', slug: 'vehicles-gone' });
    await ctx.db.delete(id);
    return id;
  });
  for (const orgId of [organizationId, goneOrganizationId]) {
    await expect(t.query(listVehicleClasses, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.query(listFleetVehicles, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(createVehicleClass, { organizationId: orgId, key: 'intruder', name: 'Intruder' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(
      t.mutation(createFleetVehicle, { organizationId: orgId, providerId, vehicleClassId, plate: 'NOP 000' }),
    ).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(outsider.client.query(listVehicleClasses, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.query(listFleetVehicles, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(createVehicleClass, { organizationId: orgId, key: 'intruder', name: 'Intruder' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(
      outsider.client.mutation(createFleetVehicle, { organizationId: orgId, providerId, vehicleClassId, plate: 'NOP 000' }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  // A member in good standing OF ANOTHER TENANT is exactly as opaque as a stranger.
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Otra', slug: 'vehicles-opacity-foreign' });
  await owner.client.mutation(addMember, { organizationId: foreignOrganizationId, userId: outsider.userId, role: 'owner' });
  await expect(outsider.client.query(getVehicleClass, { vehicleClassId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.query(getFleetVehicle, { fleetVehicleId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.query(listVehicleClasses, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });

  await t.run(async (ctx) => {
    expect(await ctx.db.get(vehicleClassId)).toMatchObject({ name: 'Sprinter 18 pax', status: 'active' });
    expect(await ctx.db.get(fleetVehicleId)).toMatchObject({ plate: 'ABC 123', status: 'active' });
  });
});

test('a granted Provider Principal cannot enumerate or read either catalogue', async () => {
  const t = convexTest(schema, modules);
  const coordinator = await provision(t, 'vehicles-grant-coordinator');
  const organizationId = await coordinator.client.mutation(createOrganization, { name: 'Andes Producciones', slug: 'vehicles-grant' });
  const projectId = await coordinator.client.mutation(createProject, { organizationId, name: 'Festival Cordillera' });
  const vehicleClassId = await coordinator.client.mutation(createVehicleClass, { organizationId, key: 'sprinter18', name: 'Sprinter 18 pax' });

  // The provider firm is its OWN tenant, claimed by the coordinator's directory
  // row, and granted access to this one Project.
  const providerFirm = await provision(t, 'vehicles-grant-firm');
  const providerOrganizationId = await providerFirm.client.mutation(createOrganization, { name: 'TransAndes', slug: 'vehicles-grant-firm' });
  const providerId = await coordinator.client.mutation(createProvider, { organizationId, name: 'TransAndes SAS' });
  // Stands in for #86's verified claim mutation, exactly as providers.test.ts does.
  await t.run(async (ctx) => ctx.db.patch(providerId, { linkedOrganizationId: providerOrganizationId }));
  await coordinator.client.mutation(grantProjectAccessToProvider, { projectId, providerId });

  // ITS OWN vehicle: the row the coordinator recorded for this very firm.
  const ownVehicleId = await coordinator.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'ABC 123' });
  // And a rival firm's vehicle in the same coordinator tenant.
  const rivalProviderId = await coordinator.client.mutation(createProvider, { organizationId, name: 'Buses del Norte' });
  const rivalVehicleId = await coordinator.client.mutation(createFleetVehicle, { organizationId, providerId: rivalProviderId, vehicleClassId, plate: 'XYZ 789' });

  const provider = providerFirm.client;
  const expectRefused = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ data: { code: inaccessible } });

  // The catalogue is not browsable — not even the half that describes the firm
  // itself. A grant confers assignment-scoped capabilities, never enumeration.
  await expectRefused(provider.query(listVehicleClasses, { organizationId, paginationOpts: firstPage }));
  await expectRefused(provider.query(listFleetVehicles, { organizationId, paginationOpts: firstPage }));
  // Nor by narrowing the query to its own Provider id.
  await expectRefused(provider.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, providerId }));
  await expectRefused(provider.query(listFleetVehicles, { organizationId, paginationOpts: firstPage, vehicleClassId }));
  // Nor one row at a time, by either id it could plausibly hold.
  await expectRefused(provider.query(getVehicleClass, { vehicleClassId }));
  await expectRefused(provider.query(getFleetVehicle, { fleetVehicleId: ownVehicleId }));
  await expectRefused(provider.query(getFleetVehicle, { fleetVehicleId: rivalVehicleId }));
  // And it writes nothing: the configuration floor is a coordinator membership.
  await expectRefused(provider.mutation(createVehicleClass, { organizationId, key: 'intruder', name: 'Intruder' }));
  await expectRefused(provider.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'NOP 000' }));
  await expectRefused(provider.mutation(updateFleetVehicle, { fleetVehicleId: ownVehicleId, plate: 'NOP 000' }));
  await expectRefused(provider.mutation(archiveFleetVehicle, { fleetVehicleId: ownVehicleId }));
  await expectRefused(provider.mutation(deleteFleetVehicle, { fleetVehicleId: ownVehicleId }));
  await expectRefused(provider.mutation(archiveVehicleClass, { vehicleClassId }));

  // The grant nevertheless resolves, so every refusal above is the catalogue
  // gate working rather than a missing or broken grant.
  await t.run(async (ctx) => {
    const grant = await ctx.db
      .query('providerAccessGrants')
      .withIndex('by_providerOrganization_project', (q) => q.eq('providerOrganizationId', providerOrganizationId).eq('projectId', projectId))
      .unique();
    expect(grant).toMatchObject({ status: 'active', providerId, organizationId });
  });

  // The coordinator's own member still reads everything.
  await expect(coordinator.client.query(listFleetVehicles, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({
    page: expect.arrayContaining([expect.objectContaining({ _id: ownVehicleId })]),
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test('every Vehicle Class and Fleet Vehicle lifecycle write is audited with the acting member and entity', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t, 'vehicles-audit');
  const admin = await provision(t, 'vehicles-audit-admin');
  await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });

  const vehicleClassId = await admin.client.mutation(createVehicleClass, { organizationId, key: 'hOne', name: '  H1  ', passengerCapacity: 4 });
  await admin.client.mutation(updateVehicleClass, { vehicleClassId, name: 'H1 ejecutiva', passengerCapacity: 3 });
  const fleetVehicleId = await admin.client.mutation(createFleetVehicle, { organizationId, providerId, vehicleClassId, plate: 'ABC 123', label: 'Van 4' });
  await admin.client.mutation(updateFleetVehicle, { fleetVehicleId, plate: 'ABC 124', label: 'Van 5', year: 2020, notes: 'Turno noche' });
  await admin.client.mutation(archiveFleetVehicle, { fleetVehicleId });
  await admin.client.mutation(deleteFleetVehicle, { fleetVehicleId });
  await admin.client.mutation(archiveVehicleClass, { vehicleClassId });
  await admin.client.mutation(deleteVehicleClass, { vehicleClassId });

  const classAudits = await auditsFor(t, organizationId, 'vehicleClass', vehicleClassId);
  expect(classAudits.map((audit) => audit.action)).toEqual([
    'vehicleClass.created', 'vehicleClass.updated', 'vehicleClass.archived', 'vehicleClass.deleted',
  ]);
  expect(classAudits.every((audit) => audit.actorUserId === admin.userId && audit.entityType === 'vehicleClass' && audit.entityId === vehicleClassId)).toBe(true);
  // A coordinator member acts as itself, never on a Provider's behalf (#71).
  expect(classAudits.every((audit) => audit.onBehalfOfProviderId === undefined)).toBe(true);
  expect(classAudits[0]?.metadata).toMatchObject({ key: 'hOne', name: 'H1' });
  expect(classAudits[1]?.metadata).toMatchObject({ changedFields: 'name,passengerCapacity' });
  expect(classAudits[2]?.metadata).toMatchObject({ previousStatus: 'active' });
  expect(classAudits[3]?.metadata).toMatchObject({ key: 'hOne', name: 'H1 ejecutiva' });

  const vehicleAudits = await auditsFor(t, organizationId, 'fleetVehicle', fleetVehicleId);
  expect(vehicleAudits.map((audit) => audit.action)).toEqual([
    'fleetVehicle.created', 'fleetVehicle.updated', 'fleetVehicle.archived', 'fleetVehicle.deleted',
  ]);
  expect(vehicleAudits.every((audit) => audit.actorUserId === admin.userId && audit.entityType === 'fleetVehicle' && audit.entityId === fleetVehicleId)).toBe(true);
  expect(vehicleAudits[0]?.metadata).toMatchObject({ plate: 'ABC 123', providerId });
  expect(vehicleAudits[1]?.metadata).toMatchObject({ changedFields: 'plate,label,year,notes' });
  expect(vehicleAudits[2]?.metadata).toMatchObject({ previousStatus: 'active' });
  // The deletion row names the plate it destroyed, recorded before the delete.
  expect(vehicleAudits[3]?.metadata).toMatchObject({ plate: 'ABC 124', providerId });

  // Every reported change was actually written, not merely reported, and a
  // no-op update writes neither a patch nor an audit row.
  const secondClassId = await admin.client.mutation(createVehicleClass, { organizationId, key: 'gamaMedia', name: 'Gama media' });
  const secondVehicleId = await admin.client.mutation(createFleetVehicle, {
    organizationId, providerId, vehicleClassId: secondClassId, plate: 'DEF 456',
  });
  await admin.client.mutation(updateFleetVehicle, { fleetVehicleId: secondVehicleId, label: 'Bus 1', year: 2018 });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(secondVehicleId)).toMatchObject({ label: 'Bus 1', year: 2018 });
  });
  await admin.client.mutation(updateFleetVehicle, { fleetVehicleId: secondVehicleId, label: 'Bus 1', year: 2018 });
  const secondAudits = await auditsFor(t, organizationId, 'fleetVehicle', secondVehicleId);
  expect(secondAudits.map((audit) => audit.action)).toEqual(['fleetVehicle.created', 'fleetVehicle.updated']);
});
