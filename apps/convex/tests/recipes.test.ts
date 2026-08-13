import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules } from './helpers';

const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const archiveFieldDefinition = api.fields.mutations.archiveFieldDefinition;
const createRecipe = api.recipes.mutations.createRecipe;
const updateRecipeMetadata = api.recipes.mutations.updateRecipeMetadata;
const archiveRecipe = api.recipes.mutations.archiveRecipe;
const createInitialDraftVersion = api.recipes.mutations.createInitialDraftVersion;
const clonePublishedVersionToDraft = api.recipes.mutations.clonePublishedVersionToDraft;
const publishRecipeVersion = api.recipes.mutations.publishRecipeVersion;
const getRecipe = api.recipes.queries.getRecipe;
const getRecipeVersion = api.recipes.queries.getRecipeVersion;
const listRecipes = api.recipes.queries.listRecipes;

const issuer = 'https://example.clerk.accounts.dev';
const unauthenticated = 'Unauthenticated';
const inaccessible = 'Not found or inaccessible';
const firstPage = { numItems: 10, cursor: null };
const textConfig = { kind: 'text' } as const;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: ReturnType<typeof convexTest>, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(api.auth.mutations.ensureUser, {});
  return { client, userId };
}

async function recipeFixture() {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'recipe-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Recipes', slug: 'recipes-fixture' });
  const recipeId = await owner.client.mutation(createRecipe, { organizationId, key: 'eventPlan', name: 'Event plan' });
  return { t, owner, organizationId, recipeId };
}

/**
 * Composing a draft's `recipeFields` rows is issue #9's mutation, so drafts are
 * populated directly here — the same fixture approach `fields.test.ts` uses for
 * recipe references.
 */
type DraftFieldRow = { fieldDefinitionId: Id<'fieldDefinitions'> } & Partial<
  Omit<Doc<'recipeFields'>, '_id' | '_creationTime' | 'organizationId' | 'recipeVersionId' | 'fieldDefinitionId'>
>;

/** Schema-aware test handle, so `t.run` fixtures can use the real table indexes. */
type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;

async function setDraftFields(
  t: SchemaTest,
  organizationId: Id<'organizations'>,
  recipeVersionId: Id<'recipeVersions'>,
  rows: DraftFieldRow[],
) {
  await t.run(async (ctx) => {
    for (const existing of await ctx.db.query('recipeFields').withIndex('by_version', (q) => q.eq('recipeVersionId', recipeVersionId)).collect()) {
      await ctx.db.delete(existing._id);
    }
    let position = 0;
    for (const row of rows) {
      await ctx.db.insert('recipeFields', { organizationId, recipeVersionId, position, required: false, visible: true, config: textConfig, ...row });
      position += 1;
    }
  });
}

test('versions are server-assigned, published versions retire, and sequence never reuses retired numbers', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const v1 = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await setDraftFields(t, organizationId, v1, [{ fieldDefinitionId }]);
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: v1 });
  const v2 = await owner.client.mutation(clonePublishedVersionToDraft, { recipeId });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: v2 });
  const v3 = await owner.client.mutation(clonePublishedVersionToDraft, { recipeId });
  const recipe = await owner.client.query(getRecipe, { recipeId });
  expect(recipe.versions.map((version) => [version.versionNumber, version.status])).toEqual([[1, 'retired'], [2, 'published'], [3, 'draft']]);
  expect(v3).toBeDefined();
});

