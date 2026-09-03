import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { capabilitiesForField } from '../convex/fields/model';
import schema from '../convex/schema';
import { enableSeedMutations, modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const updateFieldDefinition = api.fields.mutations.updateFieldDefinition;
const archiveFieldDefinition = api.fields.mutations.archiveFieldDefinition;
const deleteFieldDefinition = api.fields.mutations.deleteFieldDefinition;
const listFieldDefinitions = api.fields.queries.listFieldDefinitions;
const listBuiltinFieldDefinitions = api.fields.queries.listBuiltinFieldDefinitions;
const getFieldDefinitionsByIds = api.fields.queries.getFieldDefinitionsByIds;
const createBuiltinFieldDefinition = internal.fields.mutations.createBuiltinFieldDefinition;
const createRecipe = api.recipes.mutations.createRecipe;
const createInitialDraftVersion = api.recipes.mutations.createInitialDraftVersion;
const clonePublishedVersionToDraft = api.recipes.mutations.clonePublishedVersionToDraft;
const publishRecipeVersion = api.recipes.mutations.publishRecipeVersion;
const addRecipeField = api.recipes.fields.mutations.addRecipeField;
const removeRecipeField = api.recipes.fields.mutations.removeRecipeField;
const listRecipeFields = api.recipes.fields.queries.listRecipeFields;

// Built-in creation shares the seed deployment opt-in (it squats a key in every
// tenant's namespace permanently); several tests below drive it.
enableSeedMutations();

const NOT_FOUND_OR_INACCESSIBLE = 'notFoundOrInaccessible';
const UNAUTHENTICATED = 'unauthenticated';
const IMMUTABLE_MEANING = 'fieldHistoricalFrozen';
const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 10, cursor: null };

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: ReturnType<typeof convexTest>, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(ensureUser, {});
  return { client, userId };
}

const textConfig = { kind: 'text' } as const;
const longTextConfig = { kind: 'longText' } as const;

test('field keys are indexed-unique and organization fields cannot shadow built-ins', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const orgA = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-keys-a' });
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'fields-keys-b' });

  await t.mutation(createBuiltinFieldDefinition, { key: 'eventName', label: 'Event name', config: textConfig, semanticType: 'eventName' });
  await expect(t.mutation(createBuiltinFieldDefinition, { key: 'eventName', label: 'Duplicate', config: textConfig })).rejects.toMatchObject({
    data: { code: 'fieldKeyTaken' },
  });
  await expect(owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'eventName', label: 'Shadow', config: textConfig })).rejects.toMatchObject({
    data: { code: 'fieldKeyShadowsBuiltin' },
  });
  await owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'pickupNote', label: 'Pickup note', config: textConfig });
  await expect(owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'pickupNote', label: 'Again', config: textConfig })).rejects.toMatchObject({
    data: { code: 'fieldKeyTaken' },
  });
  await expect(owner.client.mutation(createFieldDefinition, { organizationId: orgB, key: 'pickupNote', label: 'Allowed elsewhere', config: textConfig })).resolves.toBeDefined();
});

test('renaming a key is held to exactly the rules creation is held to', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-rename' });
  await t.mutation(createBuiltinFieldDefinition, { key: 'eventName', label: 'Event name', config: textConfig, semanticType: 'eventName' });
  const taken = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'pickupNote', label: 'Pickup note', config: textConfig });
  const renaming = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'dropoffNote', label: 'Dropoff note', config: textConfig });

  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: renaming, key: 'pickupNote' })).rejects.toMatchObject({
    data: { code: 'fieldKeyTaken' },
  });
  // Create-then-rename must not be a back door into shadowing a global built-in.
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: renaming, key: 'eventName' })).rejects.toMatchObject({
    data: { code: 'fieldKeyShadowsBuiltin' },
  });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: renaming, key: 'Bad_key' })).rejects.toMatchObject({
    data: { code: 'fieldKeyInvalid' },
  });
  // Renaming a field to the key it already has is a no-op, not a self-collision.
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: taken, key: 'pickupNote' })).resolves.toBeNull();
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: renaming, key: 'deliveryNote' })).resolves.toBeNull();
});

test('field keys must be 2–64 lowerCamelCase characters', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-key-format' });

  for (const key of ['Bad_key', 'a', 'a'.repeat(65), '1leading', 'has space', '']) {
    await expect(owner.client.mutation(createFieldDefinition, { organizationId, key, label: 'Rejected', config: textConfig })).rejects.toMatchObject({
      data: { code: 'fieldKeyInvalid' },
    });
  }
  await expect(owner.client.mutation(createFieldDefinition, { organizationId, key: 'a'.repeat(64), label: 'Accepted', config: textConfig })).resolves.toBeDefined();
});

