import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import {
  requireAuthenticatedUser,
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { validateEntityName } from '../lib/names';
import type { Role } from '../lib/roles';
import { maxLongTextValueLength, maxTextValueLength } from './values';
import {
  fieldConfigValidator,
  isFiniteNumber,
  isValidDateString,
  isValidTimeString,
  semanticRegistry,
  type SemanticCapability,
  type SemanticType,
} from '../validators';

type FieldConfig = typeof fieldConfigValidator.type;
type SelectOption = { id: string; label: string };
type FieldDefinitionPatch = {
  label?: string;
  description?: string;
  key?: string;
  semanticType?: SemanticType;
  config?: FieldConfig;
};

/** Field keys are 2–64 character lowerCamelCase identifiers: /^[a-z][a-zA-Z0-9]*$/. */
const fieldKeyPattern = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Descriptions are free-form operator guidance, but they are copied into
 * immutable publish-time snapshots, so they must stay bounded. 2000 characters
 * is ten times the display-name cap (`maxEntityNameLength`): room for a short
 * paragraph of instructions, small enough that a document stays cheap to read.
 */
const maxFieldDescriptionLength = 2000;

// Recipe versions admit at most 200 fields, so resolving their definitions
// needs no larger caller-controlled lookup batch.
const maxFieldDefinitionIdsPerLookup = 200;

/**
 * The three columns that carry a field's historical meaning. Changing any of
 * them under a published or retired recipe version would reinterpret Events
 * that were already validated against it (I2/I3).
 */
const historicalMeaningFields = ['key', 'semanticType', 'config'] as const;

/**
 * Returns only code-owned capabilities. A missing (or future unrecognized)
 * semantic type intentionally grants no capabilities.
 */
export function capabilitiesForField(
  field: Pick<Doc<'fieldDefinitions'>, 'semanticType'>,
): readonly SemanticCapability[] {
  if (field.semanticType === undefined) {
    return [];
  }
  return semanticRegistry[field.semanticType]?.capabilities ?? [];
}

/** Seed-only path: built-ins have no organization and are never publicly editable. */
export async function createBuiltinFieldDefinition(
  ctx: MutationCtx,
  args: { key: string; label: string; description?: string; semanticType?: SemanticType; config: FieldConfig },
): Promise<Id<'fieldDefinitions'>> {
  const label = await assertValidNewField(ctx, undefined, args);
  return ctx.db.insert('fieldDefinitions', {
    scope: 'builtin',
    key: args.key,
    label,
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.semanticType === undefined ? {} : { semanticType: args.semanticType }),
    config: args.config,
    status: 'active',
  });
}

export async function createFieldDefinition(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; key: string; label: string; description?: string; semanticType?: SemanticType; config: FieldConfig },
): Promise<Id<'fieldDefinitions'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, 'planner');
  const label = await assertValidNewField(ctx, args.organizationId, args);
  const fieldDefinitionId = await ctx.db.insert('fieldDefinitions', {
    scope: 'organization',
    organizationId: args.organizationId,
    key: args.key,
    label,
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.semanticType === undefined ? {} : { semanticType: args.semanticType }),
    config: args.config,
    status: 'active',
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'fieldDefinition.created',
    entityType: 'fieldDefinition',
    entityId: fieldDefinitionId,
    metadata: { key: args.key },
  });
  return fieldDefinitionId;
}

