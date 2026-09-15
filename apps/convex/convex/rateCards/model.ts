import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { recordAuditEvent } from '../audit/model';
import {
  requireAuthenticatedUser,
  requireOrganizationRole,
  type AuthenticatedUser,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { assertMinorUnits } from '../lib/money';
import { validateEntityName } from '../lib/names';
import { organizationConfigurationRole } from '../lib/roles';
import { assertUsableProvider } from '../providers/model';
import type { currencyValidator, rateModalityValidator } from '../validators';
import { assertUsableVehicleClass } from '../vehicles/classes';

type Currency = typeof currencyValidator.type;
type RateModality = typeof rateModalityValidator.type;
type RateCardPatch = { name?: string };

/**
 * Rate Lines are a bounded configuration child set: cloning, publication and
 * version reads consume the complete grid. The enforced ceiling is what makes
 * those `.collect()` calls bounded under I6.
 */
export const maxRateLinesPerVersion = 1000;

export async function createRateCard(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; providerId: Id<'providers'>; name: string },
): Promise<Id<'rateCards'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, organizationConfigurationRole);
  await assertUsableProvider(ctx, args.providerId, args.organizationId);
  const name = validateEntityName(args.name, 'rate card');
  const rateCardId = await ctx.db.insert('rateCards', {
    organizationId: args.organizationId,
    providerId: args.providerId,
    name,
    status: 'active',
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'rateCard.created',
    entityType: 'rateCard',
    entityId: rateCardId,
    metadata: { name, providerId: args.providerId },
  });
  return rateCardId;
}

export async function updateRateCardMetadata(
  ctx: MutationCtx,
  rateCardId: Id<'rateCards'>,
  patch: RateCardPatch,
): Promise<void> {
  const { rateCard, access } = await requireRateCardAccess(ctx, rateCardId);
  if (rateCard.status === 'archived') {
    return invalidInput('rateCardArchived', 'Archived Rate Cards cannot be updated');
  }
  const name = patch.name === undefined ? undefined : validateEntityName(patch.name, 'rate card');
  if (name === undefined || name === rateCard.name) return;
  await ctx.db.patch(rateCardId, { name });
  await recordAuditEvent(ctx, {
    organizationId: rateCard.organizationId,
    actorUserId: access.user._id,
    action: 'rateCard.updated',
    entityType: 'rateCard',
    entityId: rateCardId,
    metadata: { changedFields: 'name' },
  });
}

export async function archiveRateCard(ctx: MutationCtx, rateCardId: Id<'rateCards'>): Promise<void> {
  const { rateCard, access } = await requireRateCardAccess(ctx, rateCardId);
  if (rateCard.status === 'archived') return;
  await retireCurrentPublishedVersion(ctx, rateCard, access);
  await ctx.db.patch(rateCardId, { status: 'archived', currentPublishedVersionId: undefined });
  await recordAuditEvent(ctx, {
    organizationId: rateCard.organizationId,
    actorUserId: access.user._id,
    action: 'rateCard.archived',
    entityType: 'rateCard',
    entityId: rateCardId,
    metadata: { previousStatus: rateCard.status },
  });
}

export async function createInitialDraftVersion(
  ctx: MutationCtx,
  rateCardId: Id<'rateCards'>,
  currency: Currency,
): Promise<Id<'rateCardVersions'>> {
  const { rateCard, access } = await requireRateCardAccess(ctx, rateCardId);
  return createDraftVersion(ctx, rateCard, access, currency);
}

export async function clonePublishedVersionToDraft(
  ctx: MutationCtx,
  rateCardId: Id<'rateCards'>,
): Promise<Id<'rateCardVersions'>> {
  const { rateCard, access } = await requireRateCardAccess(ctx, rateCardId);
  if (rateCard.status === 'archived') {
    return invalidInput('rateCardArchived', 'Archived Rate Cards cannot get new drafts');
  }
  const published = await ctx.db
    .query('rateCardVersions')
    .withIndex('by_card_status', (q) => q.eq('rateCardId', rateCardId).eq('status', 'published'))
    .unique();
  if (published === null || rateCard.currentPublishedVersionId !== published._id) {
    return invalidInput('rateCardPublishedVersionRequired', 'A current published Rate Card Version is required to clone');
  }
  const versionId = await createDraftVersion(ctx, rateCard, access, published.currency, published.versionNumber);
  const sourceLines = await getVersionRateLines(ctx, published._id);
  if (sourceLines.length > maxRateLinesPerVersion) {
    return invalidInput('rateLineLimitExceeded', `A Rate Card Version cannot hold more than ${maxRateLinesPerVersion} Rate Lines`);
  }
  for (const source of sourceLines) {
    assertMinorUnits(source.unitAmount);
    await ctx.db.insert('rateLines', {
      organizationId: rateCard.organizationId,
      rateCardVersionId: versionId,
      vehicleClassId: source.vehicleClassId,
      modality: source.modality,
      unitAmount: source.unitAmount,
    });
  }
  return versionId;
}