test('labels and descriptions are bounded on creation and update', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-text' });

  await expect(owner.client.mutation(createFieldDefinition, { organizationId, key: 'blankLabel', label: '   ', config: textConfig })).rejects.toMatchObject({
    data: { code: 'entityNameInvalid' },
  });
  await expect(owner.client.mutation(createFieldDefinition, { organizationId, key: 'longLabel', label: 'x'.repeat(201), config: textConfig })).rejects.toMatchObject({
    data: { code: 'entityNameInvalid' },
  });
  await expect(
    owner.client.mutation(createFieldDefinition, { organizationId, key: 'longDescription', label: 'Long description', description: 'x'.repeat(2001), config: textConfig }),
  ).rejects.toMatchObject({ data: { code: 'fieldDescriptionTooLong' } });

  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'goodField', label: 'Good field', config: textConfig });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: '  ' })).rejects.toMatchObject({ data: { code: 'entityNameInvalid' } });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, description: 'x'.repeat(2001) })).rejects.toMatchObject({
    data: { code: 'fieldDescriptionTooLong' },
  });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, description: 'x'.repeat(2000) })).resolves.toBeNull();
});

test('incoherent field configurations are refused before they can be snapshotted', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-config' });
  const create = (key: string, config: Parameters<typeof owner.client.mutation<typeof createFieldDefinition>>[1]['config']) =>
    owner.client.mutation(createFieldDefinition, { organizationId, key, label: 'Config check', config });

  await expect(create('badDateBound', { kind: 'date', min: 'not-a-date' })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  await expect(create('impossibleDay', { kind: 'date', min: '2026-02-30' })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  await expect(create('badTimeBound', { kind: 'time', min: '99:99' })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  await expect(create('nanBound', { kind: 'number', min: Number.NaN })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  await expect(create('infiniteBound', { kind: 'datetime', max: Number.POSITIVE_INFINITY })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  await expect(create('invertedNumber', { kind: 'number', min: 10, max: 5 })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  await expect(create('invertedDate', { kind: 'date', min: '2026-03-01', max: '2026-02-01' })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  await expect(create('invertedLength', { kind: 'text', minLength: 10, maxLength: 5 })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  // Length bounds get the same finiteness rule numeric bounds do, and it is the
  // ONLY rule that catches them: NaN compares false against every other check,
  // so an unorderable length would otherwise be frozen into a publish snapshot.
  for (const config of [
    { kind: 'text', minLength: Number.NaN } as const,
    { kind: 'text', maxLength: Number.NaN } as const,
    { kind: 'longText', minLength: Number.NEGATIVE_INFINITY } as const,
    { kind: 'longText', maxLength: Number.POSITIVE_INFINITY } as const,
  ]) {
    await expect(create(`badLength${config.kind}${config.minLength === undefined ? 'Max' : 'Min'}`, config)).rejects.toMatchObject({
      data: { code: 'fieldConfigInvalid' },
    });
  }
  await expect(create('emptyOptions', { kind: 'select', options: [] })).rejects.toMatchObject({
    data: { code: 'fieldSelectOptionsInvalid' },
  });
  await expect(create('duplicateOptions', { kind: 'select', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Also A' }] })).rejects.toMatchObject({
    data: { code: 'fieldSelectOptionsInvalid' },
  });
  await expect(create('blankOptionId', { kind: 'select', options: [{ id: '', label: 'Blank' }] })).rejects.toMatchObject({
    data: { code: 'fieldSelectOptionsInvalid' },
  });
  await expect(create('emptyMultiSelect', { kind: 'multiSelect', options: [], minSelections: 3, maxSelections: 1 })).rejects.toMatchObject({
    data: { code: 'fieldSelectOptionsInvalid' },
  });
  await expect(
    create('invertedSelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], minSelections: 3, maxSelections: 1 }),
  ).rejects.toMatchObject({ data: { code: 'fieldSelectOptionsInvalid' } });
  await expect(
    create('unsatisfiableSelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }], minSelections: 2, maxSelections: 2 }),
  ).rejects.toMatchObject({ data: { code: 'fieldSelectOptionsInvalid' } });
  await expect(
    create('tooManySelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }], maxSelections: 2 }),
  ).rejects.toMatchObject({ data: { code: 'fieldSelectOptionsInvalid' } });
  // Selection bounds get their own finiteness rule, and NaN is the case only that
  // rule catches: it is neither less than the minimum nor greater than the
  // option count, so every other selection check passes it through.
  await expect(
    create('nanMinSelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }], minSelections: Number.NaN }),
  ).rejects.toMatchObject({ data: { code: 'fieldConfigInvalid' } });
  await expect(
    create('nanMaxSelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }], maxSelections: Number.NaN }),
  ).rejects.toMatchObject({ data: { code: 'fieldConfigInvalid' } });

  // Coherent configurations, including equal bounds, are stored.
  await expect(create('validRange', { kind: 'number', min: 5, max: 5, integer: true })).resolves.toBeDefined();
  const numeric = await create('editableRange', { kind: 'number', min: 0, max: 100 });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: numeric, config: { kind: 'number', min: 10, max: 5 } })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: numeric, config: { kind: 'number', min: Number.NaN } })).rejects.toMatchObject({
    data: { code: 'fieldConfigInvalid' },
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(numeric)).toMatchObject({ config: { kind: 'number', min: 0, max: 100 } });
  });
});

test('field mutation probes are generic across organizations and viewers cannot create', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const plannerA = await provision(t, 'planner-a');
  const viewer = await provision(t, 'viewer');
  const orgA = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-access-a' });
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'fields-access-b' });
  await owner.client.mutation(addMember, { organizationId: orgA, userId: plannerA.userId, role: 'planner' });
  await owner.client.mutation(addMember, { organizationId: orgA, userId: viewer.userId, role: 'viewer' });
  const foreignFieldId = await owner.client.mutation(createFieldDefinition, { organizationId: orgB, key: 'foreignField', label: 'Foreign', config: textConfig });
  const missingFieldId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('fieldDefinitions', { scope: 'organization', organizationId: orgA, key: 'temporaryField', label: 'Temporary', status: 'active', config: textConfig });
    await ctx.db.delete(id);
    return id;
  });

  await expect(viewer.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'noAccess', label: 'No access', config: textConfig })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  for (const fieldDefinitionId of [foreignFieldId, missingFieldId]) {
    await expect(plannerA.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Nope' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(plannerA.client.mutation(archiveFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(plannerA.client.mutation(deleteFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  }
});

test('built-in fields are not editable through the public field mutations', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-builtin-guard' });
  const fieldDefinitionId = await t.mutation(createBuiltinFieldDefinition, { key: 'eventName', label: 'Event name', config: textConfig, semanticType: 'eventName' });

  // A built-in belongs to no organization, so no membership can ever reach it;
  // the caller learns nothing about it beyond the generic error (I9).
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Hijacked' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  await expect(owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  await expect(owner.client.mutation(deleteFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(fieldDefinitionId)).toMatchObject({ scope: 'builtin', label: 'Event name' });
  });
});

