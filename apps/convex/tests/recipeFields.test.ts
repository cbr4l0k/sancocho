import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import type { fieldConfigValidator } from '../convex/validators';
import { enableSeedMutations, modules } from './helpers';

// One test composes a BUILT-IN definition, which shares the seed opt-in.
enableSeedMutations();

const issuer = 'https://example.clerk.accounts.dev';
const identity = (subject: string) => ({ issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true });
const textConfig = { kind: 'text' } as const;
const inaccessible = 'notFoundOrInaccessible';
const unauthenticated = 'unauthenticated';
const narrowingOnly = 'recipeFieldConfigNotNarrower';
const requiredVisible = 'recipeFieldRequiredHidden';
const archivedRecipe = 'recipeArchived';
const badPosition = 'recipeFieldPositionInvalid';
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createField = api.fields.mutations.createFieldDefinition;
const createBuiltinField = internal.fields.mutations.createBuiltinFieldDefinition;
const archiveField = api.fields.mutations.archiveFieldDefinition;
const createRecipe = api.recipes.mutations.createRecipe;
const archiveRecipe = api.recipes.mutations.archiveRecipe;
const createDraft = api.recipes.mutations.createInitialDraftVersion;
const publish = api.recipes.mutations.publishRecipeVersion;
const clone = api.recipes.mutations.clonePublishedVersionToDraft;
const add = api.recipes.fields.mutations.addRecipeField;
const update = api.recipes.fields.mutations.updateRecipeField;
const reorder = api.recipes.fields.mutations.reorderRecipeFields;
const remove = api.recipes.fields.mutations.removeRecipeField;
const list = api.recipes.fields.queries.listRecipeFields;

type FieldConfig = typeof fieldConfigValidator.type;
/** Schema-aware test handle, so `t.run` fixtures can use the real table indexes. */
type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;

async function fixture() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('field-owner'));
  const ownerUserId = await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(createOrganization, { name: 'Recipe fields', slug: 'recipe-fields' });
  const recipeId = await owner.mutation(createRecipe, { organizationId, key: 'eventPlan', name: 'Event plan' });
  const versionId = await owner.mutation(createDraft, { recipeId });
  return { t, owner, ownerUserId, organizationId, recipeId, versionId };
}

/** Raw stored rows, so immutability is asserted on the documents rather than on a query's projection. */
function storedRows(t: SchemaTest, recipeVersionId: Id<'recipeVersions'>): Promise<Doc<'recipeFields'>[]> {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query('recipeFields').withIndex('by_version', (q) => q.eq('recipeVersionId', recipeVersionId)).collect();
    return rows.sort((left, right) => (left._id < right._id ? -1 : 1));
  });
}

test('draft composition validates configs/defaults, ordering, and writes transactional audit rows', async () => {
  const { t, owner, ownerUserId, organizationId, versionId } = await fixture();
  const select = await owner.mutation(createField, { organizationId, key: 'guestType', label: 'Guest type', config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }, { id: 'standard', label: 'Standard' }] } });
  const text = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: select, required: false, visible: true, config: { kind: 'number' } })).rejects.toMatchObject({ data: { code: 'recipeFieldConfigMismatch' } });
  await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: select, required: false, visible: true, config: { kind: 'select', options: [{ id: 'ghost', label: 'Ghost' }] } })).rejects.toMatchObject({ data: { code: 'recipeFieldSnapshotOptionInvalid' } });
  await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: select, required: true, visible: false })).rejects.toMatchObject({ data: { code: requiredVisible } });
  const selectRow = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: select, required: false, visible: true, config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] }, defaultValue: { kind: 'select', optionId: 'vip' } });
  await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: select, required: false, visible: true })).rejects.toMatchObject({ data: { code: 'conflict' } });
  await expect(owner.mutation(update, { recipeFieldId: selectRow, defaultValue: { kind: 'number', value: 2 } })).rejects.toMatchObject({ data: { code: 'fieldValueKindMismatch' } });
  await expect(owner.mutation(update, { recipeFieldId: selectRow, defaultValue: { kind: 'select', optionId: 'ghost' } })).rejects.toMatchObject({ data: { code: 'fieldValueOptionInvalid' } });
  const textRow = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: text, required: false, visible: true });
  await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: await owner.mutation(createField, { organizationId, key: 'anotherCode', label: 'Another', config: textConfig }), required: false, visible: true, position: 1 })).rejects.toMatchObject({ data: { code: 'conflict' } });
  await expect(owner.mutation(update, { recipeFieldId: selectRow, required: true, visible: false })).rejects.toMatchObject({ data: { code: requiredVisible } });
  await expect(owner.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [selectRow] })).rejects.toMatchObject({ data: { code: 'recipeFieldOrderInvalid' } });
  await expect(owner.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [textRow, textRow] })).rejects.toMatchObject({ data: { code: 'recipeFieldOrderInvalid' } });
  await owner.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [textRow, selectRow] });
  expect((await owner.query(list, { recipeVersionId: versionId })).map((row) => [row._id, row.position])).toEqual([[textRow, 0], [selectRow, 1]]);
  await owner.mutation(update, { recipeFieldId: selectRow, defaultValue: null });
  await owner.mutation(remove, { recipeFieldId: textRow });
  await t.run(async (ctx) => {
    const audits = await ctx.db.query('auditEvents').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    // The composition trail in order, each row attributed to this tenant and this
    // actor: two adds, the reorder, the default cleared, the removal.
    expect(
      audits
        .filter((audit) => ['recipeField.added', 'recipeField.updated', 'recipeField.removed', 'recipeVersion.fieldsReordered'].includes(audit.action))
        .slice(-5)
        .map((audit) => [audit.action, audit.organizationId, audit.actorUserId]),
    ).toEqual([
      ['recipeField.added', organizationId, ownerUserId],
      ['recipeField.added', organizationId, ownerUserId],
      ['recipeVersion.fieldsReordered', organizationId, ownerUserId],
      ['recipeField.updated', organizationId, ownerUserId],
      ['recipeField.removed', organizationId, ownerUserId],
    ]);
  });
});

