import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { capabilitiesForField } from '../convex/fields/model';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const updateFieldDefinition = api.fields.mutations.updateFieldDefinition;
const archiveFieldDefinition = api.fields.mutations.archiveFieldDefinition;
const deleteFieldDefinition = api.fields.mutations.deleteFieldDefinition;
const listFieldDefinitions = api.fields.queries.listFieldDefinitions;
const listBuiltinFieldDefinitions = api.fields.queries.listBuiltinFieldDefinitions;
const createBuiltinFieldDefinition = internal.fields.mutations.createBuiltinFieldDefinition;

const NOT_FOUND_OR_INACCESSIBLE = 'Not found or inaccessible';
const UNAUTHENTICATED = 'Unauthenticated';
const IMMUTABLE_MEANING = 'Fields referenced by published or retired recipe versions may only update label or description';
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
    data: 'A field with this key already exists',
  });
  await expect(owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'eventName', label: 'Shadow', config: textConfig })).rejects.toMatchObject({
    data: 'Custom field keys cannot shadow built-in field keys',
  });
  await owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'pickupNote', label: 'Pickup note', config: textConfig });
  await expect(owner.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'pickupNote', label: 'Again', config: textConfig })).rejects.toMatchObject({
    data: 'A field with this key already exists',
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
    data: 'A field with this key already exists',
  });
  // Create-then-rename must not be a back door into shadowing a global built-in.
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: renaming, key: 'eventName' })).rejects.toMatchObject({
    data: 'Custom field keys cannot shadow built-in field keys',
  });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: renaming, key: 'Bad_key' })).rejects.toMatchObject({
    data: 'Field key must be 2–64 lowerCamelCase characters',
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
      data: 'Field key must be 2–64 lowerCamelCase characters',
    });
  }
  await expect(owner.client.mutation(createFieldDefinition, { organizationId, key: 'a'.repeat(64), label: 'Accepted', config: textConfig })).resolves.toBeDefined();
});

