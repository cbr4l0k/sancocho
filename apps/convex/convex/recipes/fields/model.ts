import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { recordAuditEvent } from '../../audit/model';
import { sameFieldConfig } from '../../fields/model';
import { locationIdFromValue } from '../../fields/values';
import { requireAuthenticatedUser, requireOrganizationMembership, requireOrganizationRole, type AuthenticatedUser, type OrganizationMembershipAccess } from '../../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../../lib/errors';
import type { Role } from '../../lib/roles';
import type { eventFieldValueValidator, fieldConfigValidator } from '../../validators';
import {
  assertRequiredImpliesVisible,
  assertSnapshotCoherentWithDefinition,
  getVersionFields,
  isUsableDefinition,
  maxFieldsPerVersion,
  validateRecipeFieldDefaultValue,
} from '../model';

type FieldConfig = typeof fieldConfigValidator.type;
type EventFieldValue = typeof eventFieldValueValidator.type;

type AddRecipeFieldArgs = {
  recipeVersionId: Id<'recipeVersions'>;
  fieldDefinitionId: Id<'fieldDefinitions'>;
  required: boolean;
  visible: boolean;
  position?: number;
  config?: FieldConfig;
  defaultValue?: EventFieldValue;
};
type UpdateRecipeFieldArgs = {
  recipeFieldId: Id<'recipeFields'>;
  required?: boolean;
  visible?: boolean;
  config?: FieldConfig;
  /** `null` explicitly removes a previously stored default. */
  defaultValue?: EventFieldValue | null;
};

/**
 * Future conditional rules belong on `recipeFields` as another closed validator
 * union (for example `{ kind: 'if', fieldId, comparison, value, constraint }`)
 * beside this row's config snapshot. They must be evaluated by a dedicated,
 * typed validator at publish/event-write time; arbitrary expressions and a
 * rules engine are explicitly out of scope (I8).
 */

/**
 * The sole edit gate for recipe composition. Authentication deliberately comes
 * before the version lookup, then membership/role comes from the stored version
 * and recipe graph (I1/I4/I9). Every draft mutation below passes through here.
 *
 * `preResolvedUser` lets the two mutations that must `ctx.db.get` a recipeField
 * first — and therefore already proved identity → app user to keep that lookup
 * behind authentication — hand the same result in rather than resolving the
 * identity a second time. It is producible only by `requireAuthenticatedUser`,
 * so passing it skips no link of the chain.
 */
export async function requireDraftVersionForEdit(
  ctx: MutationCtx,
  recipeVersionId: Id<'recipeVersions'>,
  minimumRole: Role,
  preResolvedUser?: AuthenticatedUser,
): Promise<{ version: Doc<'recipeVersions'>; recipe: Doc<'eventRecipes'>; access: OrganizationMembershipAccess }> {
  const authenticated = preResolvedUser ?? (await requireAuthenticatedUser(ctx));
  const version = await ctx.db.get(recipeVersionId);
  if (version === null) return notFoundOrInaccessible();
  const recipe = await ctx.db.get(version.recipeId);
  if (recipe === null || recipe.organizationId !== version.organizationId) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, version.organizationId, minimumRole, authenticated);
  if (recipe.status === 'archived') return invalidInput('Archived recipes cannot be edited');
  if (version.status !== 'draft') return invalidInput('Published and retired versions are immutable');
  return { version, recipe, access };
}

export async function addRecipeField(ctx: MutationCtx, args: AddRecipeFieldArgs): Promise<Id<'recipeFields'>> {
  const { version, access } = await requireDraftVersionForEdit(ctx, args.recipeVersionId, 'planner');
  assertRequiredImpliesVisible(args.required, args.visible);
  const definition = await getUsableDefinition(ctx, args.fieldDefinitionId, version.organizationId);
  const duplicate = await ctx.db.query('recipeFields').withIndex('by_version_field', (q) => q.eq('recipeVersionId', version._id).eq('fieldDefinitionId', args.fieldDefinitionId)).unique();
  if (duplicate !== null) return conflict();
  const config = args.config ?? definition.config;
  assertSnapshotCoherentWithDefinition(config, definition.config);
  if (args.defaultValue !== undefined) await validateRecipeFieldDefaultValue(ctx, args.defaultValue, config, version.organizationId);
  // One read of the sibling set answers both the size ceiling and the position,
  // and — being an indexed read in the same mutation as the insert — is exactly
  // the read-before-write that makes both race-safe under Convex OCC.
  const siblings = await getVersionFields(ctx, version._id);
  if (siblings.length >= maxFieldsPerVersion) return invalidInput(`A recipe version cannot hold more than ${maxFieldsPerVersion} fields`);
  const position = args.position === undefined ? nextPosition(siblings) : availablePosition(siblings, args.position);
  // The location mirror is derived from the default, never taken from args (I4).
  const defaultLocationId = locationIdFromValue(args.defaultValue);
  const recipeFieldId = await ctx.db.insert('recipeFields', {
    organizationId: version.organizationId,
    recipeVersionId: version._id,
    fieldDefinitionId: definition._id,
    position,
    required: args.required,
    visible: args.visible,
    ...(args.defaultValue === undefined ? {} : { defaultValue: args.defaultValue }),
    ...(defaultLocationId === undefined ? {} : { defaultLocationId }),
    config,
  });
  await recordAuditEvent(ctx, { organizationId: version.organizationId, actorUserId: access.user._id, action: 'recipeField.added', entityType: 'recipeField', entityId: recipeFieldId, metadata: { fieldDefinitionId: definition._id, position } });
  return recipeFieldId;
}