test('field operations are indistinguishable for unauthenticated probes (I9)', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'fields-probe' });
  const realFieldId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'realField', label: 'Real', config: textConfig });
  const fakeFieldId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('fieldDefinitions', { scope: 'organization', organizationId, key: 'temporaryField', label: 'Temporary', status: 'active', config: textConfig });
    await ctx.db.delete(id);
    return id;
  });

  for (const fieldDefinitionId of [realFieldId, fakeFieldId]) {
    await expect(t.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Nope' })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
    await expect(t.mutation(archiveFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
    await expect(t.mutation(deleteFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  }
  await expect(t.query(listBuiltinFieldDefinitions, { paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  await expect(t.query(listFieldDefinitions, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  const fakeOrganizationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', { name: 'Temporary', slug: 'fields-probe-ghost' });
    await ctx.db.delete(id);
    return id;
  });
  for (const orgId of [organizationId, fakeOrganizationId]) {
    await expect(t.mutation(createFieldDefinition, { organizationId: orgId, key: 'ghostField', label: 'Nope', config: textConfig })).rejects.toMatchObject({
      data: { code: UNAUTHENTICATED },
    });
  }
});

test('authoring fields is admin+; planners and operators are refused generically', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const operator = await provision(t, 'operator');
  const planner = await provision(t, 'planner');
  const admin = await provision(t, 'admin');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'fields-roles' });
  await owner.client.mutation(addMember, { organizationId, userId: operator.userId, role: 'operator' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });

  // Admin is the floor (`organizationConfigurationRole`): a field definition is
  // the tenant's shared vocabulary, and once a published version references it
  // its key, semantic type and config are frozen for good (I2/I3), so authoring
  // one is an administrator's decision rather than day-to-day planning.
  // Asserted from the floor rank itself, so moving the floor fails here rather
  // than passing on the owner's back.
  const fieldDefinitionId = await admin.client.mutation(createFieldDefinition, { organizationId, key: 'adminField', label: 'Admin field', config: textConfig });
  await expect(admin.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Renamed' })).resolves.toBeNull();

  // A planner is a member and still one rank below the floor, so the refusal is
  // the role check speaking, not membership — and it is the same generic error a
  // stranger gets (I9).
  for (const below of [planner, operator]) {
    await expect(below.client.mutation(createFieldDefinition, { organizationId, key: 'belowField', label: 'Nope', config: textConfig })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(below.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Nope' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(below.client.mutation(archiveFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(below.client.mutation(deleteFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  }

  // Reading is unaffected: planners compose recipes from this catalogue.
  await expect(planner.client.query(listFieldDefinitions, { organizationId, paginationOpts: { numItems: 10, cursor: null } })).resolves.toMatchObject({
    page: [{ _id: fieldDefinitionId }],
  });
});

test('semantic compatibility is enforced on creation and update, and absent semantics grant no capabilities', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-semantics' });
  await expect(owner.client.mutation(createFieldDefinition, { organizationId, key: 'badDate', label: 'Bad date', semanticType: 'eventDate', config: textConfig })).rejects.toMatchObject({
    data: { code: 'fieldSemanticIncompatible' },
  });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'plainText', label: 'Plain text', config: textConfig });
  await t.run(async (ctx) => {
    const field = await ctx.db.get(fieldDefinitionId);
    if (field === null) throw new Error('Expected field');
    expect(capabilitiesForField(field)).toEqual([]);
  });

  // Adding a semantic type the current config cannot carry, and changing the
  // config out from under an existing semantic type, are both incompatible.
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, semanticType: 'eventDate' })).rejects.toMatchObject({
    data: { code: 'fieldSemanticIncompatible' },
  });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, semanticType: 'eventName' })).resolves.toBeNull();
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, config: longTextConfig })).rejects.toMatchObject({
    data: { code: 'fieldSemanticIncompatible' },
  });
  await t.run(async (ctx) => {
    const field = await ctx.db.get(fieldDefinitionId);
    if (field === null) throw new Error('Expected field');
    // Capabilities come from the code-owned registry, never from tenant data.
    expect(capabilitiesForField(field)).toEqual(['eventName']);
    expect(field.config).toEqual(textConfig);
  });
});

