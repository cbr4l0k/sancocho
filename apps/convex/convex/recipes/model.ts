import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { assertValidFieldConfig } from '../fields/model';
import { locationIdFromValue, validateFieldValueAgainstConfig } from '../fields/values';
import { requireAuthenticatedUser, requireOrganizationMembership, requireOrganizationRole, type OrganizationMembershipAccess } from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { validateEntityName } from '../lib/names';
import type { Role } from '../lib/roles';
import { assertUsableLocation } from '../locations/model';
import type { fieldConfigValidator, eventFieldValueValidator } from '../validators';

type FieldConfig = typeof fieldConfigValidator.type;
type EventFieldValue = typeof eventFieldValueValidator.type;
type RecipePatch = { name?: string; description?: string };

const recipeKeyPattern = /^[a-z][a-zA-Z0-9]*$/;
const maxRecipeDescriptionLength = 2000;

/**
 * The composition ceiling for one version. A version's `recipeFields` are read
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
export async function createRecipe(ctx: MutationCtx, args: { organizationId: Id<'organizations'>; key: string; name: string; description?: string }): Promise<Id<'eventRecipes'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, 'planner');
  validateRecipeKey(args.key);
  // The validator returns the trimmed name, and the trimmed name is what is stored.
  const name = validateEntityName(args.name, 'recipe');
  validateDescription(args.description);
  const existing = await ctx.db.query('eventRecipes').withIndex('by_org_key', (q) => q.eq('organizationId', args.organizationId).eq('key', args.key)).unique();
  if (existing !== null) return conflict();
  const recipeId = await ctx.db.insert('eventRecipes', {
    organizationId: args.organizationId, key: args.key, name,
    ...(args.description === undefined ? {} : { description: args.description }), status: 'draft',
  });
  await recordAuditEvent(ctx, { organizationId: args.organizationId, actorUserId: access.user._id, action: 'recipe.created', entityType: 'eventRecipe', entityId: recipeId, metadata: { key: args.key } });
  return recipeId;
}

export async function updateRecipeMetadata(ctx: MutationCtx, recipeId: Id<'eventRecipes'>, patch: RecipePatch): Promise<void> {
  const { recipe, access } = await requireRecipeAccess(ctx, recipeId, 'planner');
  // Archived recipes are read-only, mirroring archived field definitions.
  if (recipe.status === 'archived') return invalidInput('Archived recipes cannot be updated');
  const update: RecipePatch = {};
  const changedFields: string[] = [];
  // Validated (and therefore trimmed) before the diff, so an echoed name that
  // differs only in surrounding whitespace is correctly read as no change.
  const name = patch.name === undefined ? undefined : validateEntityName(patch.name, 'recipe');
  if (name !== undefined && name !== recipe.name) { update.name = name; changedFields.push('name'); }
  if (patch.description !== undefined && patch.description !== recipe.description) { validateDescription(patch.description); update.description = patch.description; changedFields.push('description'); }
  if (changedFields.length === 0) return;
  await ctx.db.patch(recipeId, update);
  await recordAuditEvent(ctx, { organizationId: recipe.organizationId, actorUserId: access.user._id, action: 'recipe.updated', entityType: 'eventRecipe', entityId: recipeId, metadata: { changedFields: changedFields.join(',') } });
}

export async function archiveRecipe(ctx: MutationCtx, recipeId: Id<'eventRecipes'>): Promise<void> {
  const { recipe, access } = await requireRecipeAccess(ctx, recipeId, 'planner');
  if (recipe.status === 'archived') return;
  // An archived recipe must stop being a source of new Events, so its published
  // version is retired in the same transaction. Retirement keeps the version and
  // its snapshot readable, so Events created from it stay interpretable (I3).
  // Draft versions stay drafts: publishing one is already refused for an
  // archived recipe, so they are inert rather than dangerous.
  await retireCurrentPublishedVersion(ctx, recipe, access);
  await ctx.db.patch(recipeId, { status: 'archived' });
  await recordAuditEvent(ctx, { organizationId: recipe.organizationId, actorUserId: access.user._id, action: 'recipe.archived', entityType: 'eventRecipe', entityId: recipeId, metadata: { previousStatus: recipe.status } });
}

export async function createInitialDraftVersion(ctx: MutationCtx, recipeId: Id<'eventRecipes'>): Promise<Id<'recipeVersions'>> {
  const { recipe, access } = await requireRecipeAccess(ctx, recipeId, 'planner');
  return createDraftVersion(ctx, recipe, access);
}

export async function clonePublishedVersionToDraft(ctx: MutationCtx, recipeId: Id<'eventRecipes'>): Promise<Id<'recipeVersions'>> {
  const { recipe, access } = await requireRecipeAccess(ctx, recipeId, 'planner');
  if (recipe.status === 'archived') return invalidInput('Archived recipes cannot get new drafts');
  const published = await ctx.db.query('recipeVersions').withIndex('by_recipe_status', (q) => q.eq('recipeId', recipeId).eq('status', 'published')).unique();
  if (published === null) return invalidInput('A published recipe version is required to clone');
  const versionId = await createDraftVersion(ctx, recipe, access, published.versionNumber);
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
    await ctx.db.insert('recipeFields', {
      organizationId: recipe.organizationId, recipeVersionId: versionId, fieldDefinitionId: source.fieldDefinitionId,
      position: source.position, required: source.required, visible: source.visible,
      ...(source.defaultValue === undefined ? {} : { defaultValue: source.defaultValue }),
      ...(defaultLocationId === undefined ? {} : { defaultLocationId }), config: source.config,
    });
  }
  return versionId;
}

export async function publishRecipeVersion(ctx: MutationCtx, recipeVersionId: Id<'recipeVersions'>): Promise<void> {
  const { version, recipe, access } = await requireVersionAccess(ctx, recipeVersionId, 'planner');
  if (version.status !== 'draft') return invalidInput('Only draft recipe versions can be published');
  if (recipe.status === 'archived') return invalidInput('Archived recipes cannot be published');
  await validateDraftFields(ctx, version);
  await retireCurrentPublishedVersion(ctx, recipe, access);
  await ctx.db.patch(recipeVersionId, { status: 'published', publishedAt: Date.now() });
  if (recipe.status === 'draft') await ctx.db.patch(recipe._id, { status: 'active' });
  await recordAuditEvent(ctx, { organizationId: recipe.organizationId, actorUserId: access.user._id, action: 'recipeVersion.published', entityType: 'recipeVersion', entityId: recipeVersionId, metadata: { versionNumber: version.versionNumber } });
}

export async function getRecipe(ctx: QueryCtx, recipeId: Id<'eventRecipes'>): Promise<{ recipe: Doc<'eventRecipes'>; versions: Doc<'recipeVersions'>[] }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const recipe = await ctx.db.get(recipeId);
  if (recipe === null) return notFoundOrInaccessible();
  await requireOrganizationMembership(ctx, recipe.organizationId, authenticated);
  // A recipe's versions are a bounded configuration history, so collecting this child set is permitted (I6).
  const versions = await ctx.db.query('recipeVersions').withIndex('by_recipe_version', (q) => q.eq('recipeId', recipeId)).collect();
  return { recipe, versions };
}

export async function listRecipes(ctx: QueryCtx, organizationId: Id<'organizations'>, paginationOpts: PaginationOptions): Promise<PaginationResult<Doc<'eventRecipes'>>> {
  await requireOrganizationMembership(ctx, organizationId);
  return ctx.db.query('eventRecipes').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).paginate(paginationOpts);
}

export async function getRecipeVersion(ctx: QueryCtx, recipeVersionId: Id<'recipeVersions'>): Promise<{ version: Doc<'recipeVersions'>; recipeFields: Doc<'recipeFields'>[] }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const version = await ctx.db.get(recipeVersionId);
  if (version === null) return notFoundOrInaccessible();
  const recipe = await ctx.db.get(version.recipeId);
  if (recipe === null || recipe.organizationId !== version.organizationId) return notFoundOrInaccessible();
  await requireOrganizationMembership(ctx, recipe.organizationId, authenticated);
  return { version, recipeFields: await getVersionFields(ctx, recipeVersionId) };
}

async function createDraftVersion(ctx: MutationCtx, recipe: Doc<'eventRecipes'>, access: OrganizationMembershipAccess, clonedFromVersion?: number): Promise<Id<'recipeVersions'>> {
  if (recipe.status === 'archived') return invalidInput('Archived recipes cannot get new drafts');
  const draft = await ctx.db.query('recipeVersions').withIndex('by_recipe_status', (q) => q.eq('recipeId', recipe._id).eq('status', 'draft')).unique();
  if (draft !== null) return conflict();
  const latest = await ctx.db.query('recipeVersions').withIndex('by_recipe_version', (q) => q.eq('recipeId', recipe._id)).order('desc').first();
  const versionNumber = (latest?.versionNumber ?? 0) + 1;
  const versionId = await ctx.db.insert('recipeVersions', { organizationId: recipe.organizationId, recipeId: recipe._id, versionNumber, status: 'draft' });
  // The new version number is always recorded; a clone additionally names its source.
  await recordAuditEvent(ctx, { organizationId: recipe.organizationId, actorUserId: access.user._id, action: 'recipeVersion.created', entityType: 'recipeVersion', entityId: versionId, metadata: clonedFromVersion === undefined ? { versionNumber } : { versionNumber, clonedFromVersion } });
  return versionId;
}

/**
 * Retires the recipe's current published version, if it has one. Shared by
 * publishing (a recipe has at most one published version) and archival, so both
 * lifecycle transitions leave exactly the same trace: a `retired` status and a
 * `recipeVersion.retired` audit row naming the version number.
 */