test('a planner — the role floor itself — can add, update, reorder and remove recipe fields', async () => {
  const { t, owner, organizationId, versionId } = await fixture();
  const planner = t.withIdentity(identity('field-planner'));
  const plannerUserId = await planner.mutation(api.auth.mutations.ensureUser, {});
  await owner.mutation(addMember, { organizationId, userId: plannerUserId, role: 'planner' });
  const first = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const second = await owner.mutation(createField, { organizationId, key: 'guestType', label: 'Guest type', config: textConfig });

  // Composition is planner+, not admin+: assembling a draft is authoring work.
  // Asserted from the floor rank itself, so raising the floor to admin fails here
  // instead of passing on the owner's back.
  const firstRow = await planner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: first, required: false, visible: true });
  const secondRow = await planner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: second, required: false, visible: true });
  await expect(planner.mutation(update, { recipeFieldId: firstRow, required: true, visible: true })).resolves.toBeNull();
  await expect(planner.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [secondRow, firstRow] })).resolves.toBeNull();
  await expect(planner.mutation(remove, { recipeFieldId: firstRow })).resolves.toBeNull();
  expect((await planner.query(list, { recipeVersionId: versionId })).map((row) => [row._id, row.position])).toEqual([[secondRow, 0]]);
});

test('published and retired rows are immutable while a clone has independent draft rows', async () => {
  const { owner, organizationId, recipeId, versionId } = await fixture();
  const field = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const row = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: field, required: false, visible: true });
  await owner.mutation(publish, { recipeVersionId: versionId });
  for (const operation of [
    () => owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: field, required: false, visible: true }),
    () => owner.mutation(update, { recipeFieldId: row, required: true }),
    () => owner.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [row] }),
    () => owner.mutation(remove, { recipeFieldId: row }),
  ]) await expect(operation()).rejects.toMatchObject({ data: { code: 'recipeVersionNotDraft' } });
  const v2 = await owner.mutation(clone, { recipeId });
  const cloneRows = await owner.query(list, { recipeVersionId: v2 });
  await owner.mutation(update, { recipeFieldId: cloneRows[0]?._id ?? row, required: true });
  const source = await owner.query(list, { recipeVersionId: versionId });
  expect(source[0]?.required).toBe(false);
  await owner.mutation(publish, { recipeVersionId: v2 });
  const v3 = await owner.mutation(clone, { recipeId });
  await owner.mutation(publish, { recipeVersionId: v3 });
  for (const operation of [
    () => owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: field, required: false, visible: true }),
    () => owner.mutation(update, { recipeFieldId: row, required: true }),
    () => owner.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [row] }),
    () => owner.mutation(remove, { recipeFieldId: row }),
  ]) await expect(operation()).rejects.toMatchObject({ data: { code: 'recipeVersionNotDraft' } });
});