export async function updateFieldDefinition(ctx: MutationCtx, fieldDefinitionId: Id<'fieldDefinitions'>, patch: FieldDefinitionPatch): Promise<void> {
  const { field, access } = await requireOrganizationFieldAccess(ctx, fieldDefinitionId, 'planner');
  // Archived fields are immutable regardless of which columns are patched.
  if (field.status === 'archived') {
    return invalidInput('Archived fields cannot be updated');
  }

  // The real diff is computed before any rule is enforced: a read-modify-write
  // client that echoes a field's current key/semanticType/config back must not
  // trip the immutability guard, because nothing about the field's meaning
  // actually changes (I2/I3 gate on change, not on argument presence).
  const update: FieldDefinitionPatch = {};
  const changedFields: string[] = [];
  if (patch.label !== undefined && patch.label !== field.label) {
    update.label = patch.label;
    changedFields.push('label');
  }
  if (patch.description !== undefined && patch.description !== field.description) {
    update.description = patch.description;
    changedFields.push('description');
  }
  if (patch.key !== undefined && patch.key !== field.key) {
    update.key = patch.key;
    changedFields.push('key');
  }
  if (patch.semanticType !== undefined && patch.semanticType !== field.semanticType) {
    update.semanticType = patch.semanticType;
    changedFields.push('semanticType');
  }
  if (patch.config !== undefined && !sameFieldConfig(patch.config, field.config)) {
    update.config = patch.config;
    changedFields.push('config');
  }
  // A patch that changes nothing writes neither a document patch nor an audit row.
  if (changedFields.length === 0) {
    return;
  }

  const changesHistoricalMeaning = historicalMeaningFields.some((column) => changedFields.includes(column));
  if (changesHistoricalMeaning && (await isReferencedByPublishedVersion(ctx, fieldDefinitionId))) {
    return invalidInput('Fields referenced by published or retired recipe versions may only update label or description');
  }
  if (update.label !== undefined) {
    // Store the trimmed label the validator returns, never the raw argument.
    update.label = validateEntityName(update.label, 'field');
  }
  if (update.description !== undefined) {
    assertValidDescription(update.description);
  }
  if (update.key !== undefined) {
    await assertKeyAvailable(ctx, field.organizationId, update.key, fieldDefinitionId);
  }
  if (update.config !== undefined) {
    assertValidFieldConfig(update.config);
  }
  // Compatibility is judged on the merged pair: changing either half can break it.
  if (update.semanticType !== undefined || update.config !== undefined) {
    assertSemanticCompatibility(update.semanticType ?? field.semanticType, update.config ?? field.config);
  }

  await ctx.db.patch(fieldDefinitionId, update);
  await recordAuditEvent(ctx, {
    organizationId: field.organizationId,
    actorUserId: access.user._id,
    action: 'fieldDefinition.updated',
    entityType: 'fieldDefinition',
    entityId: fieldDefinitionId,
    metadata: { changedFields: changedFields.join(',') },
  });
}

export async function archiveFieldDefinition(ctx: MutationCtx, fieldDefinitionId: Id<'fieldDefinitions'>): Promise<void> {
  const { field, access } = await requireOrganizationFieldAccess(ctx, fieldDefinitionId, 'planner');
  // Idempotent: re-archiving neither re-patches nor writes a second audit row.
  if (field.status === 'archived') return;
  // #8/#9 must exclude archived fields when composing new recipe drafts.
  await ctx.db.patch(fieldDefinitionId, { status: 'archived' });
  await recordAuditEvent(ctx, {
    organizationId: field.organizationId,
    actorUserId: access.user._id,
    action: 'fieldDefinition.archived',
    entityType: 'fieldDefinition',
    entityId: fieldDefinitionId,
    metadata: { previousStatus: field.status },
  });
}

export async function deleteFieldDefinition(ctx: MutationCtx, fieldDefinitionId: Id<'fieldDefinitions'>): Promise<void> {
  const { field, access } = await requireOrganizationFieldAccess(ctx, fieldDefinitionId, 'planner');
  // Both reference tables are checked first-hit through their by_field indexes.
  // recipeFields covers configuration references; eventFieldValues covers
  // operational data, so a field carrying stored Event values survives even if
  // no recipe still lists it (defense in depth ahead of #10).
  const recipeReference = await ctx.db.query('recipeFields').withIndex('by_field', (q) => q.eq('fieldDefinitionId', fieldDefinitionId)).first();
  if (recipeReference !== null) return invalidInput('Referenced field definitions cannot be deleted; archive the field instead');
  const valueReference = await ctx.db.query('eventFieldValues').withIndex('by_field', (q) => q.eq('fieldDefinitionId', fieldDefinitionId)).first();
  if (valueReference !== null) return invalidInput('Referenced field definitions cannot be deleted; archive the field instead');
  await recordAuditEvent(ctx, {
    organizationId: field.organizationId,
    actorUserId: access.user._id,
    action: 'fieldDefinition.deleted',
    entityType: 'fieldDefinition',
    entityId: fieldDefinitionId,
    metadata: { key: field.key },
  });
  await ctx.db.delete(fieldDefinitionId);
}