async function retireCurrentPublishedVersion(ctx: MutationCtx, recipe: Doc<'eventRecipes'>, access: OrganizationMembershipAccess): Promise<void> {
  const published = await ctx.db.query('recipeVersions').withIndex('by_recipe_status', (q) => q.eq('recipeId', recipe._id).eq('status', 'published')).unique();
  if (published === null) return;
  await ctx.db.patch(published._id, { status: 'retired' });
  await recordAuditEvent(ctx, { organizationId: recipe.organizationId, actorUserId: access.user._id, action: 'recipeVersion.retired', entityType: 'recipeVersion', entityId: published._id, metadata: { versionNumber: published.versionNumber } });
}

async function requireRecipeAccess(ctx: MutationCtx, recipeId: Id<'eventRecipes'>, minimumRole: Role): Promise<{ recipe: Doc<'eventRecipes'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const recipe = await ctx.db.get(recipeId);
  if (recipe === null) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, recipe.organizationId, minimumRole, authenticated);
  return { recipe, access };
}

async function requireVersionAccess(ctx: MutationCtx, recipeVersionId: Id<'recipeVersions'>, minimumRole: Role): Promise<{ version: Doc<'recipeVersions'>; recipe: Doc<'eventRecipes'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const version = await ctx.db.get(recipeVersionId);
  if (version === null) return notFoundOrInaccessible();
  const recipe = await ctx.db.get(version.recipeId);
  if (recipe === null || recipe.organizationId !== version.organizationId) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, recipe.organizationId, minimumRole, authenticated);
  return { version, recipe, access };
}