export async function updateRateCardVersion(
  ctx: MutationCtx,
  rateCardVersionId: Id<'rateCardVersions'>,
  currency: Currency,
): Promise<void> {
  const { version } = await requireDraftVersionForEdit(ctx, rateCardVersionId);
  if (version.currency === currency) return;
  await ctx.db.patch(rateCardVersionId, { currency });
}

export async function addRateLine(
  ctx: MutationCtx,
  args: {
    rateCardVersionId: Id<'rateCardVersions'>;
    vehicleClassId: Id<'vehicleClasses'>;
    modality: RateModality;
    unitAmount: number;
  },
): Promise<Id<'rateLines'>> {
  const { version } = await requireDraftVersionForEdit(ctx, args.rateCardVersionId);
  assertMinorUnits(args.unitAmount);
  await assertUsableVehicleClass(ctx, args.vehicleClassId, version.organizationId);
  const duplicate = await ctx.db
    .query('rateLines')
    .withIndex('by_version_class_modality', (q) =>
      q
        .eq('rateCardVersionId', version._id)
        .eq('vehicleClassId', args.vehicleClassId)
        .eq('modality', args.modality),
    )
    .unique();
  if (duplicate !== null) return conflict();
  const siblings = await getVersionRateLines(ctx, version._id);
  if (siblings.length >= maxRateLinesPerVersion) {
    return invalidInput('rateLineLimitExceeded', `A Rate Card Version cannot hold more than ${maxRateLinesPerVersion} Rate Lines`);
  }
  return ctx.db.insert('rateLines', {
    organizationId: version.organizationId,
    rateCardVersionId: version._id,
    vehicleClassId: args.vehicleClassId,
    modality: args.modality,
    unitAmount: args.unitAmount,
  });
}

export async function updateRateLine(
  ctx: MutationCtx,
  args: {
    rateLineId: Id<'rateLines'>;
    vehicleClassId?: Id<'vehicleClasses'>;
    modality?: RateModality;
    unitAmount?: number;
  },
): Promise<void> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const rateLine = await ctx.db.get(args.rateLineId);
  if (rateLine === null) return notFoundOrInaccessible();
  const { version } = await requireDraftVersionForEdit(ctx, rateLine.rateCardVersionId, authenticated);
  if (rateLine.organizationId !== version.organizationId) return notFoundOrInaccessible();

  const vehicleClassId = args.vehicleClassId ?? rateLine.vehicleClassId;
  const modality = args.modality ?? rateLine.modality;
  const unitAmount = args.unitAmount ?? rateLine.unitAmount;
  assertMinorUnits(unitAmount);
  await assertUsableVehicleClass(ctx, vehicleClassId, version.organizationId);
  if (vehicleClassId !== rateLine.vehicleClassId || modality !== rateLine.modality) {
    const duplicate = await ctx.db
      .query('rateLines')
      .withIndex('by_version_class_modality', (q) =>
        q
          .eq('rateCardVersionId', version._id)
          .eq('vehicleClassId', vehicleClassId)
          .eq('modality', modality),
      )
      .unique();
    if (duplicate !== null && duplicate._id !== rateLine._id) return conflict();
  }
  if (
    vehicleClassId === rateLine.vehicleClassId &&
    modality === rateLine.modality &&
    unitAmount === rateLine.unitAmount
  ) return;
  await ctx.db.patch(rateLine._id, { vehicleClassId, modality, unitAmount });
}

export async function removeRateLine(ctx: MutationCtx, rateLineId: Id<'rateLines'>): Promise<void> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const rateLine = await ctx.db.get(rateLineId);
  if (rateLine === null) return notFoundOrInaccessible();
  const { version } = await requireDraftVersionForEdit(ctx, rateLine.rateCardVersionId, authenticated);
  if (rateLine.organizationId !== version.organizationId) return notFoundOrInaccessible();
  await ctx.db.delete(rateLine._id);
}