export async function listFieldDefinitions(ctx: QueryCtx, organizationId: Id<'organizations'>, paginationOpts: PaginationOptions): Promise<PaginationResult<Doc<'fieldDefinitions'>>> {
  await requireOrganizationMembership(ctx, organizationId);
  return ctx.db.query('fieldDefinitions').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).paginate(paginationOpts);
}

export async function listBuiltinFieldDefinitions(ctx: QueryCtx, paginationOpts: PaginationOptions): Promise<PaginationResult<Doc<'fieldDefinitions'>>> {
  await requireAuthenticatedUser(ctx);
  return ctx.db.query('fieldDefinitions').withIndex('by_org', (q) => q.eq('organizationId', undefined)).paginate(paginationOpts);
}

export async function getFieldDefinitionsByIds(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  fieldDefinitionIds: Id<'fieldDefinitions'>[],
): Promise<Doc<'fieldDefinitions'>[]> {
  // Check the raw request before authorization or lookups: repeated ids must
  // not let a caller exceed the recipe-version-sized work budget.
  if (fieldDefinitionIds.length > maxFieldDefinitionIdsPerLookup) {
    return invalidInput(`Field definition lookup cannot exceed ${maxFieldDefinitionIdsPerLookup} ids`);
  }
  await requireOrganizationMembership(ctx, organizationId);

  const uniqueIds = [...new Set(fieldDefinitionIds)];
  const definitions: Doc<'fieldDefinitions'>[] = [];
  for (const fieldDefinitionId of uniqueIds) {
    const definition = await ctx.db.get(fieldDefinitionId);
    // Archived definitions remain resolvable: historical recipe versions must
    // stay interpretable after a definition is archived (I3), unlike new-draft
    // composition where isUsableDefinition deliberately excludes them.
    if (definition !== null && (definition.organizationId === undefined || definition.organizationId === organizationId)) {
      definitions.push(definition);
    }
  }
  // Missing and foreign ids intentionally disappear alike, avoiding an I9
  // cross-tenant existence oracle through errors, statuses, or placeholders.
  return definitions;
}

/**
 * Streams the `recipeFields.by_field` index and returns on the first published
 * or retired hit, so the work is bounded by the position of that hit rather
 * than by the field's total recipe usage — which grows by one row per published
 * version and is never pruned (I6 in spirit: no unbounded materialization).
 * Retired versions count because they remain historically interpretable (I3).
 *
 * CROSS-MODULE COUPLING — read with `getEvent` in events/model.ts. That query
 * joins `key` and `label` from the LIVE definition onto an event's stored
 * values. Including retired versions here is precisely what makes the `key` half
 * of that join safe: an event can only reference a published or retired version,
 * so counting both freezes the key of every definition any event could reference,
 * for that event's whole lifetime. Narrowing this to published-only would let a
 * retired version's definition be re-keyed, and every historical event would
 * silently start reporting a different key for the same stored value — I3 broken
 * with nothing failing here. `label` is deliberately left mutable: it is a
 * display string with no identity meaning.
 */
export async function isReferencedByPublishedVersion(ctx: MutationCtx, fieldDefinitionId: Id<'fieldDefinitions'>): Promise<boolean> {
  for await (const reference of ctx.db.query('recipeFields').withIndex('by_field', (q) => q.eq('fieldDefinitionId', fieldDefinitionId))) {
    const version = await ctx.db.get(reference.recipeVersionId);
    if (version?.status === 'published' || version?.status === 'retired') return true;
  }
  return false;
}

async function requireOrganizationFieldAccess(
  ctx: MutationCtx,
  fieldDefinitionId: Id<'fieldDefinitions'>,
  minimumRole: Role,
): Promise<{ field: Doc<'fieldDefinitions'> & { scope: 'organization'; organizationId: Id<'organizations'> }; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const field = await ctx.db.get(fieldDefinitionId);
  if (field === null || field.scope !== 'organization' || field.organizationId === undefined) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, field.organizationId, minimumRole, authenticated);
  return { field: { ...field, scope: 'organization', organizationId: field.organizationId }, access };
}