/**
 * `passenger.count` and `accessibility.wheelchairCount` are counts of
 * discrete things — never fractional. A field bound to either type must
 * therefore declare `integer: true` on its `number` config, or a value that
 * the semantic type cannot mean (2.5 passengers) becomes storable, and any
 * consumer summing or averaging those values inherits floating-point residue
 * from it.
 */
test('a field bound to a counting semantic type must declare an integer number config', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-integer-semantics' });

  // Creation: a plain (non-integer) number config is refused for both
  // tracked counting semantic types.
  await expect(owner.client.mutation(createFieldDefinition, {
    organizationId, key: 'fractionalPax', label: 'Passengers', semanticType: 'passenger.count', config: { kind: 'number' },
  })).rejects.toMatchObject({ data: { code: 'fieldSemanticIncompatible' } });
  await expect(owner.client.mutation(createFieldDefinition, {
    organizationId, key: 'fractionalChairs', label: 'Wheelchairs', semanticType: 'accessibility.wheelchairCount', config: { kind: 'number' },
  })).rejects.toMatchObject({ data: { code: 'fieldSemanticIncompatible' } });

  // `integer: true` is accepted.
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, {
    organizationId, key: 'integerPax', label: 'Passengers', semanticType: 'passenger.count', config: { kind: 'number', integer: true },
  });

  // Update: binding the semantic type onto an existing non-integer config is
  // refused the same way, matching the creation-time rule (I2/I3's "gate on
  // change, not on argument presence" convention already used elsewhere).
  const plainNumberFieldId = await owner.client.mutation(createFieldDefinition, {
    organizationId, key: 'plainNumber', label: 'Plain number', config: { kind: 'number' },
  });
  await expect(owner.client.mutation(updateFieldDefinition, {
    fieldDefinitionId: plainNumberFieldId, semanticType: 'passenger.count',
  })).rejects.toMatchObject({ data: { code: 'fieldSemanticIncompatible' } });

  // Update: changing an already-integer, already-bound field's config to
  // drop `integer: true` is refused too — the invariant holds after an edit,
  // not just at creation.
  await expect(owner.client.mutation(updateFieldDefinition, {
    fieldDefinitionId, config: { kind: 'number' },
  })).rejects.toMatchObject({ data: { code: 'fieldSemanticIncompatible' } });

  // A semantic type with no `requiresInteger` flag (e.g. `eventName`, a
  // `text` type) is entirely unaffected by this rule.
  await expect(owner.client.mutation(createFieldDefinition, {
    organizationId, key: 'plainTitle', label: 'Title', semanticType: 'eventName', config: textConfig,
  })).resolves.not.toBeNull();
});

test('published and retired references preserve field meaning while allowing presentation edits', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-immutable' });

  for (const status of ['published', 'retired'] as const) {
    const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: `${status}Title`, label: 'Event title', semanticType: 'eventName', config: textConfig });
    // Both references are built through the real composition/publish path, so
    // the rule is proven against states the API can actually reach.
    await referenceFieldFromRecipeVersion(owner, organizationId, fieldDefinitionId, status);

    await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, key: 'changedTitle' })).rejects.toMatchObject({ data: { code: IMMUTABLE_MEANING } });
    await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, config: longTextConfig })).rejects.toMatchObject({ data: { code: IMMUTABLE_MEANING } });
    await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, semanticType: 'eventDescription' })).rejects.toMatchObject({ data: { code: IMMUTABLE_MEANING } });
    await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Renamed', description: 'Still interpretable' })).resolves.toBeNull();
  }
});

