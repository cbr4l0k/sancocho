import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { recordAuditEvent } from '../../audit/model';
import { sameFieldConfig } from '../../fields/model';
import { locationIdFromValue, sameFieldValue } from '../../fields/values';
import { requireAuthenticatedUser, requireOrganizationMembership, requireOrganizationRole, type AuthenticatedUser, type OrganizationMembershipAccess } from '../../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../../lib/errors';
import type { Role } from '../../lib/roles';
import type { serviceFieldValueValidator, fieldConfigValidator } from '../../validators';
import {
  assertRequiredImpliesVisible,
  assertSnapshotCoherentWithDefinition,
  getVersionFields,
  isUsableDefinition,
  maxFieldsPerVersion,
  validateServiceKindFieldDefaultValue,
} from '../model';

type FieldConfig = typeof fieldConfigValidator.type;
type ServiceFieldValue = typeof serviceFieldValueValidator.type;

type AddServiceKindFieldArgs = {
  serviceKindVersionId: Id<'serviceKindVersions'>;
  fieldDefinitionId: Id<'fieldDefinitions'>;
  required: boolean;
  visible: boolean;
  position?: number;
  config?: FieldConfig;
  defaultValue?: ServiceFieldValue;
};
type UpdateServiceKindFieldArgs = {
  serviceKindFieldId: Id<'serviceKindFields'>;
  required?: boolean;
  visible?: boolean;
  config?: FieldConfig;
  /** `null` explicitly removes a previously stored default. */
  defaultValue?: ServiceFieldValue | null;
};

/**
 * Future conditional rules belong on `serviceKindFields` as another closed validator
 * union (for example `{ kind: 'if', fieldId, comparison, value, constraint }`)
 * beside this row's config snapshot. They must be evaluated by a dedicated,
 * typed validator at publish/service-write time; arbitrary expressions and a
 * rules engine are explicitly out of scope (I8).
 */

/**
 * The sole edit gate for serviceKind composition. Authentication deliberately comes
 * before the version lookup, then membership/role comes from the stored version
 * and serviceKind graph (I1/I4/I9). Every draft mutation below passes through here.
 *
 * `preResolvedUser` lets the two mutations that must `ctx.db.get` a serviceKindField
 * first — and therefore already proved identity → app user to keep that lookup
 * behind authentication — hand the same result in rather than resolving the
 * identity a second time. It is producible only by `requireAuthenticatedUser`,
 * so passing it skips no link of the chain.
 */
export async function requireDraftVersionForEdit(
  ctx: MutationCtx,
  serviceKindVersionId: Id<'serviceKindVersions'>,
  minimumRole: Role,
  preResolvedUser?: AuthenticatedUser,
): Promise<{ version: Doc<'serviceKindVersions'>; serviceKind: Doc<'serviceKinds'>; access: OrganizationMembershipAccess }> {
  const authenticated = preResolvedUser ?? (await requireAuthenticatedUser(ctx));
  const version = await ctx.db.get(serviceKindVersionId);
  if (version === null) return notFoundOrInaccessible();
  const serviceKind = await ctx.db.get(version.serviceKindId);
  if (serviceKind === null || serviceKind.organizationId !== version.organizationId) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, version.organizationId, minimumRole, authenticated);
  if (serviceKind.status === 'archived') return invalidInput('serviceKindArchived', 'Archived serviceKinds cannot be edited');
  if (version.status !== 'draft') return invalidInput('serviceKindVersionNotDraft', 'Published and retired versions are immutable');
  return { version, serviceKind, access };
}

