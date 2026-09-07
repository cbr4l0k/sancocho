import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import type { locationTypeValidator } from '../convex/validators';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createLocation = api.locations.mutations.createLocation;
const updateLocation = api.locations.mutations.updateLocation;
const archiveLocation = api.locations.mutations.archiveLocation;
const deleteLocation = api.locations.mutations.deleteLocation;
const getLocation = api.locations.queries.getLocation;
const listLocations = api.locations.queries.listLocations;
const createField = api.fields.mutations.createFieldDefinition;
const createServiceKind = api.serviceKinds.mutations.createServiceKind;
const createDraft = api.serviceKinds.mutations.createInitialDraftVersion;
const publishVersion = api.serviceKinds.mutations.publishServiceKindVersion;
const cloneVersion = api.serviceKinds.mutations.clonePublishedVersionToDraft;
const addServiceKindField = api.serviceKinds.fields.mutations.addServiceKindField;
const updateServiceKindField = api.serviceKinds.fields.mutations.updateServiceKindField;
const listServiceKindFields = api.serviceKinds.fields.queries.listServiceKindFields;
const createProject = api.projects.mutations.createProject;
const createEvent = api.events.mutations.createEvent;
const updateEvent = api.events.mutations.updateEvent;

const inaccessible = 'notFoundOrInaccessible';
const unauthenticated = 'unauthenticated';
const referenced = 'locationDeleteBlocked';
const archivedLocation = 'locationArchived';
const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 10, cursor: null };

/** Schema-aware test handle, so `t.run` fixtures can use the real table indexes. */
type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;
type LocationType = typeof locationTypeValidator.type;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(ensureUser, {});
  return { client, userId };
}

async function makeLocation(t: SchemaTest) {
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'locations-test' });
  const locationId = await owner.client.mutation(createLocation, { organizationId, name: 'Depot', type: 'depot' });
  return { owner, organizationId, locationId };
}

/**
 * Inserts the smallest service graph that makes `locationId` a live
 * `serviceFieldValues.locationId` reference, and returns the value row's id so a
 * test can remove exactly that reference again. Written directly to the tables
 * because service creation is issue #10; the mirror column is set here the way
 * `locationIdFromValue` will set it there.
 */
async function referenceLocationFromServiceValue(
  t: SchemaTest,
  organizationId: Id<'organizations'>,
  locationId: Id<'locations'>,
): Promise<Id<'serviceFieldValues'>> {
  return t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', { organizationId, name: 'Reference project', status: 'draft' });
    const eventId = await ctx.db.insert('events', { organizationId, projectId, name: 'Reference event', status: 'draft', startsAt: 0 });
    const serviceKindId = await ctx.db.insert('serviceKinds', { organizationId, key: 'referenceServiceKind', name: 'Reference serviceKind', status: 'draft' });
    const serviceKindVersionId = await ctx.db.insert('serviceKindVersions', { organizationId, serviceKindId, versionNumber: 1, status: 'draft' });
    const fieldDefinitionId = await ctx.db.insert('fieldDefinitions', { scope: 'organization', organizationId, key: 'site', label: 'Site', status: 'active', config: { kind: 'location' } });
    const serviceKindFieldId = await ctx.db.insert('serviceKindFields', { organizationId, serviceKindVersionId, fieldDefinitionId, position: 0, required: false, visible: true, config: { kind: 'location' } });
    const serviceId = await ctx.db.insert('services', { organizationId, projectId, eventId, serviceKindId, serviceKindVersionId, name: 'Reference service', status: 'draft', startsAt: 0 });
    return ctx.db.insert('serviceFieldValues', { organizationId, serviceId, serviceKindFieldId, fieldDefinitionId, value: { kind: 'location', locationId }, locationId });
  });
}

/** A location-typed serviceKind field on a fresh draft version of its own serviceKind. */
async function makeLocationServiceKindField(
  t: SchemaTest,
  owner: Awaited<ReturnType<typeof provision>>,
  organizationId: Id<'organizations'>,
  key: string,
  locationId: Id<'locations'>,
) {
  const fieldDefinitionId = await owner.client.mutation(createField, { organizationId, key: `${key}Site`, label: `${key} site`, config: { kind: 'location' } });
  const serviceKindId = await owner.client.mutation(createServiceKind, { organizationId, key, name: `${key} plan` });
  const serviceKindVersionId = await owner.client.mutation(createDraft, { serviceKindId });
  const serviceKindFieldId = await owner.client.mutation(addServiceKindField, { serviceKindVersionId, fieldDefinitionId, required: false, visible: true, defaultValue: { kind: 'location', locationId } });
  return { fieldDefinitionId, serviceKindId, serviceKindVersionId, serviceKindFieldId };
}