export async function publishRateCardVersion(
  ctx: MutationCtx,
  rateCardVersionId: Id<'rateCardVersions'>,
): Promise<void> {
  const { version, rateCard, access } = await requireRateCardVersionAccess(ctx, rateCardVersionId);
  if (version.status !== 'draft') {
    return invalidInput('rateCardVersionNotDraft', 'Only draft Rate Card Versions can be published');
  }
  if (rateCard.status === 'archived') {
    return invalidInput('rateCardArchived', 'Archived Rate Cards cannot be published');
  }
  await validateDraftGrid(ctx, version, rateCard);
  await retireCurrentPublishedVersion(ctx, rateCard, access);
  await ctx.db.patch(rateCardVersionId, { status: 'published', publishedAt: Date.now() });
  await ctx.db.patch(rateCard._id, { currentPublishedVersionId: rateCardVersionId });
  await recordAuditEvent(ctx, {
    organizationId: rateCard.organizationId,
    actorUserId: access.user._id,
    action: 'rateCardVersion.published',
    entityType: 'rateCardVersion',
    entityId: rateCardVersionId,
    metadata: { versionNumber: version.versionNumber },
  });
}

export async function retireRateCardVersion(
  ctx: MutationCtx,
  rateCardVersionId: Id<'rateCardVersions'>,
): Promise<void> {
  const { version, rateCard, access } = await requireRateCardVersionAccess(ctx, rateCardVersionId);
  if (version.status !== 'published' || rateCard.currentPublishedVersionId !== version._id) {
    return invalidInput('rateCardVersionNotPublished', 'Only the current published Rate Card Version can be retired');
  }
  await retireVersion(ctx, rateCard, version, access);
  await ctx.db.patch(rateCard._id, { currentPublishedVersionId: undefined });
}

export async function getRateCard(
  ctx: QueryCtx,
  rateCardId: Id<'rateCards'>,
): Promise<Doc<'rateCards'>> {
  const { rateCard } = await requireRateCardAccess(ctx, rateCardId);
  return rateCard;
}

export async function getRateCardDetail(
  ctx: QueryCtx,
  rateCardId: Id<'rateCards'>,
): Promise<{
  rateCard: Doc<'rateCards'>;
  draftVersion: Doc<'rateCardVersions'> | null;
  publishedVersion: Doc<'rateCardVersions'> | null;
}> {
  const { rateCard } = await requireRateCardAccess(ctx, rateCardId);
  const draftVersion = await ctx.db
    .query('rateCardVersions')
    .withIndex('by_card_status', (q) => q.eq('rateCardId', rateCardId).eq('status', 'draft'))
    .unique();
  const pointedPublishedVersion = rateCard.currentPublishedVersionId === undefined
    ? null
    : await ctx.db.get(rateCard.currentPublishedVersionId);
  const publishedVersion = pointedPublishedVersion !== null &&
      pointedPublishedVersion.rateCardId === rateCard._id &&
      pointedPublishedVersion.organizationId === rateCard.organizationId &&
      pointedPublishedVersion.status === 'published'
    ? pointedPublishedVersion
    : null;
  return { rateCard, draftVersion, publishedVersion };
}

export async function listRateCards(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
  filter: { providerId?: Id<'providers'> },
): Promise<PaginationResult<Doc<'rateCards'>>> {
  await requireOrganizationRole(ctx, organizationId, organizationConfigurationRole);
  // Filtering a fetched page would make matches beyond its cursor invisible and
  // present an incomplete tenant catalogue as complete, violating I6.
  if (filter.providerId !== undefined) {
    const providerId = filter.providerId;
    return ctx.db
      .query('rateCards')
      .withIndex('by_org_provider', (q) =>
        q.eq('organizationId', organizationId).eq('providerId', providerId),
      )
      .paginate(paginationOpts);
  }
  return ctx.db.query('rateCards').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).paginate(paginationOpts);
}

export async function listRateCardVersions(
  ctx: QueryCtx,
  rateCardId: Id<'rateCards'>,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<Doc<'rateCardVersions'>>> {
  await requireRateCardAccess(ctx, rateCardId);
  return ctx.db
    .query('rateCardVersions')
    .withIndex('by_card_version', (q) => q.eq('rateCardId', rateCardId))
    .order('desc')
    .paginate(paginationOpts);
}

export async function getRateCardVersion(
  ctx: QueryCtx,
  rateCardVersionId: Id<'rateCardVersions'>,
): Promise<{ version: Doc<'rateCardVersions'>; rateLines: Doc<'rateLines'>[] }> {
  const { version } = await requireRateCardVersionAccess(ctx, rateCardVersionId);
  return { version, rateLines: await getVersionRateLines(ctx, rateCardVersionId) };
}

export async function resolveRate(
  ctx: QueryCtx,
  args: {
    rateCardVersionId: Id<'rateCardVersions'>;
    providerId: Id<'providers'>;
    vehicleClassId: Id<'vehicleClasses'>;
    modality: RateModality;
  },
): Promise<{ rateLineId: Id<'rateLines'>; unitAmount: number; currency: Currency }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const version = await ctx.db.get(args.rateCardVersionId);
  if (version === null) return notFoundOrInaccessible();
  const rateCard = await ctx.db.get(version.rateCardId);
  if (rateCard === null || rateCard.organizationId !== version.organizationId) return notFoundOrInaccessible();
  await requireOrganizationRole(ctx, rateCard.organizationId, organizationConfigurationRole, authenticated);
  return resolveRateForAssignment(ctx, args);
}