export async function addServiceKindField(ctx: MutationCtx, args: AddServiceKindFieldArgs): Promise<Id<'serviceKindFields'>> {
  const { version, access } = await requireDraftVersionForEdit(ctx, args.serviceKindVersionId, 'planner');
  assertRequiredImpliesVisible(args.required, args.visible);
  const definition = await getUsableDefinition(ctx, args.fieldDefinitionId, version.organizationId);
  const duplicate = await ctx.db.query('serviceKindFields').withIndex('by_version_field', (q) => q.eq('serviceKindVersionId', version._id).eq('fieldDefinitionId', args.fieldDefinitionId)).unique();
  if (duplicate !== null) return conflict();
  const config = args.config ?? definition.config;
  assertSnapshotCoherentWithDefinition(config, definition.config);
  if (args.defaultValue !== undefined) await validateServiceKindFieldDefaultValue(ctx, args.defaultValue, config, version.organizationId);
  // One read of the sibling set answers both the size ceiling and the position,
  // and — being an indexed read in the same mutation as the insert — is exactly
  // the read-before-write that makes both race-safe under Convex OCC.
  const siblings = await getVersionFields(ctx, version._id);
  if (siblings.length >= maxFieldsPerVersion) return invalidInput('serviceKindFieldLimitExceeded', `A serviceKind version cannot hold more than ${maxFieldsPerVersion} fields`);
  const position = args.position === undefined ? nextPosition(siblings) : availablePosition(siblings, args.position);
  // The location mirror is derived from the default, never taken from args (I4).
  const defaultLocationId = locationIdFromValue(args.defaultValue);
  const serviceKindFieldId = await ctx.db.insert('serviceKindFields', {
    organizationId: version.organizationId,
    serviceKindVersionId: version._id,
    fieldDefinitionId: definition._id,
    position,
    required: args.required,
    visible: args.visible,
    ...(args.defaultValue === undefined ? {} : { defaultValue: args.defaultValue }),
    ...(defaultLocationId === undefined ? {} : { defaultLocationId }),
    config,
  });
  await recordAuditEvent(ctx, { organizationId: version.organizationId, actorUserId: access.user._id, action: 'serviceKindField.added', entityType: 'serviceKindField', entityId: serviceKindFieldId, metadata: { fieldDefinitionId: definition._id, position } });
  return serviceKindFieldId;
}

export async function updateServiceKindField(ctx: MutationCtx, args: UpdateServiceKindFieldArgs): Promise<void> {
  // Authenticate before a serviceKindField id is looked up, matching the #5 I9
  // ordering; the resolved identity is then reused by the edit gate.
  const authenticated = await requireAuthenticatedUser(ctx);
  const serviceKindField = await ctx.db.get(args.serviceKindFieldId);
  if (serviceKindField === null) return notFoundOrInaccessible();
  const { version, access } = await requireDraftVersionForEdit(ctx, serviceKindField.serviceKindVersionId, 'planner', authenticated);
  if (serviceKindField.organizationId !== version.organizationId) return notFoundOrInaccessible();
  const definition = await getUsableDefinition(ctx, serviceKindField.fieldDefinitionId, version.organizationId);
  const required = args.required ?? serviceKindField.required;
  const visible = args.visible ?? serviceKindField.visible;
  assertRequiredImpliesVisible(required, visible);
  const config = args.config ?? serviceKindField.config;
  assertSnapshotCoherentWithDefinition(config, definition.config);
  // The stored default is re-validated against the merged config, not only a
  // newly supplied one: narrowing the snapshot can invalidate a default that
  // was legal under the previous bounds.
  const defaultValue = args.defaultValue === undefined ? serviceKindField.defaultValue : args.defaultValue;
  if (defaultValue !== undefined && defaultValue !== null) await validateServiceKindFieldDefaultValue(ctx, defaultValue, config, version.organizationId);
  const changedFields: string[] = [];
  const patch: { required?: boolean; visible?: boolean; config?: FieldConfig; defaultValue?: ServiceFieldValue | undefined; defaultLocationId?: Id<'locations'> | undefined } = {};
  if (required !== serviceKindField.required) { patch.required = required; changedFields.push('required'); }
  if (visible !== serviceKindField.visible) { patch.visible = visible; changedFields.push('visible'); }
  if (!sameFieldConfig(config, serviceKindField.config)) { patch.config = config; changedFields.push('config'); }
  // The mirror moves with the default in the same patch, including when the
  // default is cleared or changed to a non-location value: `undefined` removes
  // the column, so a stale mirror can never outlive the value it mirrors.
  if (!sameFieldValue(defaultValue, serviceKindField.defaultValue)) {
    patch.defaultValue = defaultValue ?? undefined;
    patch.defaultLocationId = locationIdFromValue(defaultValue);
    changedFields.push('defaultValue');
  }
  if (changedFields.length === 0) return;
  await ctx.db.patch(serviceKindField._id, patch);
  await recordAuditEvent(ctx, { organizationId: version.organizationId, actorUserId: access.user._id, action: 'serviceKindField.updated', entityType: 'serviceKindField', entityId: serviceKindField._id, metadata: { changedFields: changedFields.join(',') } });
}