test('I7: a client cannot choose a version number, and the rejection is argument validation', async () => {
  const { owner, organizationId } = await recipeFixture();
  // Probed against a recipe with NO open draft, deliberately: against a recipe
  // that already has one, every call rejects with the one-draft Conflict whether
  // or not `versionNumber` is accepted, and the test proves nothing. This is the
  // only assertion that clients cannot choose version numbers.
  const untouched = await owner.client.mutation(createRecipe, { organizationId, key: 'serverAssigned', name: 'Server assigned' });
  const rejection: unknown = await owner.client
    // @ts-expect-error versionNumber is deliberately not part of the public validator/API.
    .mutation(createInitialDraftVersion, { recipeId: untouched, versionNumber: 99 })
    .catch((error: unknown) => error);

  // The args validator refuses the extra field before the handler runs, so this
  // is not the application-level Conflict (which would carry `data`).
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).not.toHaveProperty('data');
  expect((rejection as Error).message).toMatch(/Unexpected field `versionNumber`/);

  // The same recipe accepts the well-formed call, which is what proves the
  // rejection above was about the argument rather than about an existing draft.
  const versionId = await owner.client.mutation(createInitialDraftVersion, { recipeId: untouched });
  const created = await owner.client.query(getRecipe, { recipeId: untouched });
  expect(created.versions.map((version) => [version._id, version.versionNumber])).toEqual([[versionId, 1]]);
});

test('recipe keys must be 2–64 lowerCamelCase characters', async () => {
  const { owner, organizationId } = await recipeFixture();
  for (const key of ['Bad_key', 'a', 'a'.repeat(65), '1leading', 'has space', 'kebab-case', '']) {
    await expect(owner.client.mutation(createRecipe, { organizationId, key, name: 'Rejected' })).rejects.toMatchObject({
      data: 'Recipe key must be 2–64 lowerCamelCase characters',
    });
  }
  // Both length bounds are inclusive, and interior capitals and digits are legal.
  await expect(owner.client.mutation(createRecipe, { organizationId, key: 'ab', name: 'Shortest' })).resolves.toBeDefined();
  await expect(owner.client.mutation(createRecipe, { organizationId, key: 'a'.repeat(64), name: 'Longest' })).resolves.toBeDefined();
  await expect(owner.client.mutation(createRecipe, { organizationId, key: 'transferPlan2', name: 'Mixed' })).resolves.toBeDefined();
});

test('one-draft conflict and archived/non-draft publish rules are enforced', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const draft = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await expect(owner.client.mutation(createInitialDraftVersion, { recipeId })).rejects.toMatchObject({ data: 'Conflict' });
  await setDraftFields(t, organizationId, draft, [{ fieldDefinitionId }]);
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: draft });
  await expect(owner.client.mutation(publishRecipeVersion, { recipeVersionId: draft })).rejects.toMatchObject({ data: 'Only draft recipe versions can be published' });
  const clone = await owner.client.mutation(clonePublishedVersionToDraft, { recipeId });
  await owner.client.mutation(archiveRecipe, { recipeId });
  await expect(owner.client.mutation(publishRecipeVersion, { recipeVersionId: clone })).rejects.toMatchObject({ data: 'Archived recipes cannot be published' });
});

test('publish validates draft snapshots and clones keep independent recipe field rows', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const fieldId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'guestType', label: 'Guest type', config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] } });
  const v1 = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await setDraftFields(t, organizationId, v1, [
    { fieldDefinitionId: fieldId, config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] }, defaultValue: { kind: 'select', optionId: 'vip' } },
  ]);
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: v1 });
  const v2 = await owner.client.mutation(clonePublishedVersionToDraft, { recipeId });
  await t.run(async (ctx) => {
    const cloneField = await ctx.db.query('recipeFields').withIndex('by_version', (q) => q.eq('recipeVersionId', v2)).unique();
    if (cloneField === null) throw new Error('clone field missing');
    await ctx.db.patch(cloneField._id, { required: true });
  });
  const source = await owner.client.query(getRecipeVersion, { recipeVersionId: v1 });
  const clone = await owner.client.query(getRecipeVersion, { recipeVersionId: v2 });
  expect(source.recipeFields[0]?.required).toBe(false);
  expect(clone.recipeFields[0]?.required).toBe(true);
});

test('invalid recipe field rows cannot be published', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const draft = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await setDraftFields(t, organizationId, draft, [{ fieldDefinitionId, required: true, visible: false }]);
  await expect(owner.client.mutation(publishRecipeVersion, { recipeVersionId: draft })).rejects.toMatchObject({ data: 'Required recipe fields must be visible' });
});