/** Returns the trimmed label, which is what the caller must store. */
async function assertValidNewField(
  ctx: MutationCtx,
  organizationId: Id<'organizations'> | undefined,
  args: { key: string; label: string; description?: string; semanticType?: SemanticType; config: FieldConfig },
): Promise<string> {
  const label = validateEntityName(args.label, 'field');
  assertValidDescription(args.description);
  await assertKeyAvailable(ctx, organizationId, args.key);
  assertValidFieldConfig(args.config);
  assertSemanticCompatibility(args.semanticType, args.config);
  return label;
}

/**
 * The single statement of the key rules, shared by creation and rename so a
 * renamed custom key can never reach a state a created one is refused (F1):
 * format, per-organization uniqueness, and — for organization-owned fields —
 * the built-in shadow probe. Both existence checks are indexed reads on
 * `by_org_key`; neither scans.
 */
async function assertKeyAvailable(ctx: MutationCtx, organizationId: Id<'organizations'> | undefined, key: string, currentId?: Id<'fieldDefinitions'>): Promise<void> {
  if (!fieldKeyPattern.test(key) || key.length < 2 || key.length > 64) return invalidInput('Field key must be 2–64 lowerCamelCase characters');
  const existing = await ctx.db.query('fieldDefinitions').withIndex('by_org_key', (q) => q.eq('organizationId', organizationId).eq('key', key)).unique();
  if (existing !== null && existing._id !== currentId) return invalidInput('A field with this key already exists');
  // Built-ins live at organizationId === undefined and were already covered by
  // the read above when creating one; only tenant keys need the shadow probe.
  if (organizationId === undefined) return;
  const builtin = await ctx.db.query('fieldDefinitions').withIndex('by_org_key', (q) => q.eq('organizationId', undefined).eq('key', key)).unique();
  if (builtin !== null) return invalidInput('Custom field keys cannot shadow built-in field keys');
}

function assertValidDescription(description: string | undefined): void {
  if (description !== undefined && description.length > maxFieldDescriptionLength) {
    return invalidInput(`Field description must not exceed ${maxFieldDescriptionLength} characters`);
  }
}

function assertSemanticCompatibility(semanticType: SemanticType | undefined, config: FieldConfig): void {
  // Optional chaining so a semantic type later removed from the registry is
  // rejected as invalid input rather than throwing a TypeError.
  if (semanticType !== undefined && semanticRegistry[semanticType]?.expectedDataType !== config.kind) {
    return invalidInput('Semantic type is incompatible with the field configuration');
  }
}

/**
 * Validates the *contents* of a config, which the Convex union only
 * structurally types. An incoherent config (unparseable date bound, NaN
 * numeric bound, inverted range, empty or ambiguous option set) would be copied
 * verbatim into the immutable publish-time recipeFields snapshot and become the
 * permanent rule set for historical Events (I3) — so it must never be stored.
 */