export async function reorderServiceKindFields(ctx: MutationCtx, serviceKindVersionId: Id<'serviceKindVersions'>, orderedServiceKindFieldIds: Id<'serviceKindFields'>[]): Promise<void> {
  const { version, access } = await requireDraftVersionForEdit(ctx, serviceKindVersionId, 'planner');
  const fields = await getVersionFields(ctx, version._id);
  if (fields.length !== orderedServiceKindFieldIds.length) return invalidInput('serviceKindFieldOrderInvalid', 'ServiceKind field order must contain exactly this version’s fields');
  const actual = new Set(fields.map((field) => field._id));
  const proposed = new Set(orderedServiceKindFieldIds);
  if (proposed.size !== orderedServiceKindFieldIds.length || proposed.size !== actual.size || orderedServiceKindFieldIds.some((id) => !actual.has(id))) {
    return invalidInput('serviceKindFieldOrderInvalid', 'ServiceKind field order must contain exactly this version’s fields');
  }
  for (const [position, id] of orderedServiceKindFieldIds.entries()) {
    const field = fields.find((candidate) => candidate._id === id);
    if (field !== undefined && field.position !== position) await ctx.db.patch(id, { position });
  }
  await recordAuditEvent(ctx, { organizationId: version.organizationId, actorUserId: access.user._id, action: 'serviceKindVersion.fieldsReordered', entityType: 'serviceKindVersion', entityId: version._id, metadata: { fieldCount: fields.length } });
}

export async function removeServiceKindField(ctx: MutationCtx, serviceKindFieldId: Id<'serviceKindFields'>): Promise<void> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const serviceKindField = await ctx.db.get(serviceKindFieldId);
  if (serviceKindField === null) return notFoundOrInaccessible();
  const { version, access } = await requireDraftVersionForEdit(ctx, serviceKindField.serviceKindVersionId, 'planner', authenticated);
  if (serviceKindField.organizationId !== version.organizationId) return notFoundOrInaccessible();
  // A hard delete is safe here, and only here, because the gate above proved the
  // owning version is still a draft. Services reference a published version and
  // are validated against that version's rows (I3); a version never returns to
  // draft once published, so no draft row can be the rule set behind an existing
  // Service. Deleting one destroys unreferenced configuration, not history — which
  // is why the deletion policy's archive-instead rule does not apply.
  await ctx.db.delete(serviceKindField._id);
  await recordAuditEvent(ctx, { organizationId: version.organizationId, actorUserId: access.user._id, action: 'serviceKindField.removed', entityType: 'serviceKindField', entityId: serviceKindField._id, metadata: { fieldDefinitionId: serviceKindField.fieldDefinitionId } });
}

export async function listServiceKindFields(ctx: QueryCtx, serviceKindVersionId: Id<'serviceKindVersions'>): Promise<Doc<'serviceKindFields'>[]> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const version = await ctx.db.get(serviceKindVersionId);
  if (version === null) return notFoundOrInaccessible();
  // The same cross-check `getServiceKindVersion` performs: authorization follows the
  // stored serviceKind graph rather than trusting the version's own organizationId,
  // so the two ways of reading a version's fields cannot disagree (I4).
  const serviceKind = await ctx.db.get(version.serviceKindId);
  if (serviceKind === null || serviceKind.organizationId !== version.organizationId) return notFoundOrInaccessible();
  await requireOrganizationMembership(ctx, serviceKind.organizationId, authenticated);
  // A version's fields are a bounded configuration child set (I6).
  return getVersionFields(ctx, serviceKindVersionId);
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
function nextPosition(siblings: Doc<'serviceKindFields'>[]): number {
  return siblings.reduce((maximum, field) => Math.max(maximum, field.position), -1) + 1;
}

function availablePosition(siblings: Doc<'serviceKindFields'>[], position: number): number {
  if (!Number.isInteger(position) || position < 0) return invalidInput('serviceKindFieldPositionInvalid', 'ServiceKind field position must be a non-negative integer');
  if (siblings.some((field) => field.position === position)) return conflict();
  return position;
}