test('labels and descriptions are bounded on creation and update', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-text' });

  await expect(owner.client.mutation(createFieldDefinition, { organizationId, key: 'blankLabel', label: '   ', config: textConfig })).rejects.toMatchObject({
    data: 'Invalid field name',
  });
  await expect(owner.client.mutation(createFieldDefinition, { organizationId, key: 'longLabel', label: 'x'.repeat(201), config: textConfig })).rejects.toMatchObject({
    data: 'Invalid field name',
  });
  await expect(
    owner.client.mutation(createFieldDefinition, { organizationId, key: 'longDescription', label: 'Long description', description: 'x'.repeat(2001), config: textConfig }),
  ).rejects.toMatchObject({ data: 'Field description must not exceed 2000 characters' });

  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'goodField', label: 'Good field', config: textConfig });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: '  ' })).rejects.toMatchObject({ data: 'Invalid field name' });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, description: 'x'.repeat(2001) })).rejects.toMatchObject({
    data: 'Field description must not exceed 2000 characters',
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
    data: 'Field date bounds must be YYYY-MM-DD calendar dates',
  });
  await expect(create('impossibleDay', { kind: 'date', min: '2026-02-30' })).rejects.toMatchObject({
    data: 'Field date bounds must be YYYY-MM-DD calendar dates',
  });
  await expect(create('badTimeBound', { kind: 'time', min: '99:99' })).rejects.toMatchObject({
    data: 'Field time bounds must be HH:mm wall-clock times',
  });
  await expect(create('nanBound', { kind: 'number', min: Number.NaN })).rejects.toMatchObject({
    data: 'Field numeric bounds must be finite numbers',
  });
  await expect(create('infiniteBound', { kind: 'datetime', max: Number.POSITIVE_INFINITY })).rejects.toMatchObject({
    data: 'Field numeric bounds must be finite numbers',
  });
  await expect(create('invertedNumber', { kind: 'number', min: 10, max: 5 })).rejects.toMatchObject({
    data: 'Field maximum must not be less than its minimum',
  });
  await expect(create('invertedDate', { kind: 'date', min: '2026-03-01', max: '2026-02-01' })).rejects.toMatchObject({
    data: 'Field maximum must not be less than its minimum',
  });
  await expect(create('invertedLength', { kind: 'text', minLength: 10, maxLength: 5 })).rejects.toMatchObject({
    data: 'Field maximum length must not be less than its minimum length',
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
      data: 'Field length bounds must be finite numbers',
    });
  }
  await expect(create('emptyOptions', { kind: 'select', options: [] })).rejects.toMatchObject({
    data: 'Select fields must define at least one option',
  });
  await expect(create('duplicateOptions', { kind: 'select', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Also A' }] })).rejects.toMatchObject({
    data: 'Select option ids must be unique and non-empty',
  });
  await expect(create('blankOptionId', { kind: 'select', options: [{ id: '', label: 'Blank' }] })).rejects.toMatchObject({
    data: 'Select option ids must be unique and non-empty',
  });
  await expect(create('emptyMultiSelect', { kind: 'multiSelect', options: [], minSelections: 3, maxSelections: 1 })).rejects.toMatchObject({
    data: 'Select fields must define at least one option',
  });
  await expect(
    create('invertedSelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], minSelections: 3, maxSelections: 1 }),
  ).rejects.toMatchObject({ data: 'Maximum selections must not be less than minimum selections' });
  await expect(
    create('unsatisfiableSelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }], minSelections: 2, maxSelections: 2 }),
  ).rejects.toMatchObject({ data: 'Minimum selections must not exceed the number of options' });
  await expect(
    create('tooManySelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }], maxSelections: 2 }),
  ).rejects.toMatchObject({ data: 'Maximum selections must not exceed the number of options' });
  // Selection bounds get their own finiteness rule, and NaN is the case only that
  // rule catches: it is neither less than the minimum nor greater than the
  // option count, so every other selection check passes it through.
  await expect(
    create('nanMinSelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }], minSelections: Number.NaN }),
  ).rejects.toMatchObject({ data: 'Selection bounds must be finite numbers' });
  await expect(
    create('nanMaxSelections', { kind: 'multiSelect', options: [{ id: 'a', label: 'A' }], maxSelections: Number.NaN }),
  ).rejects.toMatchObject({ data: 'Selection bounds must be finite numbers' });

  // Coherent configurations, including equal bounds, are stored.
  await expect(create('validRange', { kind: 'number', min: 5, max: 5, integer: true })).resolves.toBeDefined();
  const numeric = await create('editableRange', { kind: 'number', min: 0, max: 100 });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: numeric, config: { kind: 'number', min: 10, max: 5 } })).rejects.toMatchObject({
    data: 'Field maximum must not be less than its minimum',
  });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: numeric, config: { kind: 'number', min: Number.NaN } })).rejects.toMatchObject({
    data: 'Field numeric bounds must be finite numbers',
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

  await expect(viewer.client.mutation(createFieldDefinition, { organizationId: orgA, key: 'noAccess', label: 'No access', config: textConfig })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  for (const fieldDefinitionId of [foreignFieldId, missingFieldId]) {
    await expect(plannerA.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Nope' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
    await expect(plannerA.client.mutation(archiveFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
    await expect(plannerA.client.mutation(deleteFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  }
});

test('built-in fields are not editable through the public field mutations', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-builtin-guard' });
  const fieldDefinitionId = await t.mutation(createBuiltinFieldDefinition, { key: 'eventName', label: 'Event name', config: textConfig, semanticType: 'eventName' });

  // A built-in belongs to no organization, so no membership can ever reach it;
  // the caller learns nothing about it beyond the generic error (I9).
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Hijacked' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(owner.client.mutation(deleteFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
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
    await expect(t.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Nope' })).rejects.toMatchObject({ data: UNAUTHENTICATED });
    await expect(t.mutation(archiveFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: UNAUTHENTICATED });
    await expect(t.mutation(deleteFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: UNAUTHENTICATED });
  }
  await expect(t.query(listBuiltinFieldDefinitions, { paginationOpts: firstPage })).rejects.toMatchObject({ data: UNAUTHENTICATED });
  await expect(t.query(listFieldDefinitions, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: UNAUTHENTICATED });
  const fakeOrganizationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', { name: 'Temporary', slug: 'fields-probe-ghost' });
    await ctx.db.delete(id);
    return id;
  });
  for (const orgId of [organizationId, fakeOrganizationId]) {
    await expect(t.mutation(createFieldDefinition, { organizationId: orgId, key: 'ghostField', label: 'Nope', config: textConfig })).rejects.toMatchObject({
      data: UNAUTHENTICATED,
    });
  }
});

test('operators cannot author fields; planners and above can', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const operator = await provision(t, 'operator');
  const planner = await provision(t, 'planner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'fields-roles' });
  await owner.client.mutation(addMember, { organizationId, userId: operator.userId, role: 'operator' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const fieldDefinitionId = await planner.client.mutation(createFieldDefinition, { organizationId, key: 'plannerField', label: 'Planner field', config: textConfig });

  await expect(operator.client.mutation(createFieldDefinition, { organizationId, key: 'operatorField', label: 'Nope', config: textConfig })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(operator.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Nope' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(operator.client.mutation(archiveFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(operator.client.mutation(deleteFieldDefinition, { fieldDefinitionId })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(planner.client.mutation(updateFieldDefinition, { fieldDefinitionId, label: 'Renamed' })).resolves.toBeNull();
});

test('semantic compatibility is enforced on creation and update, and absent semantics grant no capabilities', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-semantics' });
  await expect(owner.client.mutation(createFieldDefinition, { organizationId, key: 'badDate', label: 'Bad date', semanticType: 'eventDate', config: textConfig })).rejects.toMatchObject({
    data: 'Semantic type is incompatible with the field configuration',
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
    data: 'Semantic type is incompatible with the field configuration',
  });
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, semanticType: 'eventName' })).resolves.toBeNull();
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, config: longTextConfig })).rejects.toMatchObject({
    data: 'Semantic type is incompatible with the field configuration',
  });
  await t.run(async (ctx) => {
    const field = await ctx.db.get(fieldDefinitionId);
    if (field === null) throw new Error('Expected field');
    // Capabilities come from the code-owned registry, never from tenant data.
    expect(capabilitiesForField(field)).toEqual(['eventName']);
    expect(field.config).toEqual(textConfig);
  });
});

