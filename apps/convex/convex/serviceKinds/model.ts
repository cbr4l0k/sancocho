import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { assertValidFieldConfig } from '../fields/model';
import { locationIdFromValue, validateFieldValueAgainstConfig } from '../fields/values';
import { requireAuthenticatedUser, requireOrganizationAccess, requireOrganizationMembership, requireOrganizationRole, type OrganizationMembershipAccess } from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { validateEntityName } from '../lib/names';
import type { Role } from '../lib/roles';
import { assertUsableLocation } from '../locations/model';
import type { fieldConfigValidator, serviceFieldValueValidator } from '../validators';

type FieldConfig = typeof fieldConfigValidator.type;
type ServiceFieldValue = typeof serviceFieldValueValidator.type;
type ServiceKindPatch = { name?: string; description?: string };

const serviceKindKeyPattern = /^[a-z][a-zA-Z0-9]*$/;
const maxServiceKindDescriptionLength = 2000;

/**
 * The composition ceiling for one version. A version's `serviceKindFields` are read
 * as a whole child set (publish validation, reordering, cloning, listing), and
 * I6 permits that only because the set is bounded — so the bound is enforced
 * rather than assumed. 200 is an order of magnitude beyond any realistic
 * operational form while keeping every such read one small transaction.
 */
export const maxFieldsPerVersion = 200;

/**
 * The one-draft probe and highest-version probe are indexed reads in the same
 * mutation as their insert. Under Convex serializable OCC, concurrent writers
 * that observe the same index range conflict and retry; the retry sees the
 * winning row and fails the invariant check. This is the §10 architecture
 * review read-before-write strategy, and makes both rules race-safe.
 */
export async function createServiceKind(ctx: MutationCtx, args: { organizationId: Id<'organizations'>; key: string; name: string; description?: string }): Promise<Id<'serviceKinds'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, 'planner');
  validateServiceKindKey(args.key);
  // The validator returns the trimmed name, and the trimmed name is what is stored.
  const name = validateEntityName(args.name, 'serviceKind');
  validateDescription(args.description);
  const existing = await ctx.db.query('serviceKinds').withIndex('by_org_key', (q) => q.eq('organizationId', args.organizationId).eq('key', args.key)).unique();
  if (existing !== null) return conflict();
  const serviceKindId = await ctx.db.insert('serviceKinds', {
    organizationId: args.organizationId, key: args.key, name,
    ...(args.description === undefined ? {} : { description: args.description }), status: 'draft',
  });
  await recordAuditEvent(ctx, { organizationId: args.organizationId, actorUserId: access.user._id, action: 'serviceKind.created', entityType: 'serviceKind', entityId: serviceKindId, metadata: { key: args.key } });
  return serviceKindId;
}

export async function updateServiceKindMetadata(ctx: MutationCtx, serviceKindId: Id<'serviceKinds'>, patch: ServiceKindPatch): Promise<void> {
  const { serviceKind, access } = await requireServiceKindAccess(ctx, serviceKindId, 'planner');
  // Archived serviceKinds are read-only, mirroring archived field definitions.
  if (serviceKind.status === 'archived') return invalidInput('serviceKindArchived', 'Archived serviceKinds cannot be updated');
  const update: ServiceKindPatch = {};
  const changedFields: string[] = [];
  // Validated (and therefore trimmed) before the diff, so an echoed name that
  // differs only in surrounding whitespace is correctly read as no change.
  const name = patch.name === undefined ? undefined : validateEntityName(patch.name, 'serviceKind');
  if (name !== undefined && name !== serviceKind.name) { update.name = name; changedFields.push('name'); }
  if (patch.description !== undefined && patch.description !== serviceKind.description) { validateDescription(patch.description); update.description = patch.description; changedFields.push('description'); }
  if (changedFields.length === 0) return;
  await ctx.db.patch(serviceKindId, update);
  await recordAuditEvent(ctx, { organizationId: serviceKind.organizationId, actorUserId: access.user._id, action: 'serviceKind.updated', entityType: 'serviceKind', entityId: serviceKindId, metadata: { changedFields: changedFields.join(',') } });
}

