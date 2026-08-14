import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { enableSeedMutations, modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const getCurrentUser = api.auth.queries.getCurrentUser;
const createOrganization = api.organizations.mutations.createOrganization;
const createProject = api.projects.mutations.createProject;
const createBuiltinFieldDefinition = internal.fields.mutations.createBuiltinFieldDefinition;
const listBuiltinFieldDefinitions = api.fields.queries.listBuiltinFieldDefinitions;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const createRecipe = api.recipes.mutations.createRecipe;
const createInitialDraftVersion = api.recipes.mutations.createInitialDraftVersion;
const addRecipeField = api.recipes.fields.mutations.addRecipeField;
const publishRecipeVersion = api.recipes.mutations.publishRecipeVersion;
const getRecipeVersion = api.recipes.queries.getRecipeVersion;
const createEventFromRecipe = api.events.mutations.createEventFromRecipe;
const getEvent = api.events.queries.getEvent;

// The slice provisions a BUILT-IN definition, which shares the seed opt-in.
enableSeedMutations();

const issuer = 'https://example.clerk.accounts.dev';
const textConfig = { kind: 'text' } as const;

/**
 * The priority vertical slice named in CLAUDE.md, asserted end to end in one
 * place: sign-in → app user → organization → membership → project → field
 * definitions (including a BUILT-IN) → recipe → draft version → published
 * version → typed Event → retrieval.
 *
 * Two things only this test covers:
 *
 *  - A built-in field definition travelling the whole way. Composition alone is
 *    covered elsewhere; publishing a version that contains one is what exercises
 *    the built-in branch of `isUsableDefinition` (recipes/model.ts), and reading
 *    the resulting Event is what proves a built-in's `key`/`label` join like any
 *    tenant-owned definition.
 *  - The coherence of the derived relationships. The Event's organizationId,
 *    projectId, recipeId, and recipeVersionId must all agree with the entities
 *    created upstream — `recipeId` in particular is derived server-side from the
 *    version and never supplied by the client (I4).
 */
test('the Stage B vertical slice runs end to end, carries a built-in field, and derives every relationship from the entities upstream', async () => {
  const t = convexTest(schema, modules);

  // 1. Sign-in → app user. The identity is the only thing the caller brings.
  const client = t.withIdentity({ issuer, subject: 'slice-owner', name: 'Slice Owner', email: 'slice@example.com', emailVerified: true });
  const userId = await client.mutation(ensureUser, {});
  await expect(client.query(getCurrentUser, {})).resolves.toMatchObject({ _id: userId, email: 'slice@example.com' });

  // 2. Organization → owner membership, created in the same transaction.
  const organizationId = await client.mutation(createOrganization, { name: 'Slice Logistics', slug: 'slice-logistics' });
  const membership = await t.run(async (ctx) =>
    ctx.db.query('organizationMemberships').withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', userId)).unique(),
  );
  expect(membership).toMatchObject({ role: 'owner', organizationId, userId });

  // 3. Project.
  const projectId = await client.mutation(createProject, { organizationId, name: 'Airport transfers' });

  // 4. Field definitions: one global built-in (seeded through the internal
  // mutation, the only door built-ins have) and one tenant-owned field.
  const builtinFieldId = await t.mutation(createBuiltinFieldDefinition, {
    key: 'eventName',
    label: 'Event name',
    semanticType: 'eventName',
    config: textConfig,
  });
  const seatsFieldId = await client.mutation(createFieldDefinition, {
    organizationId,
    key: 'seatCount',
    label: 'Seats',
    config: { kind: 'number', min: 1, max: 50, integer: true },
  });
  // The built-in is visible to the tenant through the shared catalogue, which is
  // how a real client would have found it.
  const catalogue = await client.query(listBuiltinFieldDefinitions, { paginationOpts: { numItems: 10, cursor: null } });
  expect(catalogue.page.map((field) => field._id)).toEqual([builtinFieldId]);

  // 5. Recipe → draft version → composition. A built-in belongs to no
  // organization, so composing it proves the usability predicate admits it.
  const recipeId = await client.mutation(createRecipe, { organizationId, key: 'airportTransfer', name: 'Airport transfer' });
  const recipeVersionId = await client.mutation(createInitialDraftVersion, { recipeId });
  await client.mutation(addRecipeField, { recipeVersionId, fieldDefinitionId: builtinFieldId, required: true, visible: true });
  await client.mutation(addRecipeField, { recipeVersionId, fieldDefinitionId: seatsFieldId, required: false, visible: true });

  // 6. Publish. This is the step the built-in had never reached: publishing
  // re-checks every composed definition, so the version only becomes immutable
  // if the built-in is accepted as usable by this organization.
  await expect(client.mutation(publishRecipeVersion, { recipeVersionId })).resolves.toBeNull();
  const publishedVersion = await client.query(getRecipeVersion, { recipeVersionId });
  expect(publishedVersion.version).toMatchObject({ versionNumber: 1, status: 'published', recipeId, organizationId });
  expect(publishedVersion.recipeFields.map((field) => field.fieldDefinitionId)).toEqual([builtinFieldId, seatsFieldId]);

  // 7. A typed Event carrying a value for the built-in field.
  const eventId = await client.mutation(createEventFromRecipe, {
    projectId,
    recipeVersionId,
    name: 'JFK pickup',
    startsAt: 1_700_000_000_000,
    endsAt: 1_700_003_600_000,
    values: [
      { fieldDefinitionId: builtinFieldId, value: { kind: 'text', value: 'JFK arrivals hall' } },
      { fieldDefinitionId: seatsFieldId, value: { kind: 'number', value: 4 } },
    ],
  });

  // 8. Retrieval. Every authoritative link on the stored Event agrees with the
  // entity it came from, including `recipeId`, which the client never sent.
  const { event, values } = await client.query(getEvent, { eventId });
  expect(event).toMatchObject({
    _id: eventId,
    organizationId,
    projectId,
    recipeId,
    recipeVersionId,
    name: 'JFK pickup',
    status: 'draft',
    startsAt: 1_700_000_000_000,
  });
  expect(event.recipeId).toBe(publishedVersion.version.recipeId);

  // The built-in's stored value comes back joined to the built-in's own key and
  // label, exactly as a tenant-owned definition's does.
  expect(values.find((value) => value.fieldDefinitionId === builtinFieldId)).toEqual({
    fieldDefinitionId: builtinFieldId,
    key: 'eventName',
    label: 'Event name',
    value: { kind: 'text', value: 'JFK arrivals hall' },
  });
  expect(values.find((value) => value.fieldDefinitionId === seatsFieldId)).toEqual({
    fieldDefinitionId: seatsFieldId,
    key: 'seatCount',
    label: 'Seats',
    value: { kind: 'number', value: 4 },
  });

  // The stored value row points at the published version's own recipe field row,
  // so the Event is bound to that snapshot rather than to the live definition.
  await t.run(async (ctx) => {
    const stored = await ctx.db
      .query('eventFieldValues')
      .withIndex('by_event_field', (q) => q.eq('eventId', eventId).eq('fieldDefinitionId', builtinFieldId))
      .unique();
    expect(stored?.recipeFieldId).toBe(publishedVersion.recipeFields[0]?._id);
    expect(stored?.organizationId).toBe(organizationId);
  });
});