test('published and retired references preserve field meaning while allowing presentation edits', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'fields-immutable' });

  for (const status of ['published', 'retired'] as const) {
    const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, { organizationId, key: `${status}Title`, label: 'Event title', semanticType: 'eventName', config: textConfig });
    // Recipes are introduced in #8. Direct fixtures model the reference here.
    await insertRecipeFieldReference(t, organizationId, fieldDefinitionId, status);

    await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, key: 'changedTitle' })).rejects.toMatchObject({ data: IMMUTABLE_MEANING });
    await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, config: longTextConfig })).rejects.toMatchObject({ data: IMMUTABLE_MEANING });
    await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId, semanticType: 'eventDescription' })).rejects.toMatchObject({ data: IMMUTABLE_MEANING });
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
  await insertRecipeFieldReference(t, organizationId, fieldDefinitionId, 'published');

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
  await insertRecipeFieldReference(t, organizationId, referenced, 'draft');
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: referenced, config: longTextConfig })).resolves.toBeNull();
  await expect(owner.client.mutation(deleteFieldDefinition, { fieldDefinitionId: referenced })).rejects.toMatchObject({ data: 'Referenced field definitions cannot be deleted; archive the field instead' });
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
    data: 'Referenced field definitions cannot be deleted; archive the field instead',
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
      data: 'Archived fields cannot be updated',
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

  await expect(outsider.client.query(listFieldDefinitions, { organizationId: orgA, paginationOpts: firstPage })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(member.client.query(listFieldDefinitions, { organizationId: orgB, paginationOpts: firstPage })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });

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
  expect(page.page.map((field) => field._id)).toEqual([builtinId]);
  expect(page.page.every((field) => field.scope === 'builtin' && field.organizationId === undefined)).toBe(true);
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
  const second = await owner.client.query(listBuiltinFieldDefinitions, { paginationOpts: { numItems: 2, cursor: first.continueCursor } });
  expect(second.page).toHaveLength(1);
  expect(second.isDone).toBe(true);
  // Every built-in appears exactly once across the two pages, and nothing else does.
  expect([...first.page, ...second.page].map((field) => field._id).sort()).toEqual([...builtins].sort());
  expect([...first.page, ...second.page].every((field) => field.scope === 'builtin' && field.organizationId === undefined)).toBe(true);
});

test('field lifecycle writes attributed audit rows naming what changed', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const planner = await provision(t, 'planner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'fields-audit' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });

  const audited = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'auditedField', label: 'Audited', config: textConfig });
  await planner.client.mutation(updateFieldDefinition, { fieldDefinitionId: audited, label: 'Audited twice', key: 'renamedField' });
  // A patch that changes nothing must not write an empty audit row.
  await planner.client.mutation(updateFieldDefinition, { fieldDefinitionId: audited, label: 'Audited twice', key: 'renamedField' });
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
    expect(updated?.actorUserId).toBe(planner.userId);
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

async function insertRecipeFieldReference(
  t: ReturnType<typeof convexTest>,
  organizationId: Id<'organizations'>,
  fieldDefinitionId: Id<'fieldDefinitions'>,
  status: 'draft' | 'published' | 'retired',
) {
  await t.run(async (ctx) => {
    const recipeId = await ctx.db.insert('eventRecipes', { organizationId, key: `recipe${status}`, name: 'Fixture recipe', status: 'draft' });
    const versionId = await ctx.db.insert('recipeVersions', { organizationId, recipeId, versionNumber: 1, status });
    await ctx.db.insert('recipeFields', { organizationId, recipeVersionId: versionId, fieldDefinitionId, position: 1, required: false, visible: true, config: textConfig });
  });
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