test('a read-modify-write client may resubmit an unchanged referenced field', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-echo' });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, {
    organizationId,
    key: 'eventTitle',
    label: 'Event title',
    semanticType: 'eventName',
    config: { kind: 'text', minLength: 1, maxLength: 80 },
  });
  await referenceFieldFromRecipeVersion(owner, organizationId, fieldDefinitionId, 'published');

  // Immutability is gated on what actually changes, not on which arguments the
  // client happened to send back — including a config whose keys arrive in a
  // different order than they were stored in.
  await expect(
    owner.client.mutation(updateFieldDefinition, {
      fieldDefinitionId,
      key: 'eventTitle',
      semanticType: 'eventName',
      config: { maxLength: 80, kind: 'text', minLength: 1 },
      label: 'Event headline',
    }),
  ).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(fieldDefinitionId)).toMatchObject({ label: 'Event headline', key: 'eventTitle' });
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'fieldDefinition').eq('entityId', fieldDefinitionId))
      .collect();
    // Only the label moved, so only the label is reported as changed.
    expect(audits.find((audit) => audit.action === 'fieldDefinition.updated')?.metadata).toMatchObject({ changedFields: 'label' });
  });
});

test('draft-only references allow config edits; references block deletion but not archival', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-references' });
  const referenced = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'draftField', label: 'Draft', config: textConfig });
  await referenceFieldFromRecipeVersion(owner, organizationId, referenced, 'draft');
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: referenced, config: longTextConfig })).resolves.toBeNull();
  await expect(owner.client.mutation(deleteFieldDefinition, { fieldDefinitionId: referenced })).rejects.toMatchObject({ data: { code: 'fieldDeleteBlocked' } });
  await expect(owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId: referenced })).resolves.toBeNull();

  const unreferenced = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'deleteField', label: 'Delete', config: textConfig });
  await expect(owner.client.mutation(deleteFieldDefinition, { fieldDefinitionId: unreferenced })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(unreferenced)).toBeNull();
  });
});

test('stored event values also protect a field from deletion', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-values' });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'valuedField', label: 'Valued', config: textConfig });
  // No recipe row points at this field; only operational data does (#10).
  await insertEventFieldValueReference(t, organizationId, fieldDefinitionId);

  await expect(owner.client.mutation(deleteFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({
    data: { code: 'fieldDeleteBlocked' },
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(fieldDefinitionId)).not.toBeNull();
  });
});

test('archived fields are read-only and archiving stays idempotent', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-archived' });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'archivedField', label: 'Archived', config: textConfig });

  await owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId });
  await expect(owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId })).resolves.toBeNull();
  for (const patch of [{ label: 'Nope' }, { description: 'Nope' }, { key: 'nopeField' }, { config: longTextConfig }]) {
    await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, ...patch })).rejects.toMatchObject({
      data: { code: 'fieldArchived' },
    });
  }

  await t.run(async (ctx) => {
    expect(await ctx.db.get(fieldDefinitionId)).toMatchObject({ status: 'archived', label: 'Archived' });
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'fieldDefinition').eq('entityId', fieldDefinitionId))
      .collect();
    expect(audits.filter((audit) => audit.action === 'fieldDefinition.archived')).toHaveLength(1);
  });
});

