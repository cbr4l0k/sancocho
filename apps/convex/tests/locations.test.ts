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
const createRecipe = api.recipes.mutations.createRecipe;
const createDraft = api.recipes.mutations.createInitialDraftVersion;
const publishVersion = api.recipes.mutations.publishRecipeVersion;
const cloneVersion = api.recipes.mutations.clonePublishedVersionToDraft;
const addRecipeField = api.recipes.fields.mutations.addRecipeField;
const updateRecipeField = api.recipes.fields.mutations.updateRecipeField;
const listRecipeFields = api.recipes.fields.queries.listRecipeFields;

const inaccessible = 'Not found or inaccessible';
const unauthenticated = 'Unauthenticated';
const referenced = 'Referenced locations cannot be deleted; retain the archived location instead';
const archivedLocation = 'Archived locations cannot be updated';
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
 * Inserts the smallest event graph that makes `locationId` a live
 * `eventFieldValues.locationId` reference, and returns the value row's id so a
 * test can remove exactly that reference again. Written directly to the tables
 * because event creation is issue #10; the mirror column is set here the way
 * `locationIdFromValue` will set it there.
 */
async function referenceLocationFromEventValue(
  t: SchemaTest,
  organizationId: Id<'organizations'>,
  locationId: Id<'locations'>,
): Promise<Id<'eventFieldValues'>> {
  return t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', { organizationId, name: 'Reference project', status: 'draft' });
    const recipeId = await ctx.db.insert('eventRecipes', { organizationId, key: 'referenceRecipe', name: 'Reference recipe', status: 'draft' });
    const recipeVersionId = await ctx.db.insert('recipeVersions', { organizationId, recipeId, versionNumber: 1, status: 'draft' });
    const fieldDefinitionId = await ctx.db.insert('fieldDefinitions', { scope: 'organization', organizationId, key: 'site', label: 'Site', status: 'active', config: { kind: 'location' } });
    const recipeFieldId = await ctx.db.insert('recipeFields', { organizationId, recipeVersionId, fieldDefinitionId, position: 0, required: false, visible: true, config: { kind: 'location' } });
    const eventId = await ctx.db.insert('events', { organizationId, projectId, recipeId, recipeVersionId, name: 'Reference event', status: 'draft', startsAt: 0 });
    return ctx.db.insert('eventFieldValues', { organizationId, eventId, recipeFieldId, fieldDefinitionId, value: { kind: 'location', locationId }, locationId });
  });
}

/** A location-typed recipe field on a fresh draft version of its own recipe. */
async function makeLocationRecipeField(
  t: SchemaTest,
  owner: Awaited<ReturnType<typeof provision>>,
  organizationId: Id<'organizations'>,
  key: string,
  locationId: Id<'locations'>,
) {
  const fieldDefinitionId = await owner.client.mutation(createField, { organizationId, key: `${key}Site`, label: `${key} site`, config: { kind: 'location' } });
  const recipeId = await owner.client.mutation(createRecipe, { organizationId, key, name: `${key} plan` });
  const recipeVersionId = await owner.client.mutation(createDraft, { recipeId });
  const recipeFieldId = await owner.client.mutation(addRecipeField, { recipeVersionId, fieldDefinitionId, required: false, visible: true, defaultValue: { kind: 'location', locationId } });
  return { fieldDefinitionId, recipeId, recipeVersionId, recipeFieldId };
}