/**
 * A version's recipe fields in presentation order. The index does not order by
 * position, so the sort is what makes the order meaningful. Collecting this
 * child set is permitted because it is bounded by `maxFieldsPerVersion` (I6).
 */
export async function getVersionFields(ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>, recipeVersionId: Id<'recipeVersions'>): Promise<Doc<'recipeFields'>[]> {
  const fields = await ctx.db.query('recipeFields').withIndex('by_version', (q) => q.eq('recipeVersionId', recipeVersionId)).collect();
  return fields.sort((left, right) => left.position - right.position);
}

/**
 * The single statement of "may this definition back a recipe field for this
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
  if (required && !visible) return invalidInput('Required recipe fields must be visible');
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
 * of options) because that is the whole point of a per-recipe snapshot. It may
 * never widen it, and never carry options the definition no longer offers: a
 * stale snapshot fails honestly instead of shipping rules its definition
 * disowns, or dead options no operator can act on.
 */
export function assertSnapshotCoherentWithDefinition(snapshot: FieldConfig, definition: FieldConfig): void {
  if (snapshot.kind !== definition.kind) return invalidInput('Recipe field config kind must match the current field definition');
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
      if (definition.kind !== 'select' && definition.kind !== 'multiSelect') return invalidInput('Recipe field config kind must match the current field definition');
      const available = new Set(definition.options.map((option) => option.id));
      if (snapshot.options.some((option) => !available.has(option.id))) return invalidInput('Recipe field snapshot options must still exist in the current field definition');
      if (snapshot.kind === 'multiSelect' && definition.kind === 'multiSelect' && ((definition.minSelections !== undefined && (snapshot.minSelections === undefined || snapshot.minSelections < definition.minSelections)) || (definition.maxSelections !== undefined && (snapshot.maxSelections === undefined || snapshot.maxSelections > definition.maxSelections)))) return narrowingOnly();
      return;
    }
    case 'boolean': case 'location': return;
  }
}