test('field composition rejects foreign/archived definitions and does not disclose IDs to unauthorised callers', async () => {
  const { t, owner, organizationId, versionId } = await fixture();
  const ownField = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const otherOrganizationId = await owner.mutation(createOrganization, { name: 'Other recipe fields', slug: 'other-recipe-fields' });
  const foreignField = await owner.mutation(createField, { organizationId: otherOrganizationId, key: 'foreignCode', label: 'Foreign', config: textConfig });
  const archivedField = await owner.mutation(createField, { organizationId, key: 'retiredCode', label: 'Retired', config: textConfig });
  await owner.mutation(archiveField, { fieldDefinitionId: archivedField });
  await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: foreignField, required: false, visible: true })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: archivedField, required: false, visible: true })).rejects.toMatchObject({ data: { code: inaccessible } });
  const row = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: ownField, required: false, visible: true });
  // Provisioned deliberately: the outsider is a real app user with no membership
  // here, so the opaque errors below are not merely "unknown identity".
  const outsider = t.withIdentity(identity('field-outsider'));
  await outsider.mutation(api.auth.mutations.ensureUser, {});
  const operator = t.withIdentity(identity('field-operator'));
  const operatorUserId = await operator.mutation(api.auth.mutations.ensureUser, {});
  await owner.mutation(addMember, { organizationId, userId: operatorUserId, role: 'operator' });
  await expect(t.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: ownField, required: false, visible: true })).rejects.toMatchObject({ data: { code: unauthenticated } });
  for (const client of [outsider, operator]) {
    await expect(client.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: ownField, required: false, visible: true })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(client.mutation(update, { recipeFieldId: row, required: true })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(client.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [row] })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(client.mutation(remove, { recipeFieldId: row })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  // An operator is a member, so reading a version's fields stays open to it; the
  // rejections above are a role floor on authoring, not on visibility. Only the
  // outsider is refused the read.
  await expect(operator.query(list, { recipeVersionId: versionId })).resolves.toHaveLength(1);
  await expect(outsider.query(list, { recipeVersionId: versionId })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('unauthenticated, fabricated, and cross-tenant ids are refused uniformly on every entry point', async () => {
  const { t, owner, organizationId, recipeId, versionId } = await fixture();
  const fieldDefinitionId = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const row = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId, required: false, visible: true });

  // Every probe below is unauthenticated, so it must never reach a database read.
  await expect(t.mutation(update, { recipeFieldId: row, required: true })).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(t.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [row] })).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(t.mutation(remove, { recipeFieldId: row })).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(t.query(list, { recipeVersionId: versionId })).rejects.toMatchObject({ data: { code: unauthenticated } });

  // Well-formed ids for rows that no longer exist: indistinguishable from ids
  // belonging to another tenant, which is the point (I9).
  const ghost = await t.run(async (ctx) => {
    const recipeFieldId = await ctx.db.insert('recipeFields', { organizationId, recipeVersionId: versionId, fieldDefinitionId, position: 99, required: false, visible: true, config: textConfig });
    await ctx.db.delete(recipeFieldId);
    const recipeVersionId = await ctx.db.insert('recipeVersions', { organizationId, recipeId, versionNumber: 99, status: 'retired' });
    await ctx.db.delete(recipeVersionId);
    return { recipeFieldId, recipeVersionId };
  });
  await expect(owner.mutation(update, { recipeFieldId: ghost.recipeFieldId, required: true })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(remove, { recipeFieldId: ghost.recipeFieldId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(add, { recipeVersionId: ghost.recipeVersionId, fieldDefinitionId, required: false, visible: true })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(reorder, { recipeVersionId: ghost.recipeVersionId, orderedRecipeFieldIds: [] })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.query(list, { recipeVersionId: ghost.recipeVersionId })).rejects.toMatchObject({ data: { code: inaccessible } });

  // A live version in an organization this caller has no membership in.
  const stranger = t.withIdentity(identity('field-stranger'));
  await stranger.mutation(api.auth.mutations.ensureUser, {});
  const strangerOrganizationId = await stranger.mutation(createOrganization, { name: 'Stranger', slug: 'recipe-fields-stranger' });
  const strangerRecipeId = await stranger.mutation(createRecipe, { organizationId: strangerOrganizationId, key: 'eventPlan', name: 'Their plan' });
  const strangerVersionId = await stranger.mutation(createDraft, { recipeId: strangerRecipeId });
  const strangerField = await stranger.mutation(createField, { organizationId: strangerOrganizationId, key: 'theirCode', label: 'Theirs', config: textConfig });
  const strangerRow = await stranger.mutation(add, { recipeVersionId: strangerVersionId, fieldDefinitionId: strangerField, required: false, visible: true });
  await expect(owner.mutation(add, { recipeVersionId: strangerVersionId, fieldDefinitionId, required: false, visible: true })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(reorder, { recipeVersionId: strangerVersionId, orderedRecipeFieldIds: [strangerRow] })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.query(list, { recipeVersionId: strangerVersionId })).rejects.toMatchObject({ data: { code: inaccessible } });
  // A real, correctly-shaped row id from another tenant is not a member of this
  // version's field set, so reordering rejects it as membership rather than
  // silently repositioning a foreign row.
  await expect(owner.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [strangerRow] })).rejects.toMatchObject({ data: { code: 'recipeFieldOrderInvalid' } });

  // A version whose own organizationId says "ours" but whose recipe belongs to
  // another tenant: authorization follows the stored graph, so both the edit gate
  // and the read refuse it even though the caller is a member of the org the
  // version names (I4).
  const grafted = await t.run(async (ctx) => {
    const foreignRecipeId = await ctx.db.insert('eventRecipes', { organizationId: strangerOrganizationId, key: 'grafted', name: 'Grafted', status: 'draft' });
    return ctx.db.insert('recipeVersions', { organizationId, recipeId: foreignRecipeId, versionNumber: 98, status: 'draft' });
  });
  await expect(owner.query(list, { recipeVersionId: grafted })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(owner.mutation(add, { recipeVersionId: grafted, fieldDefinitionId, required: false, visible: true })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('a version cannot grow past the bounded-child-set ceiling', async () => {
  const { t, owner, organizationId, versionId } = await fixture();
  const overflow = await owner.mutation(createField, { organizationId, key: 'overflowCode', label: 'Overflow', config: textConfig });
  // Filling the version through the fixture keeps the test fast; the ceiling is
  // what makes "this child set is bounded" (I6) a structural claim rather than
  // an assumption about how many fields an operator would plausibly compose.
  await t.run(async (ctx) => {
    for (let position = 0; position < 200; position += 1) {
      const fieldDefinitionId = await ctx.db.insert('fieldDefinitions', { scope: 'organization' as const, organizationId, key: `filler${position}`, label: `Filler ${position}`, status: 'active' as const, config: textConfig });
      await ctx.db.insert('recipeFields', { organizationId, recipeVersionId: versionId, fieldDefinitionId, position, required: false, visible: true, config: textConfig });
    }
  });
  await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: overflow, required: false, visible: true })).rejects.toMatchObject({ data: { code: 'recipeFieldLimitExceeded' } });
});