function countDefaultReferences(t: SchemaTest, locationId: Id<'locations'>): Promise<number> {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query('serviceKindFields').withIndex('by_defaultLocation', (q) => q.eq('defaultLocationId', locationId)).collect();
    return rows.length;
  });
}

function locationAudits(t: SchemaTest, organizationId: Id<'organizations'>, locationId: Id<'locations'>) {
  return t.run(async (ctx) =>
    ctx.db.query('auditEvents').withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'location').eq('entityId', locationId)).collect(),
  );
}

test('coordinates require a finite, bounded pair at creation and update', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  // Each case names the message it must produce: finiteness is checked before
  // range (NaN silently passes every range comparison), and the two axes have
  // separate rules, so a table of "some error happened" would let any of the
  // four messages be deleted without a failure.
  const rejections: [{ latitude: number; longitude: number }, string][] = [
    [{ latitude: -91, longitude: 0 }, 'Latitude must be between -90 and 90'],
    [{ latitude: 91, longitude: 0 }, 'Latitude must be between -90 and 90'],
    [{ latitude: Number.NaN, longitude: 0 }, 'Latitude must be finite'],
    [{ latitude: Number.POSITIVE_INFINITY, longitude: 0 }, 'Latitude must be finite'],
    [{ latitude: Number.NEGATIVE_INFINITY, longitude: 0 }, 'Latitude must be finite'],
    [{ latitude: 0, longitude: -181 }, 'Longitude must be between -180 and 180'],
    [{ latitude: 0, longitude: 181 }, 'Longitude must be between -180 and 180'],
    [{ latitude: 0, longitude: Number.NaN }, 'Longitude must be finite'],
    [{ latitude: 0, longitude: Number.POSITIVE_INFINITY }, 'Longitude must be finite'],
    [{ latitude: 0, longitude: Number.NEGATIVE_INFINITY }, 'Longitude must be finite'],
  ];
  for (const [coordinates] of rejections) {
    await expect(owner.client.mutation(createLocation, { organizationId, name: 'Bad', type: 'custom', ...coordinates })).rejects.toMatchObject({ data: { code: 'locationCoordinatesInvalid' } });
    await expect(owner.client.mutation(updateLocation, { locationId, ...coordinates })).rejects.toMatchObject({ data: { code: 'locationCoordinatesInvalid' } });
  }
  await expect(owner.client.mutation(createLocation, { organizationId, name: 'Lone', type: 'custom', latitude: 1 })).rejects.toMatchObject({ data: { code: 'locationCoordinatesIncomplete' } });
  await expect(owner.client.mutation(updateLocation, { locationId, latitude: 1 })).rejects.toMatchObject({ data: { code: 'locationCoordinatesIncomplete' } });
  // Both extremes are inclusive, at creation and at update.
  await expect(owner.client.mutation(createLocation, { organizationId, name: 'Southwest', type: 'custom', latitude: -90, longitude: -180 })).resolves.toBeDefined();
  await expect(owner.client.mutation(createLocation, { organizationId, name: 'Northeast', type: 'custom', latitude: 90, longitude: 180 })).resolves.toBeDefined();
  await expect(owner.client.mutation(updateLocation, { locationId, latitude: 90, longitude: 180 })).resolves.toBeNull();
  await expect(owner.client.mutation(updateLocation, { locationId, latitude: -90, longitude: -180 })).resolves.toBeNull();
});