test('every publish-time snapshot rule rejects before a version becomes immutable', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'recipes-publish-foreign' });
  const textField = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const archivedField = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'retiredCode', label: 'Retired', config: textConfig });
  await owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId: archivedField });
  const foreignField = await owner.client.mutation(createFieldDefinition, { organizationId: foreignOrganizationId, key: 'foreignCode', label: 'Foreign', config: textConfig });
  const selectField = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'guestType', label: 'Guest type', config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] } });
  const numberField = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'seatCount', label: 'Seats', config: { kind: 'number' } });
  const dateField = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'pickupDay', label: 'Pickup day', config: { kind: 'date' } });
  const locationField = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'depot', label: 'Depot', config: { kind: 'location' } });
  const locations = await t.run(async (ctx) => ({
    own: await ctx.db.insert('locations', { organizationId, name: 'Own depot', type: 'venue', status: 'active' }),
    archived: await ctx.db.insert('locations', { organizationId, name: 'Closed depot', type: 'venue', status: 'archived' }),
    foreign: await ctx.db.insert('locations', { organizationId: foreignOrganizationId, name: 'Their depot', type: 'venue', status: 'active' }),
  }));

  const draft = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  const expectRejection = async (rows: DraftFieldRow[], data: string) => {
    await setDraftFields(t, organizationId, draft, rows);
    await expect(owner.client.mutation(publishRecipeVersion, { recipeVersionId: draft })).rejects.toMatchObject({ data });
  };

  await expectRejection([], 'Cannot publish a version with no fields');
  await expectRejection([{ fieldDefinitionId: textField }, { fieldDefinitionId: textField }], 'Recipe version cannot contain duplicate field definitions');
  await expectRejection([{ fieldDefinitionId: archivedField }], 'Recipe fields must reference active fields in the same organization or built-ins');
  // A foreign definition is refused by the same rule, so composing across tenants
  // never becomes publishable configuration (I1).
  await expectRejection([{ fieldDefinitionId: foreignField }], 'Recipe fields must reference active fields in the same organization or built-ins');
  await expectRejection([{ fieldDefinitionId: textField, config: { kind: 'number' } }], 'Recipe field config kind must match the current field definition');
  await expectRejection([{ fieldDefinitionId: selectField, config: { kind: 'select', options: [] } }], 'Select fields must define at least one option');
  // F3 regression: a snapshot may narrow the definition's options but may never
  // carry an option the definition no longer offers.
  await expectRejection(
    [{ fieldDefinitionId: selectField, config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }, { id: 'ghost', label: 'Removed' }] } }],
    'Recipe field snapshot options must still exist in the current field definition',
  );
  await expectRejection([{ fieldDefinitionId: textField, defaultValue: { kind: 'number', value: 1 } }], 'Field value kind must match its field configuration');
  await expectRejection(
    [{ fieldDefinitionId: selectField, config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] }, defaultValue: { kind: 'select', optionId: 'ghost' } }],
    'Field value must reference an option defined by the field configuration',
  );
  await expectRejection([{ fieldDefinitionId: numberField, config: { kind: 'number' }, defaultValue: { kind: 'number', value: Number.NaN } }], 'Field value must be a finite number');
  await expectRejection([{ fieldDefinitionId: dateField, config: { kind: 'date' }, defaultValue: { kind: 'date', value: '2026-02-30' } }], 'Field value must be a YYYY-MM-DD calendar date');
  // F1 regression: a location default from another tenant — and one that is
  // merely archived here — are both refused with the same generic error, so
  // publishing cannot be used to probe foreign ids (I9).
  await expectRejection([{ fieldDefinitionId: locationField, config: { kind: 'location' }, defaultValue: { kind: 'location', locationId: locations.foreign } }], inaccessible);
  await expectRejection([{ fieldDefinitionId: locationField, config: { kind: 'location' }, defaultValue: { kind: 'location', locationId: locations.archived } }], inaccessible);
  const positionMessage = 'Recipe field positions must be unique non-negative integers';
  await expectRejection([{ fieldDefinitionId: textField, position: 0 }, { fieldDefinitionId: selectField, config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] }, position: 0 }], positionMessage);
  await expectRejection([{ fieldDefinitionId: textField, position: -1 }], positionMessage);
  await expectRejection([{ fieldDefinitionId: textField, position: 1.5 }], positionMessage);

  // The version is still a draft after every rejection, and a coherent snapshot
  // — including a narrowed option subset and an own-organization location
  // default — publishes.
  await setDraftFields(t, organizationId, draft, [
    { fieldDefinitionId: textField, position: 0 },
    { fieldDefinitionId: selectField, position: 1, config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] }, defaultValue: { kind: 'select', optionId: 'vip' } },
    { fieldDefinitionId: locationField, position: 2, config: { kind: 'location' }, defaultValue: { kind: 'location', locationId: locations.own } },
  ]);
  await expect(owner.client.mutation(publishRecipeVersion, { recipeVersionId: draft })).resolves.toBeNull();
});