test('a snapshot may narrow its definition but never widen it, on add and on update', async () => {
  const { owner, organizationId, versionId } = await fixture();
  const options = [{ id: 'bags', label: 'Bags' }, { id: 'wifi', label: 'Wifi' }, { id: 'meal', label: 'Meal' }];
  const definitions = {
    text: await owner.mutation(createField, { organizationId, key: 'shortCode', label: 'Short code', config: { kind: 'text', minLength: 2, maxLength: 10 } }),
    longText: await owner.mutation(createField, { organizationId, key: 'recipeNotes', label: 'Notes', config: { kind: 'longText', minLength: 5, maxLength: 100 } }),
    number: await owner.mutation(createField, { organizationId, key: 'seatCount', label: 'Seats', config: { kind: 'number', min: 0, max: 10, integer: true } }),
    date: await owner.mutation(createField, { organizationId, key: 'pickupDay', label: 'Pickup day', config: { kind: 'date', min: '2026-01-01', max: '2026-12-31' } }),
    datetime: await owner.mutation(createField, { organizationId, key: 'pickupAt', label: 'Pickup at', config: { kind: 'datetime', min: 1000, max: 9000 } }),
    time: await owner.mutation(createField, { organizationId, key: 'pickupTime', label: 'Pickup time', config: { kind: 'time', min: '08:00', max: '18:00' } }),
    multiSelect: await owner.mutation(createField, { organizationId, key: 'extras', label: 'Extras', config: { kind: 'multiSelect', options, minSelections: 1, maxSelections: 2 } }),
  };
  // Each branch of the narrowing rule, widened two ways: a looser bound, and a
  // bound dropped entirely (an absent bound is the widest bound of all).
  const widened: [Id<'fieldDefinitions'>, FieldConfig][] = [
    [definitions.text, { kind: 'text', minLength: 1, maxLength: 10 }],
    [definitions.text, { kind: 'text', minLength: 2, maxLength: 20 }],
    [definitions.text, { kind: 'text', maxLength: 10 }],
    [definitions.longText, { kind: 'longText', minLength: 5, maxLength: 200 }],
    [definitions.longText, { kind: 'longText', minLength: 5 }],
    [definitions.number, { kind: 'number', min: -5, max: 10, integer: true }],
    [definitions.number, { kind: 'number', min: 0, max: 50, integer: true }],
    [definitions.number, { kind: 'number', min: 0, max: 10 }],
    [definitions.date, { kind: 'date', min: '2025-01-01', max: '2026-12-31' }],
    [definitions.date, { kind: 'date', min: '2026-01-01', max: '2027-12-31' }],
    [definitions.datetime, { kind: 'datetime', min: 0, max: 9000 }],
    [definitions.datetime, { kind: 'datetime', min: 1000, max: 90000 }],
    [definitions.time, { kind: 'time', min: '07:00', max: '18:00' }],
    [definitions.time, { kind: 'time', min: '08:00', max: '23:00' }],
    [definitions.multiSelect, { kind: 'multiSelect', options, minSelections: 1, maxSelections: 3 }],
    [definitions.multiSelect, { kind: 'multiSelect', options, maxSelections: 2 }],
  ];
  for (const [fieldDefinitionId, config] of widened) {
    await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId, required: false, visible: true, config })).rejects.toMatchObject({ data: { code: narrowingOnly } });
  }

  // The mirror image: every branch narrows successfully, so the rule refuses
  // widening rather than refusing per-recipe configuration.
  const narrowed: [Id<'fieldDefinitions'>, FieldConfig][] = [
    [definitions.text, { kind: 'text', minLength: 3, maxLength: 8 }],
    [definitions.longText, { kind: 'longText', minLength: 10, maxLength: 50 }],
    [definitions.number, { kind: 'number', min: 2, max: 8, integer: true }],
    [definitions.date, { kind: 'date', min: '2026-06-01', max: '2026-06-30' }],
    [definitions.datetime, { kind: 'datetime', min: 2000, max: 8000 }],
    [definitions.time, { kind: 'time', min: '09:00', max: '17:00' }],
    [definitions.multiSelect, { kind: 'multiSelect', options: options.slice(0, 2), minSelections: 2, maxSelections: 2 }],
  ];
  const rows: Id<'recipeFields'>[] = [];
  for (const [fieldDefinitionId, config] of narrowed) {
    rows.push(await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId, required: false, visible: true, config }));
  }
  // Updating is held to exactly the same rule as adding: one rule, two doors.
  const [textRow, , numberRow] = rows;
  if (textRow === undefined || numberRow === undefined) throw new Error('narrowed rows missing');
  await expect(owner.mutation(update, { recipeFieldId: textRow, config: { kind: 'text', minLength: 1, maxLength: 8 } })).rejects.toMatchObject({ data: { code: narrowingOnly } });
  await expect(owner.mutation(update, { recipeFieldId: numberRow, config: { kind: 'number', min: 2, max: 8 } })).rejects.toMatchObject({ data: { code: narrowingOnly } });
  await expect(owner.mutation(update, { recipeFieldId: textRow, config: { kind: 'text', minLength: 4, maxLength: 7 } })).resolves.toBeNull();
});