test('listFieldDefinitions is membership-gated, tenant-scoped, and paginated', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const outsider = await provision(t, 'outsider');
  const orgA = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-list-a' });
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'fields-list-b' });
  await owner.client.mutation(addMember, { organizationId: orgA, userId: member.userId, role: 'viewer' });
  await t.mutation(createBuiltinFieldDefinition, { key: 'eventName', label: 'Event name', config: textConfig, semanticType: 'eventName' });
  const ours = [
    await owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'oneField', label: 'One', config: textConfig }),
    await owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'twoField', label: 'Two', config: textConfig }),
    await owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'threeField', label: 'Three', config: textConfig }),
  ];
  await owner.client.mutation(createFieldDefinition, { organizationId: orgB, key: 'theirField', label: 'Theirs', config: textConfig });

  await expect(outsider.client.query(listFieldDefinitions, { organizationId: orgA, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  await expect(member.client.query(listFieldDefinitions, { organizationId: orgB, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });

  const page = await member.client.query(listFieldDefinitions, { organizationId: orgA, paginationOpts: firstPage });
  // Neither the other tenant's fields nor the global built-ins appear here.
  expect(page.page.map((field) => field._id).sort()).toEqual([...ours].sort());
  expect(page.page.every((field) => field.organizationId === orgA && field.scope === 'organization')).toBe(true);

  const first = await member.client.query(listFieldDefinitions, { organizationId: orgA, paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  const second = await member.client.query(listFieldDefinitions, { organizationId: orgA, paginationOpts: { numItems: 2, cursor: first.continueCursor } });
  expect(second.page).toHaveLength(1);
  expect(second.isDone).toBe(true);
});

test('listBuiltinFieldDefinitions serves every authenticated user and only built-ins', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const outsider = await provision(t, 'outsider');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-builtins' });
  const builtinId = await t.mutation(createBuiltinFieldDefinition, { key: 'eventName', label: 'Event name', config: textConfig, semanticType: 'eventName' });
  await owner.client.mutation(createFieldDefinition, { organizationId, key: 'tenantField', label: 'Tenant', config: textConfig });

  // Built-ins are the shared catalog: membership in nothing is still enough.
  const page = await outsider.client.query(listBuiltinFieldDefinitions, { paginationOpts: firstPage });
  expect(page.page.map((field) => field._id)).toEqual(expect.arrayContaining([builtinId]));
  expect(page.page).toHaveLength(10);
  expect(page.page.every((field) => field.scope === 'builtin' && field.organizationId === undefined)).toBe(true);
});

test('field-definition search covers labels and keys while preserving scopes and tenants', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const orgA = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-search-a' });
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'fields-search-b' });
  await owner.client.mutation(addMember, { organizationId: orgA, userId: member.userId, role: 'viewer' });
  const labelMatch = await owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'arrivalPoint', label: 'Arrival terminal', config: textConfig });
  const keyMatch = await owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'pickupWindow', label: 'Pickup window', config: textConfig });
  await owner.client.mutation(createFieldDefinition, { organizationId: orgB, key: 'foreignNeedle', label: 'Foreign needle', config: textConfig });
  const builtin = await t.mutation(createBuiltinFieldDefinition, { key: 'builtinNeedle', label: 'Builtin needle', config: textConfig, semanticType: 'eventName' });

  await expect(member.client.query(listFieldDefinitions, { organizationId: orgA, paginationOpts: firstPage, search: 'terminal' })).resolves.toMatchObject({ page: [{ _id: labelMatch }] });
  await expect(member.client.query(listFieldDefinitions, { organizationId: orgA, paginationOpts: firstPage, search: 'pickupwindow' })).resolves.toMatchObject({ page: [{ _id: keyMatch }] });
  await expect(member.client.query(listFieldDefinitions, { organizationId: orgA, paginationOpts: firstPage, search: 'foreignneedle' })).resolves.toMatchObject({ page: [] });
  const builtins = await member.client.query(listBuiltinFieldDefinitions, { paginationOpts: firstPage, search: 'builtinneedle' });
  expect(builtins.page.map((field) => field._id)).toEqual([builtin]);
  expect(builtins.page.every((field) => field.organizationId === undefined)).toBe(true);
});

test('listBuiltinFieldDefinitions walks the catalogue by cursor without repeating or dropping a row', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-builtin-pages' });
  const builtins = [
    await t.mutation(createBuiltinFieldDefinition, { key: 'eventName', label: 'Event name', config: textConfig, semanticType: 'eventName' }),
    await t.mutation(createBuiltinFieldDefinition, { key: 'eventDescription', label: 'Event description', config: longTextConfig, semanticType: 'eventDescription' }),
    await t.mutation(createBuiltinFieldDefinition, { key: 'eventDay', label: 'Event day', config: { kind: 'date' }, semanticType: 'eventDate' }),
  ];
  // A tenant field sits on the same table; the index prefix is what keeps it out.
  await owner.client.mutation(createFieldDefinition, { organizationId, key: 'tenantField', label: 'Tenant', config: textConfig });

  const first = await owner.client.query(listBuiltinFieldDefinitions, { paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  const pages = [first];
  let next = first;
  while (!next.isDone) {
    next = await owner.client.query(listBuiltinFieldDefinitions, { paginationOpts: { numItems: 2, cursor: next.continueCursor } });
    pages.push(next);
  }
  const catalogue = pages.flatMap((page) => page.page);
  // Every built-in appears exactly once across the cursor walk, and nothing else does.
  expect(catalogue.map((field) => field._id)).toEqual(expect.arrayContaining(builtins));
  expect(catalogue).toHaveLength(12);
  expect(catalogue.every((field) => field.scope === 'builtin' && field.organizationId === undefined)).toBe(true);
});

test('getFieldDefinitionsByIds resolves organization definitions and built-ins', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-by-ids' });
  const builtin = await t.mutation(createBuiltinFieldDefinition, {
    key: 'eventName',
    label: 'Event name',
    config: textConfig,
    semanticType: 'eventName',
  });
  const ours = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'pickupNote', label: 'Pickup note', config: textConfig });

  const fields = await owner.client.query(getFieldDefinitionsByIds, { organizationId, fieldDefinitionIds: [ours, builtin] });

  expect(fields.map((field) => field._id)).toEqual([ours, builtin]);
});