export function assertValidFieldConfig(config: FieldConfig): void {
  switch (config.kind) {
    case 'boolean':
    case 'location':
      return;
    case 'text':
    case 'longText': {
      assertFiniteBounds(config.minLength, config.maxLength, 'Field length bounds must be finite numbers');
      if (config.minLength !== undefined && config.maxLength !== undefined && config.maxLength < config.minLength) {
        return invalidInput('Field maximum length must not be less than its minimum length');
      }
      // The absolute ceiling is frozen into every snapshot taken from this
      // config: a config may promise less than the value gate allows, never
      // more (see `fields/values.ts`). `minLength` is bounded with it, since a
      // minimum above the ceiling would be unsatisfiable.
      const absoluteMaximum = config.kind === 'text' ? maxTextValueLength : maxLongTextValueLength;
      if ((config.maxLength ?? 0) > absoluteMaximum || (config.minLength ?? 0) > absoluteMaximum) {
        return invalidInput(`Field length bounds must not exceed ${absoluteMaximum} characters`);
      }
      return;
    }
    case 'number':
    case 'datetime':
      assertFiniteBounds(config.min, config.max, 'Field numeric bounds must be finite numbers');
      if (config.min !== undefined && config.max !== undefined && config.max < config.min) {
        return invalidInput('Field maximum must not be less than its minimum');
      }
      return;
    case 'date':
      if ((config.min !== undefined && !isValidDateString(config.min)) || (config.max !== undefined && !isValidDateString(config.max))) {
        return invalidInput('Field date bounds must be YYYY-MM-DD calendar dates');
      }
      // Zero-padded ISO dates order correctly under lexicographic comparison.
      if (config.min !== undefined && config.max !== undefined && config.max < config.min) {
        return invalidInput('Field maximum must not be less than its minimum');
      }
      return;
    case 'time':
      if ((config.min !== undefined && !isValidTimeString(config.min)) || (config.max !== undefined && !isValidTimeString(config.max))) {
        return invalidInput('Field time bounds must be HH:mm wall-clock times');
      }
      // Zero-padded HH:mm orders correctly under lexicographic comparison.
      if (config.min !== undefined && config.max !== undefined && config.max < config.min) {
        return invalidInput('Field maximum must not be less than its minimum');
      }
      return;
    case 'select':
      assertUsableOptions(config.options);
      return;
    case 'multiSelect':
      assertUsableOptions(config.options);
      assertFiniteBounds(config.minSelections, config.maxSelections, 'Selection bounds must be finite numbers');
      if (config.minSelections !== undefined && config.maxSelections !== undefined && config.maxSelections < config.minSelections) {
        return invalidInput('Maximum selections must not be less than minimum selections');
      }
      // An unsatisfiable requirement must be rejected at configuration time, not
      // discovered later by every Event that fails validation against it.
      if (config.minSelections !== undefined && config.minSelections > config.options.length) {
        return invalidInput('Minimum selections must not exceed the number of options');
      }
      if (config.maxSelections !== undefined && config.maxSelections > config.options.length) {
        return invalidInput('Maximum selections must not exceed the number of options');
      }
      return;
  }
}

function assertFiniteBounds(min: number | undefined, max: number | undefined, message: string): void {
  // Convex accepts NaN/Infinity in v.number(); an unorderable bound silently
  // passes every comparison, so it must be refused before it is stored.
  if ((min !== undefined && !isFiniteNumber(min)) || (max !== undefined && !isFiniteNumber(max))) {
    return invalidInput(message);
  }
}

/** The snapshotted option list IS the allowed value set, so it must be usable and unambiguous. */
function assertUsableOptions(options: readonly SelectOption[]): void {
  if (options.length === 0) {
    return invalidInput('Select fields must define at least one option');
  }
  const ids = new Set<string>();
  for (const option of options) {
    if (option.id.length === 0) return invalidInput('Select option ids must be unique and non-empty');
    if (ids.has(option.id)) return invalidInput('Select option ids must be unique and non-empty');
    ids.add(option.id);
  }
}

/**
 * Structural equality over the config union, shared with recipe composition's
 * no-op detection. `JSON.stringify` was key-order sensitive, so an identical
 * config whose properties happened to arrive in a different order read as a
 * change — a spurious audit row, and (once referenced) a spurious immutability
 * rejection.
 */
export function sameFieldConfig(left: FieldConfig, right: FieldConfig): boolean {
  switch (left.kind) {
    case 'boolean':
      return right.kind === 'boolean';
    case 'location':
      return right.kind === 'location';
    case 'text':
      return right.kind === 'text' && left.minLength === right.minLength && left.maxLength === right.maxLength;
    case 'longText':
      return right.kind === 'longText' && left.minLength === right.minLength && left.maxLength === right.maxLength;
    case 'number':
      return right.kind === 'number' && left.min === right.min && left.max === right.max && left.integer === right.integer;
    case 'date':
      return right.kind === 'date' && left.min === right.min && left.max === right.max;
    case 'datetime':
      return right.kind === 'datetime' && left.min === right.min && left.max === right.max;
    case 'time':
      return right.kind === 'time' && left.min === right.min && left.max === right.max;
    case 'select':
      return right.kind === 'select' && sameOptions(left.options, right.options);
    case 'multiSelect':
      return (
        right.kind === 'multiSelect' &&
        sameOptions(left.options, right.options) &&
        left.minSelections === right.minSelections &&
        left.maxSelections === right.maxSelections
      );
  }
}

/** Option order is meaningful (it is the presentation order), so it is compared positionally. */
function sameOptions(left: readonly SelectOption[], right: readonly SelectOption[]): boolean {
  return left.length === right.length && left.every((option, index) => option.id === right[index]?.id && option.label === right[index]?.label);
}