test('publish enforces the same narrowing rule as composition (one snapshot-coherence rule)', async () => {
  const { t, owner, organizationId, versionId } = await fixture();
  const fieldDefinitionId = await owner.mutation(createField, { organizationId, key: 'shortCode', label: 'Short code', config: { kind: 'text', minLength: 2, maxLength: 10 } });
  const row = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId, required: false, visible: true, config: { kind: 'text', minLength: 3, maxLength: 8 } });
  // A snapshot can only become non-narrowing behind composition's back — a stored
  // row written before the definition tightened, or a direct write. Either way
  // publishing is the last gate before it becomes immutable, and it must apply
  // the same rule composition did rather than a weaker one.
  await t.run(async (ctx) => { await ctx.db.patch(row, { config: { kind: 'text', minLength: 1, maxLength: 80 } }); });
  await expect(owner.mutation(publish, { recipeVersionId: versionId })).rejects.toMatchObject({ data: { code: narrowingOnly } });
  await t.run(async (ctx) => { await ctx.db.patch(row, { config: { kind: 'text', minLength: 3, maxLength: 8 } }); });
  await expect(owner.mutation(publish, { recipeVersionId: versionId })).resolves.toBeNull();
});

test('default values are held to the snapshot rules, including primitives and location references', async () => {
  const { t, owner, organizationId, versionId } = await fixture();
  const numberField = await owner.mutation(createField, { organizationId, key: 'seatCount', label: 'Seats', config: { kind: 'number' } });
  const datetimeField = await owner.mutation(createField, { organizationId, key: 'pickupAt', label: 'Pickup at', config: { kind: 'datetime' } });
  const dateField = await owner.mutation(createField, { organizationId, key: 'pickupDay', label: 'Pickup day', config: { kind: 'date' } });
  const timeField = await owner.mutation(createField, { organizationId, key: 'pickupTime', label: 'Pickup time', config: { kind: 'time' } });
  const locationField = await owner.mutation(createField, { organizationId, key: 'depot', label: 'Depot', config: { kind: 'location' } });
  const foreignOrganizationId = await owner.mutation(createOrganization, { name: 'Other', slug: 'recipe-fields-locations' });
  const locations = await t.run(async (ctx) => {
    const missing = await ctx.db.insert('locations', { organizationId, name: 'Removed depot', type: 'venue', status: 'active' as const });
    await ctx.db.delete(missing);
    return {
      own: await ctx.db.insert('locations', { organizationId, name: 'Own depot', type: 'venue', status: 'active' as const }),
      archived: await ctx.db.insert('locations', { organizationId, name: 'Closed depot', type: 'venue', status: 'archived' as const }),
      foreign: await ctx.db.insert('locations', { organizationId: foreignOrganizationId, name: 'Their depot', type: 'venue', status: 'active' as const }),
      missing,
    };
  });

  const primitives: [Id<'fieldDefinitions'>, FieldConfig, { kind: 'number'; value: number } | { kind: 'datetime'; value: number } | { kind: 'date'; value: string } | { kind: 'time'; value: string }, string][] = [
    [numberField, { kind: 'number' }, { kind: 'number', value: Number.NaN }, 'fieldValueInvalid'],
    [datetimeField, { kind: 'datetime' }, { kind: 'datetime', value: Number.POSITIVE_INFINITY }, 'fieldValueInvalid'],
    [dateField, { kind: 'date' }, { kind: 'date', value: '2026-02-30' }, 'fieldValueInvalid'],
    [timeField, { kind: 'time' }, { kind: 'time', value: '24:61' }, 'fieldValueInvalid'],
  ];
  for (const [fieldDefinitionId, config, defaultValue, data] of primitives) {
    await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId, required: false, visible: true, config, defaultValue })).rejects.toMatchObject({ data: { code: data } });
  }

  // A foreign, archived, or deleted location is refused with the same generic
  // error, so a default value can never be used to probe another tenant (I1/I9).
  for (const locationId of [locations.foreign, locations.archived, locations.missing]) {
    await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: locationField, required: false, visible: true, defaultValue: { kind: 'location', locationId } })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  const locationRow = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: locationField, required: false, visible: true, defaultValue: { kind: 'location', locationId: locations.own } });
  for (const locationId of [locations.foreign, locations.archived, locations.missing]) {
    await expect(owner.mutation(update, { recipeFieldId: locationRow, defaultValue: { kind: 'location', locationId } })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  const stored = await owner.query(list, { recipeVersionId: versionId });
  expect(stored[0]?.defaultValue).toEqual({ kind: 'location', locationId: locations.own });
});