test('a retired version keeps its snapshot readable and can never be republished', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'guestType', label: 'Guest type', config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] } });
  const v1 = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await setDraftFields(t, organizationId, v1, [
    { fieldDefinitionId, config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] }, defaultValue: { kind: 'select', optionId: 'vip' } },
  ]);
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: v1 });
  const beforeRetirement = await owner.client.query(getRecipeVersion, { recipeVersionId: v1 });

  const v2 = await owner.client.mutation(clonePublishedVersionToDraft, { recipeId });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: v2 });

  const afterRetirement = await owner.client.query(getRecipeVersion, { recipeVersionId: v1 });
  expect(afterRetirement.version.status).toBe('retired');
  // Retirement changes the status and nothing else: the snapshot Events were
  // validated against is byte-for-byte what it was when published (I3).
  expect(afterRetirement.recipeFields).toEqual(beforeRetirement.recipeFields);
  await expect(owner.client.mutation(publishRecipeVersion, { recipeVersionId: v1 })).rejects.toMatchObject({ data: 'Only draft recipe versions can be published' });
});

test('recipe authoring is closed to operators and viewers and open from planner up', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const operator = await provision(t, 'recipe-operator');
  const viewer = await provision(t, 'recipe-viewer');
  const planner = await provision(t, 'recipe-planner');
  await owner.client.mutation(addMember, { organizationId, userId: operator.userId, role: 'operator' });
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await setDraftFields(t, organizationId, versionId, [{ fieldDefinitionId }]);

  for (const { client } of [operator, viewer]) {
    await expect(client.mutation(createRecipe, { organizationId, key: 'blockedPlan', name: 'Blocked' })).rejects.toMatchObject({ data: inaccessible });
    await expect(client.mutation(updateRecipeMetadata, { recipeId, name: 'Blocked' })).rejects.toMatchObject({ data: inaccessible });
    await expect(client.mutation(archiveRecipe, { recipeId })).rejects.toMatchObject({ data: inaccessible });
    await expect(client.mutation(createInitialDraftVersion, { recipeId })).rejects.toMatchObject({ data: inaccessible });
    await expect(client.mutation(clonePublishedVersionToDraft, { recipeId })).rejects.toMatchObject({ data: inaccessible });
    await expect(client.mutation(publishRecipeVersion, { recipeVersionId: versionId })).rejects.toMatchObject({ data: inaccessible });
  }
  // Reading stays open to any member, so the rejections above are a role floor
  // on authoring, not on visibility.
  await expect(viewer.client.query(getRecipeVersion, { recipeVersionId: versionId })).resolves.toBeDefined();
  await expect(planner.client.mutation(publishRecipeVersion, { recipeVersionId: versionId })).resolves.toBeNull();
  await expect(planner.client.mutation(createRecipe, { organizationId, key: 'plannerPlan', name: 'Planner plan' })).resolves.toBeDefined();
});