export async function updateRecipeField(ctx: MutationCtx, args: UpdateRecipeFieldArgs): Promise<void> {
  // Authenticate before a recipeField id is looked up, matching the #5 I9
  // ordering; the resolved identity is then reused by the edit gate.
  const authenticated = await requireAuthenticatedUser(ctx);
  const recipeField = await ctx.db.get(args.recipeFieldId);
  if (recipeField === null) return notFoundOrInaccessible();
  const { version, access } = await requireDraftVersionForEdit(ctx, recipeField.recipeVersionId, 'planner', authenticated);
  if (recipeField.organizationId !== version.organizationId) return notFoundOrInaccessible();
  const definition = await getUsableDefinition(ctx, recipeField.fieldDefinitionId, version.organizationId);
  const required = args.required ?? recipeField.required;
  const visible = args.visible ?? recipeField.visible;
  assertRequiredImpliesVisible(required, visible);
  const config = args.config ?? recipeField.config;
  assertSnapshotCoherentWithDefinition(config, definition.config);
  // The stored default is re-validated against the merged config, not only a
  // newly supplied one: narrowing the snapshot can invalidate a default that
  // was legal under the previous bounds.
  const defaultValue = args.defaultValue === undefined ? recipeField.defaultValue : args.defaultValue;
  if (defaultValue !== undefined && defaultValue !== null) await validateRecipeFieldDefaultValue(ctx, defaultValue, config, version.organizationId);
  const changedFields: string[] = [];
  const patch: { required?: boolean; visible?: boolean; config?: FieldConfig; defaultValue?: EventFieldValue | undefined; defaultLocationId?: Id<'locations'> | undefined } = {};
  if (required !== recipeField.required) { patch.required = required; changedFields.push('required'); }
  if (visible !== recipeField.visible) { patch.visible = visible; changedFields.push('visible'); }
  if (!sameFieldConfig(config, recipeField.config)) { patch.config = config; changedFields.push('config'); }
  // The mirror moves with the default in the same patch, including when the
  // default is cleared or changed to a non-location value: `undefined` removes
  // the column, so a stale mirror can never outlive the value it mirrors.
  if (!sameFieldValue(defaultValue, recipeField.defaultValue)) {
    patch.defaultValue = defaultValue ?? undefined;
    patch.defaultLocationId = locationIdFromValue(defaultValue);
    changedFields.push('defaultValue');
  }
  if (changedFields.length === 0) return;
  await ctx.db.patch(recipeField._id, patch);
  await recordAuditEvent(ctx, { organizationId: version.organizationId, actorUserId: access.user._id, action: 'recipeField.updated', entityType: 'recipeField', entityId: recipeField._id, metadata: { changedFields: changedFields.join(',') } });
}

export async function reorderRecipeFields(ctx: MutationCtx, recipeVersionId: Id<'recipeVersions'>, orderedRecipeFieldIds: Id<'recipeFields'>[]): Promise<void> {
  const { version, access } = await requireDraftVersionForEdit(ctx, recipeVersionId, 'planner');
  const fields = await getVersionFields(ctx, version._id);
  if (fields.length !== orderedRecipeFieldIds.length) return invalidInput('Recipe field order must contain exactly this version’s fields');
  const actual = new Set(fields.map((field) => field._id));
  const proposed = new Set(orderedRecipeFieldIds);
  if (proposed.size !== orderedRecipeFieldIds.length || proposed.size !== actual.size || orderedRecipeFieldIds.some((id) => !actual.has(id))) {
    return invalidInput('Recipe field order must contain exactly this version’s fields');
  }
  for (const [position, id] of orderedRecipeFieldIds.entries()) {
    const field = fields.find((candidate) => candidate._id === id);
    if (field !== undefined && field.position !== position) await ctx.db.patch(id, { position });
  }
  await recordAuditEvent(ctx, { organizationId: version.organizationId, actorUserId: access.user._id, action: 'recipeVersion.fieldsReordered', entityType: 'recipeVersion', entityId: version._id, metadata: { fieldCount: fields.length } });
}

