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
const archiveRecipe = api.recipes.mutations.archiveRecipe;
const createRecipe = api.recipes.mutations.createRecipe;
const createInitialDraftVersion = api.recipes.mutations.createInitialDraftVersion;
const getRecipeVersion = api.recipes.queries.getRecipeVersion;
const getRecipe = api.recipes.queries.getRecipe;
const listPublishedRecipes = api.recipes.queries.listPublishedRecipes;
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

test('a new organization atomically receives the shared catalogue and four published starter recipes', async () => {
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

  const recipes = await owner.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage });
  expect(recipes.page.map((entry) => [entry.recipe.key, entry.recipe.name]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))).toEqual([
    ['airportArrivalTransfer', 'Airport Arrival Transfer'],
    ['airportDepartureTransfer', 'Airport Departure Transfer'],
    ['pointToPointTransfer', 'Point to Point Transfer'],
    ['shuttleService', 'Shuttle Service'],
  ]);
  expect(recipes.page.every((entry) => entry.publishedVersion.versionNumber === 1 && entry.publishedVersion.publishedAt !== undefined)).toBe(true);

  for (const entry of recipes.page) {
    const version = await owner.query(getRecipeVersion, { recipeVersionId: entry.publishedVersion._id });
    const definitionIds = version.recipeFields.map((field) => field.fieldDefinitionId);
    const definitions = await owner.query(getFieldDefinitionsByIds, { organizationId, fieldDefinitionIds: definitionIds });
    const keys = new Map(definitions.map((definition) => [definition._id, definition.key]));
    expect(version.recipeFields
      .sort((left, right) => left.position - right.position)
      .map((field) => [keys.get(field.fieldDefinitionId), field.required]))
      .toEqual(expectedCompositions.get(entry.recipe.key));
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

  const firstRecipes = await owner.query(listPublishedRecipes, { organizationId: firstOrganizationId, paginationOpts: firstPage });
  expect((await owner.query(listPublishedRecipes, { organizationId: secondOrganizationId, paginationOpts: firstPage })).page).toHaveLength(4);
  const recipeId = firstRecipes.page[0]?.recipe._id;
  if (recipeId === undefined) throw new Error('Expected a provisioned starter recipe');
  await expect(outsider.query(listPublishedRecipes, { organizationId: firstOrganizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.query(getRecipe, { recipeId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.query(listFieldDefinitions, { organizationId: firstOrganizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('listPublishedRecipes omits archived and draft-only recipes and is membership-gated', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'picker-owner');
  const outsider = await provision(t, 'picker-outsider');
  const organizationId = await owner.mutation(createOrganization, { name: 'Picker', slug: 'picker-provisioning' });
  const before = await owner.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage });
  const archived = before.page.find((entry) => entry.recipe.key === 'shuttleService');
  if (archived === undefined) throw new Error('Expected the provisioned shuttle recipe');
  await owner.mutation(archiveRecipe, { recipeId: archived.recipe._id });
  const draftRecipeId = await owner.mutation(createRecipe, { organizationId, key: 'draftOnlyTransfer', name: 'Draft only transfer' });
  await owner.mutation(createInitialDraftVersion, { recipeId: draftRecipeId });

  const after = await owner.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage });
  expect(after.page.map((entry) => entry.recipe.key).sort()).toEqual([
    'airportArrivalTransfer', 'airportDepartureTransfer', 'pointToPointTransfer',
  ]);
  await expect(outsider.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('the backfill provisions organizations that predate starter provisioning, idempotently', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'backfill-owner');
  const organizationId = await owner.mutation(createOrganization, { name: 'Legacy', slug: 'legacy-provisioning' });

  // Emulate a tenant created before `createOrganization` provisioned anything by
  // stripping its recipes back out at the table level. Raw writes manufacture
  // the pre-change state only; every assertion below still reads through the
  // ordinary public query.
  await t.run(async (ctx) => {
    for (const version of await ctx.db.query('recipeVersions').collect()) await ctx.db.delete(version._id);
    for (const field of await ctx.db.query('recipeFields').collect()) await ctx.db.delete(field._id);
    for (const recipe of await ctx.db.query('eventRecipes').collect()) await ctx.db.delete(recipe._id);
  });
  expect(await owner.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage })).toMatchObject({ page: [] });

  process.env[seedOptInVariable] = 'true';
  try {
    await t.mutation(provisionExistingOrganizations, {});
    const restored = await owner.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage });
    expect(restored.page.map((entry) => entry.recipe.key).sort()).toEqual([
      'airportArrivalTransfer', 'airportDepartureTransfer', 'pointToPointTransfer', 'shuttleService',
    ]);

    // Idempotent: a second sweep must not duplicate a recipe or a version.
    await t.mutation(provisionExistingOrganizations, {});
    const again = await owner.query(listPublishedRecipes, { organizationId, paginationOpts: firstPage });
    expect(again.page.length).toBe(4);
  } finally {
    delete process.env[seedOptInVariable];
  }

  // The deployment opt-in is the guard; `internalMutation` alone is not.
  await expect(t.mutation(provisionExistingOrganizations, {})).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
});