function countDefaultReferences(t: SchemaTest, locationId: Id<'locations'>): Promise<number> {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query('recipeFields').withIndex('by_defaultLocation', (q) => q.eq('defaultLocationId', locationId)).collect();
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
  for (const latitude of [-91, 91, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(owner.client.mutation(createLocation, { organizationId, name: 'Bad', type: 'custom', latitude, longitude: 0 })).rejects.toBeDefined();
    await expect(owner.client.mutation(updateLocation, { locationId, latitude, longitude: 0 })).rejects.toBeDefined();
  }
  for (const longitude of [-181, 181, Number.NaN, Number.NEGATIVE_INFINITY]) {
    await expect(owner.client.mutation(createLocation, { organizationId, name: 'Bad', type: 'custom', latitude: 0, longitude })).rejects.toBeDefined();
    await expect(owner.client.mutation(updateLocation, { locationId, latitude: 0, longitude })).rejects.toBeDefined();
  }
  await expect(owner.client.mutation(createLocation, { organizationId, name: 'Lone', type: 'custom', latitude: 1 })).rejects.toMatchObject({ data: 'Latitude and longitude must be provided together' });
  await expect(owner.client.mutation(updateLocation, { locationId, latitude: 1 })).rejects.toMatchObject({ data: 'Latitude and longitude must be provided together' });
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
  await expect(owner.client.mutation(updateLocation, { locationId, latitude: 91 })).rejects.toMatchObject({ data: 'Latitude must be between -90 and 90' });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(locationId)).toMatchObject({ latitude: 30, longitude: 20 });
  });
});

test('location names are trimmed, non-empty, and bounded at creation and update', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  for (const name of ['', '   ', 'x'.repeat(201)]) {
    await expect(owner.client.mutation(createLocation, { organizationId, name, type: 'custom' })).rejects.toMatchObject({ data: 'Invalid location name' });
    await expect(owner.client.mutation(updateLocation, { locationId, name })).rejects.toMatchObject({ data: 'Invalid location name' });
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
  await expect(owner.client.mutation(createLocation, { organizationId, name: 'Long address', type: 'custom', address: 'a'.repeat(501) })).rejects.toMatchObject({ data: 'Location address must not exceed 500 characters' });
  await expect(owner.client.mutation(updateLocation, { locationId, address: 'a'.repeat(501) })).rejects.toMatchObject({ data: 'Location address must not exceed 500 characters' });
  await expect(owner.client.mutation(createLocation, { organizationId, name: 'Bounded address', type: 'custom', address: 'a'.repeat(500) })).resolves.toBeDefined();
});

test('location types outside the code-owned taxonomy are rejected by the validator', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  // The argument validator, not TypeScript, is what a real client faces; the
  // cast is the only way to send a type outside the closed union (I8).
  const unknownType = 'spaceport' as unknown as LocationType;
  await expect(owner.client.mutation(createLocation, { organizationId, name: 'Unknown', type: unknownType })).rejects.toBeDefined();
  await expect(owner.client.mutation(updateLocation, { locationId, type: unknownType })).rejects.toBeDefined();
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
    await expect(member.client.query(getLocation, { locationId: id })).rejects.toMatchObject({ data: inaccessible });
    await expect(member.client.mutation(updateLocation, { locationId: id, name: 'No' })).rejects.toMatchObject({ data: inaccessible });
    await expect(member.client.mutation(archiveLocation, { locationId: id })).rejects.toMatchObject({ data: inaccessible });
    await expect(member.client.mutation(deleteLocation, { locationId: id })).rejects.toMatchObject({ data: inaccessible });
  }
  for (const action of [
    () => t.query(getLocation, { locationId }),
    () => t.mutation(updateLocation, { locationId, name: 'No' }),
    () => t.mutation(archiveLocation, { locationId }),
    () => t.mutation(deleteLocation, { locationId }),
  ]) await expect(action()).rejects.toMatchObject({ data: unauthenticated });
  await expect(operator.client.mutation(createLocation, { organizationId, name: 'No', type: 'custom' })).rejects.toMatchObject({ data: inaccessible });
  await expect(operator.client.mutation(updateLocation, { locationId, name: 'No' })).rejects.toMatchObject({ data: inaccessible });
  await expect(operator.client.mutation(archiveLocation, { locationId })).rejects.toMatchObject({ data: inaccessible });
  await expect(operator.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: inaccessible });
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
    await expect(outsider.client.mutation(createLocation, { organizationId: orgId, name: 'Intruder', type: 'custom' })).rejects.toMatchObject({ data: inaccessible });
    await expect(outsider.client.query(listLocations, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });
  }
  await expect(t.mutation(createLocation, { organizationId, name: 'Intruder', type: 'custom' })).rejects.toMatchObject({ data: unauthenticated });
  await expect(t.query(listLocations, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: unauthenticated });
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
  await expect(owner.client.mutation(updateLocation, { locationId, name: 'No' })).rejects.toMatchObject({ data: archivedLocation });
  // The archived guard precedes coordinate validation, so even a patch that
  // touches nothing but coordinates is refused with the archived message.
  await expect(owner.client.mutation(updateLocation, { locationId, latitude: 1, longitude: 2 })).rejects.toMatchObject({ data: archivedLocation });

  // Archived locations stay readable so historical references stay resolvable.
  await expect(owner.client.query(getLocation, { locationId })).resolves.toMatchObject({ _id: locationId, status: 'archived' });
  await expect(owner.client.query(listLocations, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({ page: [{ _id: locationId, status: 'archived' }] });

  const audits = await locationAudits(t, organizationId, locationId);
  expect(audits.filter((audit) => audit.action === 'location.archived')).toHaveLength(1);
  expect(audits.find((audit) => audit.action === 'location.created')?.metadata).toMatchObject({ name: 'Depot', type: 'depot' });
  expect(audits.find((audit) => audit.action === 'location.archived')?.metadata).toMatchObject({ previousStatus: 'active' });
});