export async function archiveServiceKind(ctx: MutationCtx, serviceKindId: Id<'serviceKinds'>): Promise<void> {
  const { serviceKind, access } = await requireServiceKindAccess(ctx, serviceKindId, 'planner');
  if (serviceKind.status === 'archived') return;
  // An archived serviceKind must stop being a source of new Services, so its published
  // version is retired in the same transaction. Retirement keeps the version and
  // its snapshot readable, so Services created from it stay interpretable (I3).
  // Draft versions stay drafts: publishing one is already refused for an
  // archived serviceKind, so they are inert rather than dangerous.
  await retireCurrentPublishedVersion(ctx, serviceKind, access);
  await ctx.db.patch(serviceKindId, { status: 'archived' });
  await recordAuditEvent(ctx, { organizationId: serviceKind.organizationId, actorUserId: access.user._id, action: 'serviceKind.archived', entityType: 'serviceKind', entityId: serviceKindId, metadata: { previousStatus: serviceKind.status } });
}

export async function createInitialDraftVersion(ctx: MutationCtx, serviceKindId: Id<'serviceKinds'>): Promise<Id<'serviceKindVersions'>> {
  const { serviceKind, access } = await requireServiceKindAccess(ctx, serviceKindId, 'planner');
  return createDraftVersion(ctx, serviceKind, access);
}

export async function clonePublishedVersionToDraft(ctx: MutationCtx, serviceKindId: Id<'serviceKinds'>): Promise<Id<'serviceKindVersions'>> {
  const { serviceKind, access } = await requireServiceKindAccess(ctx, serviceKindId, 'planner');
  if (serviceKind.status === 'archived') return invalidInput('serviceKindArchived', 'Archived serviceKinds cannot get new drafts');
  const published = await ctx.db.query('serviceKindVersions').withIndex('by_serviceKind_status', (q) => q.eq('serviceKindId', serviceKindId).eq('status', 'published')).unique();
  if (published === null) return invalidInput('serviceKindPublishedVersionRequired', 'A published serviceKind version is required to clone');
  const versionId = await createDraftVersion(ctx, serviceKind, access, published.versionNumber);
  const sourceFields = await getVersionFields(ctx, published._id);
  // Rows are copied verbatim from a version that already passed
  // `validateDraftFields`, so each one is coherent with its definition by
  // construction — cloning re-derives nothing and needs no re-check. Should a
  // definition narrow after the clone, publishing the new draft runs the same
  // `assertSnapshotCoherentWithDefinition` again against the definitions as
  // they stand then, which is the moment that actually matters (I2/I3).
  for (const source of sourceFields) {
    // The location mirror is re-derived from the copied default rather than
    // copied from the source row, so the clone cannot inherit a stale mirror.
    const defaultLocationId = locationIdFromValue(source.defaultValue);
    await ctx.db.insert('serviceKindFields', {
      organizationId: serviceKind.organizationId, serviceKindVersionId: versionId, fieldDefinitionId: source.fieldDefinitionId,
      position: source.position, required: source.required, visible: source.visible,
      ...(source.defaultValue === undefined ? {} : { defaultValue: source.defaultValue }),
      ...(defaultLocationId === undefined ? {} : { defaultLocationId }), config: source.config,
    });
  }
  return versionId;
}

export async function publishServiceKindVersion(ctx: MutationCtx, serviceKindVersionId: Id<'serviceKindVersions'>): Promise<void> {
  const { version, serviceKind, access } = await requireVersionAccess(ctx, serviceKindVersionId, 'planner');
  if (version.status !== 'draft') return invalidInput('serviceKindVersionNotDraft', 'Only draft serviceKind versions can be published');
  if (serviceKind.status === 'archived') return invalidInput('serviceKindArchived', 'Archived serviceKinds cannot be published');
  await validateDraftFields(ctx, version);
  await retireCurrentPublishedVersion(ctx, serviceKind, access);
  await ctx.db.patch(serviceKindVersionId, { status: 'published', publishedAt: Date.now() });
  if (serviceKind.status === 'draft') {
    await ctx.db.patch(serviceKind._id, { status: 'active' });
  }
  await recordAuditEvent(ctx, { organizationId: serviceKind.organizationId, actorUserId: access.user._id, action: 'serviceKindVersion.published', entityType: 'serviceKindVersion', entityId: serviceKindVersionId, metadata: { versionNumber: version.versionNumber } });
}