test('narrowing a config re-validates the default already stored against it', async () => {
  const { owner, organizationId, versionId } = await fixture();
  const numberField = await owner.mutation(createField, { organizationId, key: 'seatCount', label: 'Seats', config: { kind: 'number' } });
  const row = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: numberField, required: false, visible: true, config: { kind: 'number', min: 0, max: 100 }, defaultValue: { kind: 'number', value: 50 } });
  // The default is untouched by this update, but the rules that own it change —
  // so it must be re-checked, or the row would be published carrying a default
  // its own snapshot forbids.
  await expect(owner.mutation(update, { recipeFieldId: row, config: { kind: 'number', min: 0, max: 10 } })).rejects.toMatchObject({ data: { code: 'fieldValueRangeInvalid' } });
  const selectField = await owner.mutation(createField, { organizationId, key: 'guestType', label: 'Guest type', config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }, { id: 'standard', label: 'Standard' }] } });
  const selectRow = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: selectField, required: false, visible: true, defaultValue: { kind: 'select', optionId: 'standard' } });
  await expect(owner.mutation(update, { recipeFieldId: selectRow, config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] } })).rejects.toMatchObject({ data: { code: 'fieldValueOptionInvalid' } });
  // Narrowing together with a default that fits the new rules is accepted.
  await expect(owner.mutation(update, { recipeFieldId: row, config: { kind: 'number', min: 0, max: 10 }, defaultValue: { kind: 'number', value: 5 } })).resolves.toBeNull();
});