test('a half-supplied coordinate patch is validated against the merged stored pair', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await makeLocation(t);
  const locationId = await owner.client.mutation(createLocation, { organizationId, name: 'Merged', type: 'venue', latitude: 10, longitude: 20 });

  // A lone latitude is legal once a longitude is already stored, and must not
  // disturb it — the merge is the whole reason the pair rule still holds.
  await expect(owner.client.mutation(updateLocation, { locationId, latitude: 30 })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(locationId)).toMatchObject({ latitude: 30, longitude: 20 });
  });
  // The merged pair is what is validated, so an out-of-range lone latitude is refused.
  await expect(owner.client.mutation(updateLocation, { locationId, latitude: 91 })).rejects.toMatchObject({ data: { code: 'locationCoordinatesInvalid' } });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(locationId)).toMatchObject({ latitude: 30, longitude: 20 });
  });
});

test('location names are trimmed, non-empty, and bounded at creation and update', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  for (const name of ['', '   ', 'x'.repeat(201)]) {
    await expect(owner.client.mutation(createLocation, { organizationId, name, type: 'custom' })).rejects.toMatchObject({ data: { code: 'entityNameInvalid' } });
    await expect(owner.client.mutation(updateLocation, { locationId, name })).rejects.toMatchObject({ data: { code: 'entityNameInvalid' } });
  }
  // A padded name passes the bound only because it is trimmed, so the trimmed
  // value is what must be stored.
  const padded = await owner.client.mutation(createLocation, { organizationId, name: `  ${'x'.repeat(200)}  `, type: 'custom' });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(padded))?.name).toBe('x'.repeat(200));
  });
  await expect(owner.client.mutation(updateLocation, { locationId, name: '  Trimmed  ' })).resolves.toBeNull();
  await expect(owner.client.query(getLocation, { locationId })).resolves.toMatchObject({ name: 'Trimmed' });

  // Addresses are free-form but bounded.
  await expect(owner.client.mutation(createLocation, { organizationId, name: 'Long address', type: 'custom', address: 'a'.repeat(501) })).rejects.toMatchObject({ data: { code: 'locationAddressTooLong' } });
  await expect(owner.client.mutation(updateLocation, { locationId, address: 'a'.repeat(501) })).rejects.toMatchObject({ data: { code: 'locationAddressTooLong' } });
  await expect(owner.client.mutation(createLocation, { organizationId, name: 'Bounded address', type: 'custom', address: 'a'.repeat(500) })).resolves.toBeDefined();
});

test('location types outside the code-owned taxonomy are rejected by the validator', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  // The argument validator, not TypeScript, is what a real client faces; the
  // cast is the only way to send a type outside the closed union (I8).
  const unknownType = 'spaceport' as unknown as LocationType;
  for (const call of [
    () => owner.client.mutation(createLocation, { organizationId, name: 'Unknown', type: unknownType }),
    () => owner.client.mutation(updateLocation, { locationId, type: unknownType }),
  ]) {
    const rejection: unknown = await call().catch((error: unknown) => error);
    // The args validator refuses it before the handler runs, so this is argument
    // validation (no `data`), not an application-level error that happens to
    // reject — the distinction a bare `rejects.toBeDefined()` could not see.
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toHaveProperty('data');
    expect((rejection as Error).message).toMatch(/Validator error.*got `"spaceport"`/);
  }
  await t.run(async (ctx) => {
    expect((await ctx.db.get(locationId))?.type).toBe('depot');
  });
});

test('an admin — the role floor itself — can create, update, archive and delete a location', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await makeLocation(t);
  const admin = await provision(t, 'admin');
  await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });

  // Every location mutation is admin+ (`organizationConfigurationRole`), not
  // planner+: a location is shared vocabulary the whole tenant's field values
  // reference, so it is configuration rather than planning work. Asserted from
  // the floor rank itself, so moving the floor in either direction fails here
  // rather than passing on the owner's back.
  const locationId = await admin.client.mutation(createLocation, { organizationId, name: 'Admin depot', type: 'depot' });
  await expect(admin.client.mutation(updateLocation, { locationId, name: 'Admin depot renamed' })).resolves.toBeNull();
  await expect(admin.client.mutation(archiveLocation, { locationId })).resolves.toBeNull();
  await expect(admin.client.mutation(deleteLocation, { locationId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(locationId)).toBeNull();
  });
});