export async function getServiceKind(ctx: QueryCtx, serviceKindId: Id<'serviceKinds'>): Promise<{ serviceKind: Doc<'serviceKinds'>; versions: Doc<'serviceKindVersions'>[] }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const serviceKind = await ctx.db.get(serviceKindId);
  if (serviceKind === null) return notFoundOrInaccessible();
  await requireOrganizationMembership(ctx, serviceKind.organizationId, authenticated);
  // A serviceKind's versions are a bounded configuration history, so collecting this child set is permitted (I6).
  const versions = await ctx.db.query('serviceKindVersions').withIndex('by_serviceKind_version', (q) => q.eq('serviceKindId', serviceKindId)).collect();
  return { serviceKind, versions };
}

export async function listServiceKinds(ctx: QueryCtx, organizationId: Id<'organizations'>, paginationOpts: PaginationOptions): Promise<PaginationResult<Doc<'serviceKinds'>>> {
  await requireOrganizationMembership(ctx, organizationId);
  return ctx.db.query('serviceKinds').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).paginate(paginationOpts);
}

/**
 * The web serviceKind picker previously issued `getServiceKind` once per listed serviceKind,
 * creating an N+1 fan-out. Starting at published versions makes the picker a
 * single indexed, paginated read while preserving the version it must create an
 * Service against.
 */
export async function listPublishedServiceKinds(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<{ serviceKind: Doc<'serviceKinds'>; publishedVersion: Pick<Doc<'serviceKindVersions'>, '_id' | 'versionNumber' | 'publishedAt'> }>> {
  await requireOrganizationAccess(ctx, organizationId);
  const published = await ctx.db
    .query('serviceKindVersions')
    .withIndex('by_org_status', (q) => q.eq('organizationId', organizationId).eq('status', 'published'))
    .paginate(paginationOpts);
  const page = await Promise.all(published.page.map(async (publishedVersion) => {
    const serviceKind = await ctx.db.get(publishedVersion.serviceKindId);
    // Normal lifecycle transitions retire a published version before archival.
    // Treat a corrupt graph as inaccessible rather than leaking or returning a
    // serviceKind the picker cannot legitimately use (I1/I9).
    if (serviceKind === null || serviceKind.organizationId !== organizationId || serviceKind.status === 'archived') return notFoundOrInaccessible();
    return {
      serviceKind,
      publishedVersion: {
        _id: publishedVersion._id,
        versionNumber: publishedVersion.versionNumber,
        ...(publishedVersion.publishedAt === undefined ? {} : { publishedAt: publishedVersion.publishedAt }),
      },
    };
  }));
  return { ...published, page };
}

export async function getServiceKindVersion(ctx: QueryCtx, serviceKindVersionId: Id<'serviceKindVersions'>): Promise<{ version: Doc<'serviceKindVersions'>; serviceKindFields: Doc<'serviceKindFields'>[] }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const version = await ctx.db.get(serviceKindVersionId);
  if (version === null) return notFoundOrInaccessible();
  const serviceKind = await ctx.db.get(version.serviceKindId);
  if (serviceKind === null || serviceKind.organizationId !== version.organizationId) return notFoundOrInaccessible();
  await requireOrganizationMembership(ctx, serviceKind.organizationId, authenticated);
  return { version, serviceKindFields: await getVersionFields(ctx, serviceKindVersionId) };
}