test('deletion requires archival and no indexed event reference, and audits lifecycle writes', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, locationId } = await makeLocation(t);
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: 'Locations must be archived before deletion' });
  const valueId = await referenceLocationFromEventValue(t, organizationId, locationId);
  await owner.client.mutation(archiveLocation, { locationId });
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: referenced });

  // The guard is live rather than sticky: removing the reference releases it.
  await t.run(async (ctx) => ctx.db.delete(valueId));
  await expect(owner.client.mutation(deleteLocation, { locationId })).resolves.toBeNull();
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: inaccessible });

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
  const { recipeId, recipeVersionId } = await makeLocationRecipeField(t, owner, organizationId, 'published', locationId);
  await owner.client.mutation(publishVersion, { recipeVersionId });
  expect(await countDefaultReferences(t, locationId)).toBe(1);

  // Nothing but the published version's immutable default references it, and
  // that is exactly why deleting it would permanently break that version (I2/I3).
  await owner.client.mutation(archiveLocation, { locationId });
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: referenced });

  // A clone re-derives the mirror, so the cloned draft is guarded too.
  const clonedVersionId = await owner.client.mutation(cloneVersion, { recipeId });
  expect(await countDefaultReferences(t, locationId)).toBe(2);
  const clonedFields = await owner.client.query(listRecipeFields, { recipeVersionId: clonedVersionId });
  expect(clonedFields.map((field) => field.defaultLocationId)).toEqual([locationId]);

  // Clearing the clone's default leaves the published version's reference, which
  // still holds the location.
  await owner.client.mutation(updateRecipeField, { recipeFieldId: clonedFields[0]!._id, defaultValue: null });
  expect(await countDefaultReferences(t, locationId)).toBe(1);
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: referenced });
});

test('clearing a draft recipe field default releases the location for deletion', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await makeLocation(t);
  const locationId = await owner.client.mutation(createLocation, { organizationId, name: 'Draft default', type: 'hotel' });
  const { recipeFieldId } = await makeLocationRecipeField(t, owner, organizationId, 'draft', locationId);
  expect(await countDefaultReferences(t, locationId)).toBe(1);

  await owner.client.mutation(archiveLocation, { locationId });
  await expect(owner.client.mutation(deleteLocation, { locationId })).rejects.toMatchObject({ data: referenced });

  await owner.client.mutation(updateRecipeField, { recipeFieldId, defaultValue: null });
  expect(await countDefaultReferences(t, locationId)).toBe(0);
  await expect(owner.client.mutation(deleteLocation, { locationId })).resolves.toBeNull();
});