function narrowingOnly(): never {
  return invalidInput('Recipe field config may only narrow definition bounds');
}

/**
 * Publishing is the last moment a version's rules can be questioned: afterwards
 * the snapshot is immutable (I2) and is the only thing historical Events are
 * validated against (I3). So every row is checked for internal coherence *and*
 * for coherence with the field definition it snapshotted (see the composition
 * contract on `recipeFields.config` in schema.ts).
 */
async function validateDraftFields(ctx: MutationCtx, version: Doc<'recipeVersions'>): Promise<void> {
  const recipeFields = await getVersionFields(ctx, version._id);
  // A version with no fields would produce Events that carry no recipe data at
  // all, which is a composition mistake rather than a usable configuration.
  if (recipeFields.length === 0) return invalidInput('Cannot publish a version with no fields');
  const definitions = new Set<string>();
  const positions = new Set<number>();
  for (const recipeField of recipeFields) {
    // Positions are the stable presentation order, so they must be orderable and
    // unambiguous. Density (0..n-1) is the reorder operation's business (#9).
    if (!Number.isInteger(recipeField.position) || recipeField.position < 0 || positions.has(recipeField.position)) {
      return invalidInput('Recipe field positions must be unique non-negative integers');
    }
    positions.add(recipeField.position);
    if (definitions.has(recipeField.fieldDefinitionId)) return invalidInput('Recipe version cannot contain duplicate field definitions');
    definitions.add(recipeField.fieldDefinitionId);
    const definition = await ctx.db.get(recipeField.fieldDefinitionId);
    if (!isUsableDefinition(definition, version.organizationId)) return invalidInput('Recipe fields must reference active fields in the same organization or built-ins');
    // The same coherence rule composition applied when the row was written, run
    // again against the definition as it stands now: a definition edited since
    // then can leave a stored snapshot stale, and this is the last moment it can
    // be refused.
    assertSnapshotCoherentWithDefinition(recipeField.config, definition.config);
    assertRequiredImpliesVisible(recipeField.required, recipeField.visible);
    if (recipeField.defaultValue !== undefined) await validateRecipeFieldDefaultValue(ctx, recipeField.defaultValue, recipeField.config, version.organizationId);
  }
}

/**
 * A default is a value like any other, so it is held to the snapshot's own rules
 * through the shared gate (#10 reuses it for stored Event values). The location
 * branch is the part the pure helper cannot do: the referenced location is
 * resolved here and must belong to this version's organization and still be
 * active. A foreign location fails with the generic error, so a caller cannot
 * use publishing to probe another tenant's ids (I1/I9).
 */
export async function validateRecipeFieldDefaultValue(ctx: MutationCtx, value: EventFieldValue, config: FieldConfig, organizationId: Id<'organizations'>): Promise<void> {
  validateFieldValueAgainstConfig(config, value);
  if (value.kind !== 'location') return;
  // Same reference rule the event value gate applies, stated once in locations/model.ts.
  await assertUsableLocation(ctx, value.locationId, organizationId);
}

function validateRecipeKey(key: string): void {
  if (!recipeKeyPattern.test(key) || key.length < 2 || key.length > 64) return invalidInput('Recipe key must be 2–64 lowerCamelCase characters');
}

function validateDescription(description: string | undefined): void {
  if (description !== undefined && description.length > maxRecipeDescriptionLength) return invalidInput(`Recipe description must not exceed ${maxRecipeDescriptionLength} characters`);
}