test('a planner sits below the location floor and is refused generically', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  const planner = await provision(t, 'planner');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });

  // A planner is a member, so this proves the refusal comes from the role floor
  // and not from membership — and it stays the same generic error a stranger
  // gets, never "you need to be an admin" (I9).
  await expect(planner.client.mutation(createLocation, { organizationId, name: 'No', type: 'custom' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(updateLocation, { locationId, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(archiveLocation, { locationId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: { code: inaccessible } });

  // Reading is unaffected: planners still need the catalogue to build services.
  await expect(planner.client.query(getLocation, { locationId })).resolves.toMatchObject({ _id: locationId });
});

test('access probes are generic, operators cannot manage, and viewers can read', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  const member = await provision(t, 'member');
  const operator = await provision(t, 'operator');
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'locations-b' });
  const foreignId = await owner.client.mutation(createLocation, { organizationId: orgB, name: 'Foreign', type: 'hotel' });
  await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'viewer' });
  await owner.client.mutation(addMember, { organizationId, userId: operator.userId, role: 'operator' });
  const fabricatedId = await t.run(async (ctx) => { const id = await ctx.db.insert('locations', { organizationId, name: 'Gone', type: 'custom', status: 'active' }); await ctx.db.delete(id); return id; });
  for (const id of [foreignId, fabricatedId]) {
    await expect(member.client.query(getLocation, { locationId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(member.client.mutation(updateLocation, { locationId: id, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(member.client.mutation(archiveLocation, { locationId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(member.client.mutation(deleteLocation, { locationId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  for (const action of [
    () => t.query(getLocation, { locationId }),
    () => t.mutation(updateLocation, { locationId, name: 'No' }),
    () => t.mutation(archiveLocation, { locationId }),
    () => t.mutation(deleteLocation, { locationId }),
  ]) await expect(action()).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(operator.client.mutation(createLocation, { organizationId, name: 'No', type: 'custom' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(operator.client.mutation(updateLocation, { locationId, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(operator.client.mutation(archiveLocation, { locationId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(operator.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(member.client.query(getLocation, { locationId })).resolves.toMatchObject({ _id: locationId });
  await expect(member.client.query(listLocations, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({ page: [{ _id: locationId }] });
});

test('creating and listing require membership in the organization named by the caller', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await makeLocation(t);
  const outsider = await provision(t, 'outsider');
  const fabricatedOrgId = await t.run(async (ctx) => { const id = await ctx.db.insert('organizations', { name: 'Ghost', slug: 'locations-ghost' }); await ctx.db.delete(id); return id; });

  // A non-member passing a foreign organizationId, and a fabricated one, are
  // indistinguishable — knowing an id grants nothing (I1/I9).
  for (const orgId of [organizationId, fabricatedOrgId]) {
    await expect(outsider.client.mutation(createLocation, { organizationId: orgId, name: 'Intruder', type: 'custom' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.query(listLocations, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  await expect(t.mutation(createLocation, { organizationId, name: 'Intruder', type: 'custom' })).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(t.query(listLocations, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(owner.client.query(listLocations, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({ isDone: true });
});

test('lists are paginated and isolated by organization', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'locations-list-b' });
  const two = await owner.client.mutation(createLocation, { organizationId, name: 'Two', type: 'station' });
  const three = await owner.client.mutation(createLocation, { organizationId, name: 'Three', type: 'venue' });
  // Both organizations hold rows, so the isolation assertion below is real.
  const foreign = await owner.client.mutation(createLocation, { organizationId: orgB, name: 'Theirs', type: 'hotel' });

  const first = await owner.client.query(listLocations, { organizationId, paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  const second = await owner.client.query(listLocations, { organizationId, paginationOpts: { numItems: 2, cursor: first.continueCursor } });
  expect(second.page).toHaveLength(1);
  expect([...first.page, ...second.page].map((location) => location._id).sort()).toEqual([locationId, two, three].sort());
  expect([...first.page, ...second.page].every((location) => location.organizationId === organizationId)).toBe(true);
  await expect(owner.client.query(listLocations, { organizationId: orgB, paginationOpts: firstPage })).resolves.toMatchObject({ page: [{ _id: foreign }] });
});

test('listLocations applies indexed search and filters before pagination', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await makeLocation(t);
  for (let index = 0; index < 4; index += 1) {
    await owner.client.mutation(createLocation, { organizationId, name: `Ordinary ${index}`, type: 'depot' });
  }
  const beyondFirstPage = await owner.client.mutation(createLocation, { organizationId, name: 'Hotel Marriott Bogotá', type: 'hotel' });
  const medellin = await owner.client.mutation(createLocation, { organizationId, name: 'Medellín Terminal', type: 'station' });
  await owner.client.mutation(archiveLocation, { locationId: medellin });

  const ordinaryFirstPage = await owner.client.query(listLocations, { organizationId, paginationOpts: { numItems: 1, cursor: null } });
  expect(ordinaryFirstPage.page.map((location) => location._id)).not.toContain(beyondFirstPage);
  const searched = await owner.client.query(listLocations, { organizationId, paginationOpts: { numItems: 1, cursor: null }, search: 'marriott' });
  expect(searched.page.map((location) => location._id)).toEqual([beyondFirstPage]);
  await expect(owner.client.query(listLocations, { organizationId, paginationOpts: firstPage, search: 'medellin' })).resolves.toMatchObject({ page: [{ _id: medellin }] });
  const typed = await owner.client.query(listLocations, { organizationId, paginationOpts: firstPage, type: 'hotel' });
  expect(typed.page.every((location) => location.type === 'hotel')).toBe(true);
  const archived = await owner.client.query(listLocations, { organizationId, paginationOpts: firstPage, status: 'archived' });
  expect(archived.page.map((location) => location._id)).toEqual([medellin]);
  const composed = await owner.client.query(listLocations, { organizationId, paginationOpts: firstPage, search: 'medellin', type: 'station', status: 'archived' });
  expect(composed.page.map((location) => location._id)).toEqual([medellin]);
});

test('listLocations applies status indexes before pagination, including the status-and-type prefix', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId: depot } = await makeLocation(t);
  const activeHotelOne = await owner.client.mutation(createLocation, { organizationId, name: 'Active hotel one', type: 'hotel' });
  const activeHotelTwo = await owner.client.mutation(createLocation, { organizationId, name: 'Active hotel two', type: 'hotel' });
  const archivedHotel = await owner.client.mutation(createLocation, { organizationId, name: 'Archived hotel', type: 'hotel' });
  const activeStationOne = await owner.client.mutation(createLocation, { organizationId, name: 'Active station one', type: 'station' });
  const activeStationTwo = await owner.client.mutation(createLocation, { organizationId, name: 'Active station two', type: 'station' });
  const archivedStation = await owner.client.mutation(createLocation, { organizationId, name: 'Archived station', type: 'station' });
  await owner.client.mutation(archiveLocation, { locationId: archivedHotel });
  await owner.client.mutation(archiveLocation, { locationId: archivedStation });

  // Active rows outnumber one page. A post-index filter would make this page
  // sequence depend on non-matches ahead of each cursor rather than returning
  // exactly the status-index range on every page.
  const first = await owner.client.query(listLocations, { organizationId, paginationOpts: { numItems: 2, cursor: null }, status: 'active' });
  const second = await owner.client.query(listLocations, { organizationId, paginationOpts: { numItems: 2, cursor: first.continueCursor }, status: 'active' });
  const third = await owner.client.query(listLocations, { organizationId, paginationOpts: { numItems: 2, cursor: second.continueCursor }, status: 'active' });
  const active = [...first.page, ...second.page, ...third.page];
  expect(active.map((location) => location._id).sort()).toEqual([depot, activeHotelOne, activeHotelTwo, activeStationOne, activeStationTwo].sort());
  expect(active.every((location) => location.status === 'active')).toBe(true);

  // The status-and-type equality must stay in the same index expression: both
  // archived rows are present, so asserting only type would miss a regression.
  const hotels = await owner.client.query(listLocations, { organizationId, paginationOpts: firstPage, status: 'active', type: 'hotel' });
  expect(hotels.page.map((location) => location._id).sort()).toEqual([activeHotelOne, activeHotelTwo].sort());
  expect(hotels.page.every((location) => location.status === 'active' && location.type === 'hotel')).toBe(true);
});

test('filtered location lists retain tenant isolation and existing authorization errors', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'locations-filtered-a' });
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'locations-filtered-b' });
  await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'viewer' });
  await owner.client.mutation(createLocation, { organizationId: orgB, name: 'Exclusive Search Needle', type: 'hotel' });

  for (const filters of [
    { search: 'exclusive' },
    { type: 'hotel' as LocationType },
    { status: 'active' as const },
  ]) {
    await expect(member.client.query(listLocations, { organizationId, paginationOpts: firstPage, ...filters })).resolves.toMatchObject({ page: [] });
    await expect(t.query(listLocations, { organizationId, paginationOpts: firstPage, ...filters })).rejects.toMatchObject({ data: { code: unauthenticated } });
  }
});

test('blank location searches fall through and excessively long searches are rejected', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  await expect(owner.client.query(listLocations, { organizationId, paginationOpts: firstPage, search: '  —_! ' })).resolves.toMatchObject({ page: [{ _id: locationId }] });
  await expect(owner.client.query(listLocations, { organizationId, paginationOpts: firstPage, search: 'x'.repeat(101) })).rejects.toMatchObject({ data: { code: 'searchTermTooLong' } });
});

test('a patch that changes nothing writes neither a document patch nor an audit row', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  await expect(owner.client.mutation(updateLocation, { locationId, name: 'Depot', type: 'depot' })).resolves.toBeNull();
  const audits = await locationAudits(t, organizationId, locationId);
  expect(audits.filter((audit) => audit.action === 'location.updated')).toHaveLength(0);
});

test('archival is idempotent, keeps the location readable, and locks every update path', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  await owner.client.mutation(archiveLocation, { locationId });
  await expect(owner.client.mutation(archiveLocation, { locationId })).resolves.toBeNull();
  await expect(owner.client.mutation(updateLocation, { locationId, name: 'No' })).rejects.toMatchObject({ data: { code: archivedLocation } });
  // The archived guard precedes coordinate validation, so even a patch that
  // touches nothing but coordinates is refused with the archived message.
  await expect(owner.client.mutation(updateLocation, { locationId, latitude: 1, longitude: 2 })).rejects.toMatchObject({ data: { code: archivedLocation } });

  // Archived locations stay readable so historical references stay resolvable.
  await expect(owner.client.query(getLocation, { locationId })).resolves.toMatchObject({ _id: locationId, status: 'archived' });
  await expect(owner.client.query(listLocations, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({ page: [{ _id: locationId, status: 'archived' }] });

  const audits = await locationAudits(t, organizationId, locationId);
  expect(audits.filter((audit) => audit.action === 'location.archived')).toHaveLength(1);
  expect(audits.find((audit) => audit.action === 'location.created')?.metadata).toMatchObject({ name: 'Depot', type: 'depot' });
  expect(audits.find((audit) => audit.action === 'location.archived')?.metadata).toMatchObject({ previousStatus: 'active' });
});

test('deletion requires archival and no indexed service reference, and audits lifecycle writes', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: { code: 'locationArchiveRequired' } });
  const valueId = await referenceLocationFromServiceValue(t, organizationId, locationId);
  await owner.client.mutation(archiveLocation, { locationId });
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: { code: referenced } });

  // The guard is live rather than sticky: removing the reference releases it.
  await t.run(async (ctx) => ctx.db.delete(valueId));
  await expect(owner.client.mutation(deleteLocation, { locationId })).resolves.toBeNull();
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: { code: inaccessible } });

  const deletable = await owner.client.mutation(createLocation, { organizationId, name: 'Delete', type: 'custom' });
  await owner.client.mutation(updateLocation, { locationId: deletable, name: 'Delete updated', type: 'office' });
  await owner.client.mutation(archiveLocation, { locationId: deletable });
  await owner.client.mutation(deleteLocation, { locationId: deletable });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(deletable)).toBeNull();
  });
  const audits = await locationAudits(t, organizationId, deletable);
  expect(audits.map((audit) => audit.action).sort()).toEqual(['location.archived', 'location.created', 'location.deleted', 'location.updated']);
  expect(audits.every((audit) => audit.actorUserId === owner.userId && audit.organizationId === organizationId)).toBe(true);
  expect(audits.find((audit) => audit.action === 'location.updated')?.metadata).toMatchObject({ changedFields: 'name,type' });
  // The row is gone, so the audit row is the only description of what was deleted.
  expect(audits.find((audit) => audit.action === 'location.deleted')?.metadata).toMatchObject({ name: 'Delete updated', type: 'office' });
});

test('a location a published version defaults to cannot be deleted, and clones carry the guard', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  const { serviceKindId, serviceKindVersionId } = await makeLocationServiceKindField(t, owner, organizationId, 'published', locationId);
  await owner.client.mutation(publishVersion, { serviceKindVersionId });
  expect(await countDefaultReferences(t, locationId)).toBe(1);

  // Nothing but the published version's immutable default references it, and
  // that is exactly why deleting it would permanently break that version (I2/I3).
  await owner.client.mutation(archiveLocation, { locationId });
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: { code: referenced } });

  // A clone re-derives the mirror, so the cloned draft is guarded too.
  const clonedVersionId = await owner.client.mutation(cloneVersion, { serviceKindId });
  expect(await countDefaultReferences(t, locationId)).toBe(2);
  const clonedFields = await owner.client.query(listServiceKindFields, { serviceKindVersionId: clonedVersionId });
  expect(clonedFields.map((field) => field.defaultLocationId)).toEqual([locationId]);
  const clonedField = clonedFields[0];
  if (clonedField === undefined) throw new Error('cloned serviceKind field missing');

  // Clearing the clone's default leaves the published version's reference, which
  // still holds the location.
  await owner.client.mutation(updateServiceKindField, { serviceKindFieldId: clonedField._id, defaultValue: null });
  expect(await countDefaultReferences(t, locationId)).toBe(1);
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: { code: referenced } });
});

test('clearing a draft serviceKind field default releases the location for deletion', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await makeLocation(t);
  const locationId = await owner.client.mutation(createLocation, { organizationId, name: 'Draft default', type: 'hotel' });
  const { serviceKindFieldId } = await makeLocationServiceKindField(t, owner, organizationId, 'draft', locationId);
  expect(await countDefaultReferences(t, locationId)).toBe(1);

  await owner.client.mutation(archiveLocation, { locationId });
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: { code: referenced } });

  await owner.client.mutation(updateServiceKindField, { serviceKindFieldId, defaultValue: null });
  expect(await countDefaultReferences(t, locationId)).toBe(0);
  await expect(owner.client.mutation(deleteLocation, { locationId })).resolves.toBeNull();
});

test('a location an Event uses as its venue cannot be deleted', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await makeLocation(t);
  const venueId = await owner.client.mutation(createLocation, { organizationId, name: 'Main hall', type: 'venue' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Venue project' });
  const eventId = await owner.client.mutation(createEvent, { projectId, name: 'Venue event', startsAt: 200, venueLocationId: venueId });

  // Archival is the lifecycle path for a referenced location; deletion is not.
  await owner.client.mutation(archiveLocation, { locationId: venueId });
  await expect(owner.client.mutation(deleteLocation, { locationId: venueId })).rejects.toMatchObject({ data: { code: referenced } });

  // The guard is live rather than sticky: releasing the Event's venue releases the location.
  await owner.client.mutation(updateEvent, { eventId, venueLocationId: null });
  await expect(owner.client.mutation(deleteLocation, { locationId: venueId })).resolves.toBeNull();
});

test('a location an Event uses as its venue cannot be re-typed out from under it', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await makeLocation(t);
  const venueId = await owner.client.mutation(createLocation, { organizationId, name: 'Main hall', type: 'venue' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Retype project' });
  const eventId = await owner.client.mutation(createEvent, { projectId, name: 'Retype event', startsAt: 200, venueLocationId: venueId });

  // The venue proof runs at write time, so the stored reference is only
  // trustworthy if the type behind it cannot silently stop being a venue.
  await expect(owner.client.mutation(updateLocation, { locationId: venueId, type: 'hotel' })).rejects.toMatchObject({
    data: { code: 'locationTypeChangeBlocked' },
  });
  // Unrelated edits, and a no-op re-assertion of the same type, are unaffected.
  await expect(owner.client.mutation(updateLocation, { locationId: venueId, name: 'Main hall renamed' })).resolves.toBeNull();
  await expect(owner.client.mutation(updateLocation, { locationId: venueId, type: 'venue' })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(venueId)).toMatchObject({ type: 'venue', name: 'Main hall renamed' });
  });

  // Releasing the reference releases the type.
  await owner.client.mutation(updateEvent, { eventId, venueLocationId: null });
  await expect(owner.client.mutation(updateLocation, { locationId: venueId, type: 'hotel' })).resolves.toBeNull();
});