test('recipe metadata updates are validated, refused on archived recipes, and no-ops early', async () => {
  const { owner, organizationId, recipeId } = await recipeFixture();
  await expect(owner.client.mutation(updateRecipeMetadata, { recipeId, name: '   ' })).rejects.toMatchObject({ data: 'Invalid recipe name' });
  await expect(owner.client.mutation(updateRecipeMetadata, { recipeId, name: 'x'.repeat(201) })).rejects.toMatchObject({ data: 'Invalid recipe name' });
  await expect(owner.client.mutation(updateRecipeMetadata, { recipeId, description: 'x'.repeat(2001) })).rejects.toMatchObject({
    data: 'Recipe description must not exceed 2000 characters',
  });
  await expect(owner.client.mutation(updateRecipeMetadata, { recipeId, name: 'Renamed plan', description: 'x'.repeat(2000) })).resolves.toBeNull();
  // Resubmitting the stored values changes nothing and is accepted as a no-op.
  await expect(owner.client.mutation(updateRecipeMetadata, { recipeId, name: 'Renamed plan' })).resolves.toBeNull();

  await owner.client.mutation(archiveRecipe, { recipeId });
  await expect(owner.client.mutation(updateRecipeMetadata, { recipeId, name: 'Too late' })).rejects.toMatchObject({ data: 'Archived recipes cannot be updated' });
  const recipe = await owner.client.query(getRecipe, { recipeId });
  expect(recipe.recipe).toMatchObject({ name: 'Renamed plan', status: 'archived' });
});

test('listRecipes is membership-gated, tenant-scoped, and paginated', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const member = await provision(t, 'recipe-member');
  const outsider = await provision(t, 'recipe-list-outsider');
  const otherOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'recipes-list-other' });
  await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'viewer' });
  const ours = [
    recipeId,
    await owner.client.mutation(createRecipe, { organizationId, key: 'transferPlan', name: 'Transfer plan' }),
    await owner.client.mutation(createRecipe, { organizationId, key: 'shuttlePlan', name: 'Shuttle plan' }),
  ];
  await owner.client.mutation(createRecipe, { organizationId: otherOrganizationId, key: 'eventPlan', name: 'Their plan' });

  await expect(t.query(listRecipes, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: unauthenticated });
  await expect(outsider.client.query(listRecipes, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });
  await expect(member.client.query(listRecipes, { organizationId: otherOrganizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });

  const page = await member.client.query(listRecipes, { organizationId, paginationOpts: firstPage });
  expect(page.page.map((recipe) => recipe._id).sort()).toEqual([...ours].sort());
  expect(page.page.every((recipe) => recipe.organizationId === organizationId)).toBe(true);
  const first = await member.client.query(listRecipes, { organizationId, paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  const second = await member.client.query(listRecipes, { organizationId, paginationOpts: { numItems: 2, cursor: first.continueCursor } });
  expect(second.page).toHaveLength(1);
  expect(second.isDone).toBe(true);
});

test('recipe lifecycle edges: key uniqueness is per tenant and dead-end transitions are refused', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const outsider = await provision(t, 'recipe-edge-outsider');
  const otherOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'recipes-edges-other' });

  await expect(owner.client.mutation(createRecipe, { organizationId, key: 'eventPlan', name: 'Duplicate' })).rejects.toMatchObject({ data: 'Conflict' });
  await expect(owner.client.mutation(createRecipe, { organizationId: otherOrganizationId, key: 'eventPlan', name: 'Same key elsewhere' })).resolves.toBeDefined();
  await expect(owner.client.mutation(clonePublishedVersionToDraft, { recipeId })).rejects.toMatchObject({ data: 'A published recipe version is required to clone' });

  const versionId = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await expect(outsider.client.query(getRecipeVersion, { recipeVersionId: versionId })).rejects.toMatchObject({ data: inaccessible });

  await owner.client.mutation(archiveRecipe, { recipeId });
  // Idempotent: the second archive neither re-patches nor writes a second audit row.
  await expect(owner.client.mutation(archiveRecipe, { recipeId })).resolves.toBeNull();
  await expect(owner.client.mutation(createInitialDraftVersion, { recipeId })).rejects.toMatchObject({ data: 'Archived recipes cannot get new drafts' });
  await expect(owner.client.mutation(clonePublishedVersionToDraft, { recipeId })).rejects.toMatchObject({ data: 'Archived recipes cannot get new drafts' });
  await t.run(async (ctx) => {
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'eventRecipe').eq('entityId', recipeId))
      .collect();
    expect(audits.filter((audit) => audit.action === 'recipe.archived')).toHaveLength(1);
  });
});