test('built-in definitions compose, positions append, and explicit positions are validated', async () => {
  const { t, owner, organizationId, versionId } = await fixture();
  const builtin = await t.mutation(createBuiltinField, { key: 'builtinCode', label: 'Built-in code', config: textConfig });
  const custom = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  // A built-in belongs to no organization, so the usability predicate must admit
  // it for every tenant rather than treating "no organizationId" as foreign.
  const builtinRow = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: builtin, required: false, visible: true });
  const customRow = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: custom, required: false, visible: true });
  expect((await owner.query(list, { recipeVersionId: versionId })).map((row) => row.position)).toEqual([0, 1]);

  for (const [index, position] of [-1, 1.5, Number.NaN].entries()) {
    const spare = await owner.mutation(createField, { organizationId, key: `spareCode${index}`, label: 'Spare', config: textConfig });
    await expect(owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: spare, required: false, visible: true, position })).rejects.toMatchObject({ data: { code: badPosition } });
  }

  // Appending is "after the highest occupied slot", not "count of rows": removing
  // the first row must not make the next add collide with the second.
  await owner.mutation(remove, { recipeFieldId: builtinRow });
  const third = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: builtin, required: false, visible: true });
  expect((await owner.query(list, { recipeVersionId: versionId })).map((row) => [row._id, row.position])).toEqual([[customRow, 1], [third, 2]]);
});

test('archived recipes close every composition mutation', async () => {
  const { owner, organizationId, recipeId, versionId } = await fixture();
  const fieldDefinitionId = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const spare = await owner.mutation(createField, { organizationId, key: 'spareCode', label: 'Spare', config: textConfig });
  const row = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId, required: false, visible: true });
  await owner.mutation(archiveRecipe, { recipeId });
  for (const operation of [
    () => owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: spare, required: false, visible: true }),
    () => owner.mutation(update, { recipeFieldId: row, required: true }),
    () => owner.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [row] }),
    () => owner.mutation(remove, { recipeFieldId: row }),
  ]) await expect(operation()).rejects.toMatchObject({ data: { code: archivedRecipe } });
  // Reading the inert draft stays open; only writing is closed.
  await expect(owner.query(list, { recipeVersionId: versionId })).resolves.toHaveLength(1);
});

test('composition audit rows name the action, entity, actor, and operation metadata', async () => {
  const { t, owner, ownerUserId, organizationId, versionId } = await fixture();
  const first = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const second = await owner.mutation(createField, { organizationId, key: 'guestType', label: 'Guest type', config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] } });
  const firstRow = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: first, required: false, visible: true });
  const secondRow = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: second, required: false, visible: true });
  await owner.mutation(update, { recipeFieldId: firstRow, required: true, visible: true });
  // A patch that changes nothing must write neither a document patch nor an audit row.
  await owner.mutation(update, { recipeFieldId: firstRow, required: true, visible: true });
  await owner.mutation(update, { recipeFieldId: secondRow, defaultValue: { kind: 'select', optionId: 'vip' } });
  await owner.mutation(update, { recipeFieldId: secondRow, defaultValue: { kind: 'select', optionId: 'vip' } });
  await owner.mutation(reorder, { recipeVersionId: versionId, orderedRecipeFieldIds: [secondRow, firstRow] });
  await owner.mutation(remove, { recipeFieldId: firstRow });

  await t.run(async (ctx) => {
    const auditsFor = (entityType: 'recipeField' | 'recipeVersion', entityId: string) =>
      ctx.db.query('auditEvents').withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', entityType).eq('entityId', entityId)).collect();

    const firstAudits = await auditsFor('recipeField', firstRow);
    expect(firstAudits.map((audit) => audit.action)).toEqual(['recipeField.added', 'recipeField.updated', 'recipeField.removed']);
    expect(firstAudits[0]).toMatchObject({ organizationId, actorUserId: ownerUserId, entityType: 'recipeField', entityId: firstRow, metadata: { fieldDefinitionId: first, position: 0 } });
    expect(firstAudits[1]).toMatchObject({ actorUserId: ownerUserId, metadata: { changedFields: 'required' } });
    expect(firstAudits[2]).toMatchObject({ actorUserId: ownerUserId, metadata: { fieldDefinitionId: first } });

    const secondAudits = await auditsFor('recipeField', secondRow);
    // Exactly one update row for two identical calls: the second was a no-op.
    expect(secondAudits.map((audit) => audit.action)).toEqual(['recipeField.added', 'recipeField.updated']);
    expect(secondAudits[0]).toMatchObject({ metadata: { fieldDefinitionId: second, position: 1 } });
    expect(secondAudits[1]).toMatchObject({ metadata: { changedFields: 'defaultValue' } });

    const reorderAudits = await auditsFor('recipeVersion', versionId);
    expect(reorderAudits.filter((audit) => audit.action === 'recipeVersion.fieldsReordered')).toMatchObject([
      { organizationId, actorUserId: ownerUserId, entityType: 'recipeVersion', entityId: versionId, metadata: { fieldCount: 2 } },
    ]);
  });
});