test('getFieldDefinitionsByIds returns archived definitions for historical versions', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-by-ids-archived' });
  const archived = await owner.client.mutation(createFieldDefinition, {
    organizationId,
    key: 'historicalNote',
    label: 'Historical note',
    config: textConfig,
  });
  await owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId: archived });

  const fields = await owner.client.query(getFieldDefinitionsByIds, { organizationId, fieldDefinitionIds: [archived] });

  expect(fields).toMatchObject([{ _id: archived, status: 'archived' }]);
});

test('getFieldDefinitionsByIds silently omits another tenant\'s definition', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const orgA = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-by-ids-a' });
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'fields-by-ids-b' });
  const foreign = await owner.client.mutation(createFieldDefinition, {
    organizationId: orgB,
    key: 'foreignNote',
    label: 'Foreign note',
    config: textConfig,
  });

  await expect(owner.client.query(getFieldDefinitionsByIds, { organizationId: orgA, fieldDefinitionIds: [foreign] })).resolves.toEqual([]);
});

test('getFieldDefinitionsByIds silently omits a non-existent definition with the same result shape', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-by-ids-missing' });
  const missing = await t.run(async (ctx) => {
    const id = await ctx.db.insert('fieldDefinitions', {
      scope: 'organization',
      organizationId,
      key: 'temporaryField',
      label: 'Temporary',
      status: 'active',
      config: textConfig,
    });
    await ctx.db.delete(id);
    return id;
  });

  await expect(owner.client.query(getFieldDefinitionsByIds, { organizationId, fieldDefinitionIds: [missing] })).resolves.toEqual([]);
});

test('getFieldDefinitionsByIds bounds and de-duplicates caller-supplied ids', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-by-ids-bounds' });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, {
    organizationId,
    key: 'uniqueNote',
    label: 'Unique note',
    config: textConfig,
  });

  await expect(
    owner.client.query(getFieldDefinitionsByIds, { organizationId, fieldDefinitionIds: Array.from({ length: 201 }, () => fieldDefinitionId) }),
  ).rejects.toMatchObject({ data: { code: 'fieldLookupTooLarge' } });
  const fields = await owner.client.query(getFieldDefinitionsByIds, {
    organizationId,
    fieldDefinitionIds: [fieldDefinitionId, fieldDefinitionId, fieldDefinitionId],
  });
  expect(fields.map((field) => field._id)).toEqual([fieldDefinitionId]);
});

test('getFieldDefinitionsByIds requires membership and authentication', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const outsider = await provision(t, 'outsider');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-by-ids-access' });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, {
    organizationId,
    key: 'privateNote',
    label: 'Private note',
    config: textConfig,
  });

  await expect(outsider.client.query(getFieldDefinitionsByIds, { organizationId, fieldDefinitionIds: [fieldDefinitionId] })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });
  await expect(t.query(getFieldDefinitionsByIds, { organizationId, fieldDefinitionIds: [fieldDefinitionId] })).rejects.toMatchObject({
    data: { code: UNAUTHENTICATED },
  });
});

test('field lifecycle writes attributed audit rows naming what changed', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  // A second actor at the configuration floor, so attribution is proved against
  // someone other than the owner who created the organization.
  const editor = await provision(t, 'editor');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'fields-audit' });
  await owner.client.mutation(addMember, { organizationId, userId: editor.userId, role: 'admin' });

  const audited = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'auditedField', label: 'Audited', config: textConfig });
  await editor.client.mutation(updateFieldDefinition, { fieldDefinitionId: audited, label: 'Audited twice', key: 'renamedField' });
  // A patch that changes nothing must not write an empty audit row.
  await editor.client.mutation(updateFieldDefinition, { fieldDefinitionId: audited, label: 'Audited twice', key: 'renamedField' });
  await owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId: audited });

  const deleted = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'deletedField', label: 'Deleted', config: textConfig });
  await owner.client.mutation(deleteFieldDefinition, { fieldDefinitionId: deleted });

  await t.run(async (ctx) => {
    const auditsFor = async (entityId: Id<'fieldDefinitions'>) =>
      ctx.db
        .query('auditEvents')
        .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'fieldDefinition').eq('entityId', entityId))
        .collect();

    const audits = await auditsFor(audited);
    expect(audits.map((audit) => audit.action).sort()).toEqual(['fieldDefinition.archived', 'fieldDefinition.created', 'fieldDefinition.updated']);
    expect(audits.every((audit) => audit.organizationId === organizationId)).toBe(true);

    const created = audits.find((audit) => audit.action === 'fieldDefinition.created');
    expect(created?.actorUserId).toBe(owner.userId);
    expect(created?.metadata).toMatchObject({ key: 'auditedField' });
    const updated = audits.find((audit) => audit.action === 'fieldDefinition.updated');
    expect(updated?.actorUserId).toBe(editor.userId);
    expect(updated?.metadata).toMatchObject({ changedFields: 'label,key' });
    const archived = audits.find((audit) => audit.action === 'fieldDefinition.archived');
    expect(archived?.actorUserId).toBe(owner.userId);
    expect(archived?.metadata).toMatchObject({ previousStatus: 'active' });

    // The deletion audit row outlives the document it describes.
    const deletionAudits = await auditsFor(deleted);
    expect(deletionAudits.map((audit) => audit.action).sort()).toEqual(['fieldDefinition.created', 'fieldDefinition.deleted']);
    const deletionAudit = deletionAudits.find((audit) => audit.action === 'fieldDefinition.deleted');
    expect(deletionAudit?.actorUserId).toBe(owner.userId);
    expect(deletionAudit?.metadata).toMatchObject({ key: 'deletedField' });
  });
});