/**
 * Resolves the immutable pricing cell after the caller has already authorized
 * the enclosing operation. This is domain-internal, not a public Convex query:
 * public Rate Card reads retain their configuration-role gate, while Assignment
 * authoring is authorized once at the Project gate.
 */
export async function resolveRateForAssignment(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  args: {
    rateCardVersionId: Id<'rateCardVersions'>;
    providerId: Id<'providers'>;
    vehicleClassId: Id<'vehicleClasses'>;
    modality: RateModality;
  },
): Promise<{ rateLineId: Id<'rateLines'>; unitAmount: number; currency: Currency }> {
  const version = await ctx.db.get(args.rateCardVersionId);
  if (version === null) return notFoundOrInaccessible();
  const rateCard = await ctx.db.get(version.rateCardId);
  if (rateCard === null || rateCard.organizationId !== version.organizationId) return notFoundOrInaccessible();
  if (
    version.status !== 'published' ||
    rateCard.status !== 'active' ||
    rateCard.currentPublishedVersionId !== version._id ||
    rateCard.providerId !== args.providerId
  ) return notFoundOrInaccessible();

  const [provider, vehicleClass] = await Promise.all([
    ctx.db.get(args.providerId),
    ctx.db.get(args.vehicleClassId),
  ]);
  if (
    provider === null ||
    provider.organizationId !== rateCard.organizationId ||
    vehicleClass === null ||
    vehicleClass.organizationId !== rateCard.organizationId
  ) return notFoundOrInaccessible();

  const rateLine = await ctx.db
    .query('rateLines')
    .withIndex('by_version_class_modality', (q) =>
      q
        .eq('rateCardVersionId', version._id)
        .eq('vehicleClassId', args.vehicleClassId)
        .eq('modality', args.modality),
    )
    .unique();
  if (rateLine === null || rateLine.organizationId !== rateCard.organizationId) return notFoundOrInaccessible();
  return { rateLineId: rateLine._id, unitAmount: rateLine.unitAmount, currency: version.currency };
}

async function createDraftVersion(
  ctx: MutationCtx,
  rateCard: Doc<'rateCards'>,
  access: OrganizationMembershipAccess,
  currency: Currency,
  clonedFromVersion?: number,
): Promise<Id<'rateCardVersions'>> {
  if (rateCard.status === 'archived') {
    return invalidInput('rateCardArchived', 'Archived Rate Cards cannot get new drafts');
  }
  const draft = await ctx.db
    .query('rateCardVersions')
    .withIndex('by_card_status', (q) => q.eq('rateCardId', rateCard._id).eq('status', 'draft'))
    .unique();
  if (draft !== null) return conflict();
  const latest = await ctx.db
    .query('rateCardVersions')
    .withIndex('by_card_version', (q) => q.eq('rateCardId', rateCard._id))
    .order('desc')
    .first();
  const versionNumber = (latest?.versionNumber ?? 0) + 1;
  const versionId = await ctx.db.insert('rateCardVersions', {
    organizationId: rateCard.organizationId,
    rateCardId: rateCard._id,
    versionNumber,
    currency,
    status: 'draft',
  });
  await recordAuditEvent(ctx, {
    organizationId: rateCard.organizationId,
    actorUserId: access.user._id,
    action: 'rateCardVersion.created',
    entityType: 'rateCardVersion',
    entityId: versionId,
    metadata: clonedFromVersion === undefined ? { versionNumber } : { versionNumber, clonedFromVersion },
  });
  return versionId;
}

async function retireCurrentPublishedVersion(
  ctx: MutationCtx,
  rateCard: Doc<'rateCards'>,
  access: OrganizationMembershipAccess,
): Promise<void> {
  const published = await ctx.db
    .query('rateCardVersions')
    .withIndex('by_card_status', (q) => q.eq('rateCardId', rateCard._id).eq('status', 'published'))
    .unique();
  if (published === null) return;
  await retireVersion(ctx, rateCard, published, access);
}