test('editing a draft clone leaves the published version’s rows byte-identical', async () => {
  const { t, owner, organizationId, recipeId, versionId } = await fixture();
  const text = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: { kind: 'text', maxLength: 20 } });
  const select = await owner.mutation(createField, { organizationId, key: 'guestType', label: 'Guest type', config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }, { id: 'standard', label: 'Standard' }] } });
  const spare = await owner.mutation(createField, { organizationId, key: 'spareCode', label: 'Spare', config: textConfig });
  await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: text, required: false, visible: true, config: { kind: 'text', maxLength: 20 }, defaultValue: { kind: 'text', value: 'ABC' } });
  await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId: select, required: false, visible: true, defaultValue: { kind: 'select', optionId: 'standard' } });
  await owner.mutation(publish, { recipeVersionId: versionId });
  const publishedBefore = await storedRows(t, versionId);
  expect(publishedBefore).toHaveLength(2);

  const draftId = await owner.mutation(clone, { recipeId });
  const draftRows = await owner.query(list, { recipeVersionId: draftId });
  const draftText = draftRows[0]?._id;
  const draftSelect = draftRows[1]?._id;
  if (draftText === undefined || draftSelect === undefined) throw new Error('clone rows missing');
  // Every axis a draft row can move on: config, default, required/visible,
  // position, membership.
  await owner.mutation(update, { recipeFieldId: draftText, required: true, visible: true, config: { kind: 'text', maxLength: 5 }, defaultValue: { kind: 'text', value: 'XY' } });
  await owner.mutation(update, { recipeFieldId: draftSelect, config: { kind: 'select', options: [{ id: 'vip', label: 'VIP' }] }, defaultValue: { kind: 'select', optionId: 'vip' } });
  await owner.mutation(reorder, { recipeVersionId: draftId, orderedRecipeFieldIds: [draftSelect, draftText] });
  await owner.mutation(remove, { recipeFieldId: draftText });
  await owner.mutation(add, { recipeVersionId: draftId, fieldDefinitionId: spare, required: false, visible: true });

  // The published version's complete row set — ids, creation times, configs,
  // defaults, flags, positions — is exactly what it was (I2/I3).
  expect(await storedRows(t, versionId)).toEqual(publishedBefore);
});

test('a removed definition can be re-added and viewers can read published field sets', async () => {
  const { t, owner, organizationId, versionId } = await fixture();
  const fieldDefinitionId = await owner.mutation(createField, { organizationId, key: 'eventCode', label: 'Code', config: textConfig });
  const row = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId, required: false, visible: true, defaultValue: { kind: 'text', value: 'first' } });
  await owner.mutation(remove, { recipeFieldId: row });
  // Removal frees the `recipeVersionId + fieldDefinitionId` slot, so composing
  // the same definition again is a fresh row rather than a conflict.
  const readded = await owner.mutation(add, { recipeVersionId: versionId, fieldDefinitionId, required: true, visible: true });
  expect(readded).not.toBe(row);
  expect((await owner.query(list, { recipeVersionId: versionId })).map((field) => [field.fieldDefinitionId, field.required, field.defaultValue])).toEqual([[fieldDefinitionId, true, undefined]]);

  await owner.mutation(publish, { recipeVersionId: versionId });
  const viewer = t.withIdentity(identity('field-viewer'));
  const viewerUserId = await viewer.mutation(api.auth.mutations.ensureUser, {});
  await owner.mutation(addMember, { organizationId, userId: viewerUserId, role: 'viewer' });
  await expect(viewer.query(list, { recipeVersionId: versionId })).resolves.toHaveLength(1);
});