/**
 * Composes `fieldDefinitionId` into a recipe version and drives that version to
 * `status` through the ordinary public API — compose, publish, and (for
 * `retired`) publish a successor.
 *
 * It used to be a direct `ctx.db` insert, which fabricated a state the API
 * cannot produce (a published version hanging under a still-draft recipe) and
 * therefore proved the immutability rules only against an impossible shape.
 *
 * The `retired` case needs the successor to compose a DECOY field rather than
 * this one: if v2 kept the field, the definition would still be referenced by a
 * PUBLISHED version and the retired half of the rule would never be exercised.
 */
async function referenceFieldFromRecipeVersion(
  owner: Awaited<ReturnType<typeof provision>>,
  organizationId: Id<'organizations'>,
  fieldDefinitionId: Id<'fieldDefinitions'>,
  status: 'draft' | 'published' | 'retired',
) {
  const recipeId = await owner.client.mutation(createRecipe, { organizationId, key: `recipeFor${status}`, name: 'Fixture recipe' });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await owner.client.mutation(addRecipeField, { recipeVersionId: versionId, fieldDefinitionId, required: false, visible: true });
  if (status === 'draft') return versionId;
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: versionId });
  if (status === 'published') return versionId;

  const decoy = await owner.client.mutation(createFieldDefinition, { organizationId, key: `decoyFor${status}`, label: 'Decoy', config: textConfig });
  const successorId = await owner.client.mutation(clonePublishedVersionToDraft, { recipeId });
  for (const row of await owner.client.query(listRecipeFields, { recipeVersionId: successorId })) {
    await owner.client.mutation(removeRecipeField, { recipeFieldId: row._id });
  }
  await owner.client.mutation(addRecipeField, { recipeVersionId: successorId, fieldDefinitionId: decoy, required: false, visible: true });
  // Publishing the successor retires v1 in the same transaction, so the field
  // under test is now referenced by a retired version and by nothing else.
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: successorId });
  return versionId;
}

/**
 * Models operational data referencing a field while no recipe row does: the
 * fixture's recipeFields row deliberately points at a decoy field, so only
 * eventFieldValues.by_field can protect the field under test.
 */
async function insertEventFieldValueReference(
  t: ReturnType<typeof convexTest>,
  organizationId: Id<'organizations'>,
  fieldDefinitionId: Id<'fieldDefinitions'>,
) {
  await t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', { organizationId, name: 'Fixture project', status: 'draft' });
    const recipeId = await ctx.db.insert('eventRecipes', { organizationId, key: 'valuesRecipe', name: 'Fixture recipe', status: 'draft' });
    const recipeVersionId = await ctx.db.insert('recipeVersions', { organizationId, recipeId, versionNumber: 1, status: 'published' });
    const decoyFieldId = await ctx.db.insert('fieldDefinitions', { scope: 'organization', organizationId, key: 'decoyField', label: 'Decoy', status: 'active', config: textConfig });
    const recipeFieldId = await ctx.db.insert('recipeFields', { organizationId, recipeVersionId, fieldDefinitionId: decoyFieldId, position: 1, required: false, visible: true, config: textConfig });
    const eventId = await ctx.db.insert('events', { organizationId, projectId, recipeId, recipeVersionId, name: 'Fixture event', status: 'draft', startsAt: 0 });
    await ctx.db.insert('eventFieldValues', { organizationId, eventId, recipeFieldId, fieldDefinitionId, value: { kind: 'text', value: 'stored' } });
  });
}