export async function removeRecipeField(ctx: MutationCtx, recipeFieldId: Id<'recipeFields'>): Promise<void> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const recipeField = await ctx.db.get(recipeFieldId);
  if (recipeField === null) return notFoundOrInaccessible();
  const { version, access } = await requireDraftVersionForEdit(ctx, recipeField.recipeVersionId, 'planner', authenticated);
  if (recipeField.organizationId !== version.organizationId) return notFoundOrInaccessible();
  // A hard delete is safe here, and only here, because the gate above proved the
  // owning version is still a draft. Events reference a published version and
  // are validated against that version's rows (I3); a version never returns to
  // draft once published, so no draft row can be the rule set behind an existing
  // Event. Deleting one destroys unreferenced configuration, not history — which
  // is why the deletion policy's archive-instead rule does not apply.
  await ctx.db.delete(recipeField._id);
  await recordAuditEvent(ctx, { organizationId: version.organizationId, actorUserId: access.user._id, action: 'recipeField.removed', entityType: 'recipeField', entityId: recipeField._id, metadata: { fieldDefinitionId: recipeField.fieldDefinitionId } });
}

export async function listRecipeFields(ctx: QueryCtx, recipeVersionId: Id<'recipeVersions'>): Promise<Doc<'recipeFields'>[]> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const version = await ctx.db.get(recipeVersionId);
  if (version === null) return notFoundOrInaccessible();
  // The same cross-check `getRecipeVersion` performs: authorization follows the
  // stored recipe graph rather than trusting the version's own organizationId,
  // so the two ways of reading a version's fields cannot disagree (I4).
  const recipe = await ctx.db.get(version.recipeId);
  if (recipe === null || recipe.organizationId !== version.organizationId) return notFoundOrInaccessible();
  await requireOrganizationMembership(ctx, recipe.organizationId, authenticated);
  // A version's fields are a bounded configuration child set (I6).
  return getVersionFields(ctx, recipeVersionId);
}

/** Composition takes a caller-supplied definition id, so an unusable one is opaque (I9). */
async function getUsableDefinition(ctx: MutationCtx, fieldDefinitionId: Id<'fieldDefinitions'>, organizationId: Id<'organizations'>): Promise<Doc<'fieldDefinitions'>> {
  const definition = await ctx.db.get(fieldDefinitionId);
  if (!isUsableDefinition(definition, organizationId)) return notFoundOrInaccessible();
  return definition;
}

/**
 * Appends after the highest occupied position. The index does not order by
 * position, so the true maximum is taken from the whole sibling set rather than
 * from creation order — appending after a removal must not reuse a live slot.
 */
function nextPosition(siblings: Doc<'recipeFields'>[]): number {
  return siblings.reduce((maximum, field) => Math.max(maximum, field.position), -1) + 1;
}

function availablePosition(siblings: Doc<'recipeFields'>[], position: number): number {
  if (!Number.isInteger(position) || position < 0) return invalidInput('Recipe field position must be a non-negative integer');
  if (siblings.some((field) => field.position === position)) return conflict();
  return position;
}

/**
 * Structural equality over the value union, mirroring `sameFieldConfig`.
 * `JSON.stringify` was key-order sensitive, so an identical default whose
 * properties happened to arrive in a different order read as a change — a
 * spurious patch and audit row on what is really a no-op update.
 *
 * `null` and `undefined` both mean "no default": clearing an absent default is
 * a no-op, matching the mutation's documented `defaultValue: null` semantics.
 */
function sameFieldValue(left: EventFieldValue | undefined | null, right: EventFieldValue | undefined): boolean {
  if (left === null || left === undefined) return right === undefined;
  if (right === undefined) return false;
  switch (left.kind) {
    case 'text':
      return right.kind === 'text' && left.value === right.value;
    case 'longText':
      return right.kind === 'longText' && left.value === right.value;
    case 'number':
      return right.kind === 'number' && left.value === right.value;
    case 'boolean':
      return right.kind === 'boolean' && left.value === right.value;
    case 'date':
      return right.kind === 'date' && left.value === right.value;
    case 'datetime':
      return right.kind === 'datetime' && left.value === right.value;
    case 'time':
      return right.kind === 'time' && left.value === right.value;
    case 'select':
      return right.kind === 'select' && left.optionId === right.optionId;
    case 'multiSelect':
      // Compared positionally: the stored array is written back verbatim, so a
      // reordered selection is a real change to the stored default.
      return right.kind === 'multiSelect' && left.optionIds.length === right.optionIds.length && left.optionIds.every((optionId, index) => optionId === right.optionIds[index]);
    case 'location':
      return right.kind === 'location' && left.locationId === right.locationId;
  }
}