test('archiving a recipe retires its published version in the same transaction', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const published = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await setDraftFields(t, organizationId, published, [{ fieldDefinitionId }]);
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: published });
  const draft = await owner.client.mutation(clonePublishedVersionToDraft, { recipeId });

  await owner.client.mutation(archiveRecipe, { recipeId });
  const recipe = await owner.client.query(getRecipe, { recipeId });
  expect(recipe.recipe.status).toBe('archived');
  // No published version survives an archived recipe, but the retired one stays
  // readable; the untouched draft is inert because publishing it is refused.
  expect(recipe.versions.map((version) => [version.versionNumber, version.status])).toEqual([[1, 'retired'], [2, 'draft']]);
  await expect(owner.client.query(getRecipeVersion, { recipeVersionId: published })).resolves.toMatchObject({ version: { status: 'retired' } });
  await expect(owner.client.mutation(publishRecipeVersion, { recipeVersionId: draft })).rejects.toMatchObject({ data: 'Archived recipes cannot be published' });
});

test('recipe lifecycle writes attributed audit rows naming versions and sources', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const planner = await provision(t, 'recipe-audit-planner');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });

  await planner.client.mutation(updateRecipeMetadata, { recipeId, name: 'Audited plan' });
  // A patch that changes nothing must not write an empty audit row.
  await planner.client.mutation(updateRecipeMetadata, { recipeId, name: 'Audited plan' });
  const v1 = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await setDraftFields(t, organizationId, v1, [{ fieldDefinitionId }]);
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: v1 });
  const v2 = await planner.client.mutation(clonePublishedVersionToDraft, { recipeId });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: v2 });
  await owner.client.mutation(archiveRecipe, { recipeId });

  await t.run(async (ctx) => {
    const auditsFor = async (entityType: 'eventRecipe' | 'recipeVersion', entityId: string) =>
      ctx.db
        .query('auditEvents')
        .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', entityType).eq('entityId', entityId))
        .collect();

    const recipeAudits = await auditsFor('eventRecipe', recipeId);
    expect(recipeAudits.map((audit) => audit.action)).toEqual(['recipe.created', 'recipe.updated', 'recipe.archived']);
    expect(recipeAudits.every((audit) => audit.organizationId === organizationId)).toBe(true);
    expect(recipeAudits[0]).toMatchObject({ actorUserId: owner.userId, metadata: { key: 'eventPlan' } });
    expect(recipeAudits[1]).toMatchObject({ actorUserId: planner.userId, metadata: { changedFields: 'name' } });
    expect(recipeAudits[2]).toMatchObject({ actorUserId: owner.userId, metadata: { previousStatus: 'active' } });

    const firstVersionAudits = await auditsFor('recipeVersion', v1);
    expect(firstVersionAudits.map((audit) => audit.action)).toEqual(['recipeVersion.created', 'recipeVersion.published', 'recipeVersion.retired']);
    expect(firstVersionAudits[0]).toMatchObject({ actorUserId: owner.userId, metadata: { versionNumber: 1 } });
    expect(firstVersionAudits[1]).toMatchObject({ actorUserId: owner.userId, metadata: { versionNumber: 1 } });
    expect(firstVersionAudits[2]).toMatchObject({ actorUserId: owner.userId, metadata: { versionNumber: 1 } });

    const secondVersionAudits = await auditsFor('recipeVersion', v2);
    // F7: a clone names both the version it created and the version it came from.
    expect(secondVersionAudits[0]).toMatchObject({ action: 'recipeVersion.created', actorUserId: planner.userId, metadata: { versionNumber: 2, clonedFromVersion: 1 } });
    // F5: archiving the recipe retires the live published version, audit row included.
    expect(secondVersionAudits.map((audit) => audit.action)).toEqual(['recipeVersion.created', 'recipeVersion.published', 'recipeVersion.retired']);
    expect(secondVersionAudits[2]).toMatchObject({ actorUserId: owner.userId, metadata: { versionNumber: 2 } });
  });
});