async function createDraftVersion(ctx: MutationCtx, serviceKind: Doc<'serviceKinds'>, access: OrganizationMembershipAccess, clonedFromVersion?: number): Promise<Id<'serviceKindVersions'>> {
  if (serviceKind.status === 'archived') return invalidInput('serviceKindArchived', 'Archived serviceKinds cannot get new drafts');
  const draft = await ctx.db.query('serviceKindVersions').withIndex('by_serviceKind_status', (q) => q.eq('serviceKindId', serviceKind._id).eq('status', 'draft')).unique();
  if (draft !== null) return conflict();
  const latest = await ctx.db.query('serviceKindVersions').withIndex('by_serviceKind_version', (q) => q.eq('serviceKindId', serviceKind._id)).order('desc').first();
  const versionNumber = (latest?.versionNumber ?? 0) + 1;
  const versionId = await ctx.db.insert('serviceKindVersions', { organizationId: serviceKind.organizationId, serviceKindId: serviceKind._id, versionNumber, status: 'draft' });
  // The new version number is always recorded; a clone additionally names its source.
  await recordAuditEvent(ctx, { organizationId: serviceKind.organizationId, actorUserId: access.user._id, action: 'serviceKindVersion.created', entityType: 'serviceKindVersion', entityId: versionId, metadata: clonedFromVersion === undefined ? { versionNumber } : { versionNumber, clonedFromVersion } });
  return versionId;
}

/**
 * Retires the serviceKind's current published version, if it has one. Shared by
 * publishing (a serviceKind has at most one published version) and archival, so both
 * lifecycle transitions leave exactly the same trace: a `retired` status and a
 * `serviceKindVersion.retired` audit row naming the version number.
 */
async function retireCurrentPublishedVersion(ctx: MutationCtx, serviceKind: Doc<'serviceKinds'>, access: OrganizationMembershipAccess): Promise<void> {
  const published = await ctx.db.query('serviceKindVersions').withIndex('by_serviceKind_status', (q) => q.eq('serviceKindId', serviceKind._id).eq('status', 'published')).unique();
  if (published === null) return;
  await ctx.db.patch(published._id, { status: 'retired' });
  await recordAuditEvent(ctx, { organizationId: serviceKind.organizationId, actorUserId: access.user._id, action: 'serviceKindVersion.retired', entityType: 'serviceKindVersion', entityId: published._id, metadata: { versionNumber: published.versionNumber } });
}

async function requireServiceKindAccess(ctx: MutationCtx, serviceKindId: Id<'serviceKinds'>, minimumRole: Role): Promise<{ serviceKind: Doc<'serviceKinds'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const serviceKind = await ctx.db.get(serviceKindId);
  if (serviceKind === null) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, serviceKind.organizationId, minimumRole, authenticated);
  return { serviceKind, access };
}

async function requireVersionAccess(ctx: MutationCtx, serviceKindVersionId: Id<'serviceKindVersions'>, minimumRole: Role): Promise<{ version: Doc<'serviceKindVersions'>; serviceKind: Doc<'serviceKinds'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const version = await ctx.db.get(serviceKindVersionId);
  if (version === null) return notFoundOrInaccessible();
  const serviceKind = await ctx.db.get(version.serviceKindId);
  if (serviceKind === null || serviceKind.organizationId !== version.organizationId) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, serviceKind.organizationId, minimumRole, authenticated);
  return { version, serviceKind, access };
}

/**
 * A version's serviceKind fields in presentation order. The index does not order by
 * position, so the sort is what makes the order meaningful. Collecting this
 * child set is permitted because it is bounded by `maxFieldsPerVersion` (I6).
 */
export async function getVersionFields(ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>, serviceKindVersionId: Id<'serviceKindVersions'>): Promise<Doc<'serviceKindFields'>[]> {
  const fields = await ctx.db.query('serviceKindFields').withIndex('by_version', (q) => q.eq('serviceKindVersionId', serviceKindVersionId)).collect();
  return fields.sort((left, right) => left.position - right.position);
}