async function retireVersion(
  ctx: MutationCtx,
  rateCard: Doc<'rateCards'>,
  version: Doc<'rateCardVersions'>,
  access: OrganizationMembershipAccess,
): Promise<void> {
  await ctx.db.patch(version._id, { status: 'retired' });
  await recordAuditEvent(ctx, {
    organizationId: rateCard.organizationId,
    actorUserId: access.user._id,
    action: 'rateCardVersion.retired',
    entityType: 'rateCardVersion',
    entityId: version._id,
    metadata: { versionNumber: version.versionNumber },
  });
}

async function validateDraftGrid(
  ctx: MutationCtx,
  version: Doc<'rateCardVersions'>,
  rateCard: Doc<'rateCards'>,
): Promise<void> {
  const provider = await ctx.db.get(rateCard.providerId);
  if (provider === null || provider.organizationId !== version.organizationId || provider.status !== 'active') {
    return invalidInput('rateCardProviderUnavailable', 'Rate Cards can only publish for an active Provider in the same organization');
  }
  const rateLines = await getVersionRateLines(ctx, version._id);
  if (rateLines.length === 0) {
    return invalidInput('rateCardVersionEmpty', 'Cannot publish a Rate Card Version with no Rate Lines');
  }
  const cells = new Set<string>();
  for (const rateLine of rateLines) {
    assertMinorUnits(rateLine.unitAmount);
    if (rateLine.organizationId !== version.organizationId) {
      return invalidInput('rateLineVehicleClassUnavailable', 'Rate Lines must belong to the Rate Card organization');
    }
    const vehicleClass = await ctx.db.get(rateLine.vehicleClassId);
    if (
      vehicleClass === null ||
      vehicleClass.organizationId !== version.organizationId ||
      vehicleClass.status !== 'active'
    ) {
      return invalidInput('rateLineVehicleClassUnavailable', 'Rate Lines must reference active Vehicle Classes in the same organization');
    }
    const cell = `${rateLine.vehicleClassId}:${rateLine.modality}`;
    if (cells.has(cell)) {
      return invalidInput('rateLineDuplicateCell', 'A Rate Card Version cannot contain duplicate Class and modality cells');
    }
    cells.add(cell);
  }
}

async function requireRateCardAccess(
  ctx: QueryCtx | MutationCtx,
  rateCardId: Id<'rateCards'>,
): Promise<{ rateCard: Doc<'rateCards'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const rateCard = await ctx.db.get(rateCardId);
  if (rateCard === null) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, rateCard.organizationId, organizationConfigurationRole, authenticated);
  return { rateCard, access };
}

async function requireRateCardVersionAccess(
  ctx: QueryCtx | MutationCtx,
  rateCardVersionId: Id<'rateCardVersions'>,
): Promise<{ version: Doc<'rateCardVersions'>; rateCard: Doc<'rateCards'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const version = await ctx.db.get(rateCardVersionId);
  if (version === null) return notFoundOrInaccessible();
  const rateCard = await ctx.db.get(version.rateCardId);
  if (rateCard === null || rateCard.organizationId !== version.organizationId) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, rateCard.organizationId, organizationConfigurationRole, authenticated);
  return { version, rateCard, access };
}

async function requireDraftVersionForEdit(
  ctx: MutationCtx,
  rateCardVersionId: Id<'rateCardVersions'>,
  preResolvedUser?: AuthenticatedUser,
): Promise<{ version: Doc<'rateCardVersions'>; rateCard: Doc<'rateCards'>; access: OrganizationMembershipAccess }> {
  const authenticated = preResolvedUser ?? (await requireAuthenticatedUser(ctx));
  const version = await ctx.db.get(rateCardVersionId);
  if (version === null) return notFoundOrInaccessible();
  const rateCard = await ctx.db.get(version.rateCardId);
  if (rateCard === null || rateCard.organizationId !== version.organizationId) return notFoundOrInaccessible();
  const access = await requireOrganizationRole(ctx, rateCard.organizationId, organizationConfigurationRole, authenticated);
  if (rateCard.status === 'archived') {
    return invalidInput('rateCardArchived', 'Archived Rate Cards cannot be edited');
  }
  if (version.status !== 'draft') {
    return invalidInput('rateCardVersionNotDraft', 'Published and retired Rate Card Versions are immutable');
  }
  return { version, rateCard, access };
}

export async function getVersionRateLines(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  rateCardVersionId: Id<'rateCardVersions'>,
): Promise<Doc<'rateLines'>[]> {
  return ctx.db
    .query('rateLines')
    .withIndex('by_version', (q) => q.eq('rateCardVersionId', rateCardVersionId))
    .collect();
}