test('concurrent initial-draft creation leaves exactly one draft (one-draft contract)', async () => {
  const { t, owner, recipeId } = await recipeFixture();
  // Either the loser observes the winner's row and fails the invariant check, or
  // the two mutations serialize and the second one conflicts. Both outcomes are
  // the contract; two draft rows never are (architecture review §10).
  const outcomes = await Promise.allSettled([
    owner.client.mutation(createInitialDraftVersion, { recipeId }),
    owner.client.mutation(createInitialDraftVersion, { recipeId }),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ data: 'Conflict' });
  }
  await t.run(async (ctx) => {
    const drafts = await ctx.db.query('recipeVersions').withIndex('by_recipe_status', (q) => q.eq('recipeId', recipeId).eq('status', 'draft')).collect();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.versionNumber).toBe(1);
  });
});

test('recipe and version probes are uniform for unauthenticated and outsider callers', async () => {
  const { t, owner, organizationId, recipeId } = await recipeFixture();
  const versionId = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  const outsider = await provision(t, 'recipe-outsider');
  const missingRecipe = await t.run(async (ctx) => { const id = await ctx.db.insert('eventRecipes', { organizationId, key: 'temporary', name: 'Temporary', status: 'draft' }); await ctx.db.delete(id); return id; });
  for (const id of [recipeId, missingRecipe]) {
    await expect(t.query(getRecipe, { recipeId: id })).rejects.toMatchObject({ data: unauthenticated });
    await expect(outsider.client.query(getRecipe, { recipeId: id })).rejects.toMatchObject({ data: inaccessible });
  }
  await expect(t.query(getRecipeVersion, { recipeVersionId: versionId })).rejects.toMatchObject({ data: unauthenticated });
  await expect(outsider.client.mutation(publishRecipeVersion, { recipeVersionId: versionId })).rejects.toMatchObject({ data: inaccessible });

  // Every authoring mutation is closed to an unauthenticated caller too, for a
  // real id as for a fabricated one: none of them may reach a database read.
  const missingVersion = await t.run(async (ctx) => { const id = await ctx.db.insert('recipeVersions', { organizationId, recipeId, versionNumber: 99, status: 'draft' }); await ctx.db.delete(id); return id; });
  for (const id of [recipeId, missingRecipe]) {
    await expect(t.mutation(updateRecipeMetadata, { recipeId: id, name: 'Nope' })).rejects.toMatchObject({ data: unauthenticated });
    await expect(t.mutation(archiveRecipe, { recipeId: id })).rejects.toMatchObject({ data: unauthenticated });
    await expect(t.mutation(createInitialDraftVersion, { recipeId: id })).rejects.toMatchObject({ data: unauthenticated });
    await expect(t.mutation(clonePublishedVersionToDraft, { recipeId: id })).rejects.toMatchObject({ data: unauthenticated });
  }
  for (const id of [versionId, missingVersion]) {
    await expect(t.mutation(publishRecipeVersion, { recipeVersionId: id })).rejects.toMatchObject({ data: unauthenticated });
  }
  await expect(t.mutation(createRecipe, { organizationId, key: 'unauthenticatedPlan', name: 'Nope' })).rejects.toMatchObject({ data: unauthenticated });
});