/**
 * The single statement of "may this definition back a serviceKind field for this
 * organization?": it must still be active, and either built-in or owned by the
 * organization composing it. Only the predicate is shared — the caller picks
 * the error, because the two callers answer different questions. Composition
 * mutations take a caller-supplied id and must report the generic not-found so
 * a probe learns nothing about another tenant (I1/I9); publishing inspects rows
 * the organization already stored, so it reports specific invalid input.
 */
export function isUsableDefinition(definition: Doc<'fieldDefinitions'> | null, organizationId: Id<'organizations'>): definition is Doc<'fieldDefinitions'> {
  return definition !== null && definition.status !== 'archived' && (definition.scope !== 'organization' || definition.organizationId === organizationId);
}

/**
 * A required field nobody can see is unfillable, so the rule is stated once for
 * the two moments it can be violated: composing a draft row, and freezing the
 * whole set at publish.
 */
export function assertRequiredImpliesVisible(required: boolean, visible: boolean): void {
  if (required && !visible) return invalidInput('serviceKindFieldRequiredHidden', 'Required serviceKind fields must be visible');
}

/**
 * The one statement of "may this snapshot stand for this definition?", used by
 * every write that produces or freezes a snapshot: add, update, and publish.
 *
 * It was previously stated twice, and the two copies had already drifted —
 * composition enforced narrowing-only bounds while publishing did not, so a
 * snapshot widened by a later definition edit could still be made immutable.
 * With one rule the guarantee is identical wherever a snapshot is written.
 *
 * A snapshot may narrow its definition (tighter bounds, integer-only, a subset
 * of options) because that is the whole point of a per-serviceKind snapshot. It may
 * never widen it, and never carry options the definition no longer offers: a
 * stale snapshot fails honestly instead of shipping rules its definition
 * disowns, or dead options no operator can act on.
 */
export function assertSnapshotCoherentWithDefinition(snapshot: FieldConfig, definition: FieldConfig): void {
  if (snapshot.kind !== definition.kind) return invalidInput('serviceKindFieldConfigMismatch', 'ServiceKind field config kind must match the current field definition');
  // The same contents rules the definition itself had to satisfy, re-checked on
  // the narrowed snapshot: an incoherent copy would become permanent at publish.
  assertValidFieldConfig(snapshot);
  switch (snapshot.kind) {
    case 'text': case 'longText':
      if (definition.kind !== snapshot.kind || (definition.minLength !== undefined && (snapshot.minLength === undefined || snapshot.minLength < definition.minLength)) || (definition.maxLength !== undefined && (snapshot.maxLength === undefined || snapshot.maxLength > definition.maxLength))) return narrowingOnly();
      return;
    case 'number':
      if (definition.kind !== 'number' || (definition.min !== undefined && (snapshot.min === undefined || snapshot.min < definition.min)) || (definition.max !== undefined && (snapshot.max === undefined || snapshot.max > definition.max)) || (definition.integer === true && snapshot.integer !== true)) return narrowingOnly();
      return;
    case 'datetime': case 'date': case 'time':
      if (definition.kind !== snapshot.kind || (definition.min !== undefined && (snapshot.min === undefined || snapshot.min < definition.min)) || (definition.max !== undefined && (snapshot.max === undefined || snapshot.max > definition.max))) return narrowingOnly();
      return;
    case 'select': case 'multiSelect': {
      // Kinds were already proven equal above; this narrows for the compiler.
      if (definition.kind !== 'select' && definition.kind !== 'multiSelect') return invalidInput('serviceKindFieldConfigMismatch', 'ServiceKind field config kind must match the current field definition');
      const available = new Set(definition.options.map((option) => option.id));
      if (snapshot.options.some((option) => !available.has(option.id))) return invalidInput('serviceKindFieldSnapshotOptionInvalid', 'ServiceKind field snapshot options must still exist in the current field definition');
      if (snapshot.kind === 'multiSelect' && definition.kind === 'multiSelect' && ((definition.minSelections !== undefined && (snapshot.minSelections === undefined || snapshot.minSelections < definition.minSelections)) || (definition.maxSelections !== undefined && (snapshot.maxSelections === undefined || snapshot.maxSelections > definition.maxSelections)))) return narrowingOnly();
      return;
    }
    case 'boolean': case 'location': return;
  }
}

function narrowingOnly(): never {
  return invalidInput('serviceKindFieldConfigNotNarrower', 'ServiceKind field config may only narrow definition bounds');
}

/**
 * Publishing is the last moment a version's rules can be questioned: afterwards
 * the snapshot is immutable (I2) and is the only thing historical Services are
 * validated against (I3). So every row is checked for internal coherence *and*
 * for coherence with the field definition it snapshotted (see the composition
 * contract on `serviceKindFields.config` in schema.ts).
 */
async function validateDraftFields(ctx: MutationCtx, version: Doc<'serviceKindVersions'>): Promise<void> {
  const serviceKindFields = await getVersionFields(ctx, version._id);
  // A version with no fields would produce Services that carry no serviceKind data at
  // all, which is a composition mistake rather than a usable configuration.
  if (serviceKindFields.length === 0) return invalidInput('serviceKindVersionEmpty', 'Cannot publish a version with no fields');
  const definitions = new Set<string>();
  const positions = new Set<number>();
  for (const serviceKindField of serviceKindFields) {
    // Positions are the stable presentation order, so they must be orderable and
    // unambiguous. Density (0..n-1) is the reorder operation's business (#9).
    if (!Number.isInteger(serviceKindField.position) || serviceKindField.position < 0 || positions.has(serviceKindField.position)) {
      return invalidInput('serviceKindFieldPositionInvalid', 'ServiceKind field positions must be unique non-negative integers');
    }
    positions.add(serviceKindField.position);
    if (definitions.has(serviceKindField.fieldDefinitionId)) return invalidInput('serviceKindFieldDuplicateDefinition', 'ServiceKind version cannot contain duplicate field definitions');
    definitions.add(serviceKindField.fieldDefinitionId);
    const definition = await ctx.db.get(serviceKindField.fieldDefinitionId);
    if (!isUsableDefinition(definition, version.organizationId)) return invalidInput('serviceKindFieldDefinitionUnavailable', 'ServiceKind fields must reference active fields in the same organization or built-ins');
    // The same coherence rule composition applied when the row was written, run
    // again against the definition as it stands now: a definition edited since
    // then can leave a stored snapshot stale, and this is the last moment it can
    // be refused.
    assertSnapshotCoherentWithDefinition(serviceKindField.config, definition.config);
    assertRequiredImpliesVisible(serviceKindField.required, serviceKindField.visible);
    if (serviceKindField.defaultValue !== undefined) await validateServiceKindFieldDefaultValue(ctx, serviceKindField.defaultValue, serviceKindField.config, version.organizationId);
  }
}

/**
 * A default is a value like any other, so it is held to the snapshot's own rules
 * through the shared gate (#10 reuses it for stored Service values). The location
 * branch is the part the pure helper cannot do: the referenced location is
 * resolved here and must belong to this version's organization and still be
 * active. A foreign location fails with the generic error, so a caller cannot
 * use publishing to probe another tenant's ids (I1/I9).
 */
export async function validateServiceKindFieldDefaultValue(ctx: MutationCtx, value: ServiceFieldValue, config: FieldConfig, organizationId: Id<'organizations'>): Promise<void> {
  validateFieldValueAgainstConfig(config, value);
  if (value.kind !== 'location') return;
  // Same reference rule the service value gate applies, stated once in locations/model.ts.
  await assertUsableLocation(ctx, value.locationId, organizationId);
}

function validateServiceKindKey(key: string): void {
  if (!serviceKindKeyPattern.test(key) || key.length < 2 || key.length > 64) return invalidInput('serviceKindKeyInvalid', 'ServiceKind key must be 2–64 lowerCamelCase characters');
}

function validateDescription(description: string | undefined): void {
  if (description !== undefined && description.length > maxServiceKindDescriptionLength) return invalidInput('serviceKindDescriptionTooLong', `ServiceKind description must not exceed ${maxServiceKindDescriptionLength} characters`);
}
