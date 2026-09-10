import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { recordAuditEvent } from '../audit/model';
import {
  requireAuthenticatedUser,
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { validateEntityName } from '../lib/names';
import { organizationConfigurationRole, type Role } from '../lib/roles';
import { assertSearchTermLength, normalizeSearchTerm, normalizeSearchText } from '../lib/search';
import type { archivalStatusValidator } from '../validators';

type ArchivalStatus = typeof archivalStatusValidator.type;
type CostCentrePatch = { name?: string; description?: string; externalReference?: string };
type CostCentreListFilters = { status?: ArchivalStatus; search?: string };

const costCentreKeyPattern = /^[a-z][a-zA-Z0-9]*$/;
const maxCostCentreDescriptionLength = 2000;

export async function createCostCentre(
  ctx: MutationCtx,
  args: {
    organizationId: Id<'organizations'>;
    key: string;
    name: string;
    description?: string;
    externalReference?: string;
  },
): Promise<Id<'costCentres'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, organizationConfigurationRole);
  validateCostCentreKey(args.key);
  const name = validateEntityName(args.name, 'cost centre');
  validateDescription(args.description);
  // Same-transaction indexed read-before-write: Convex OCC makes concurrent
  // creators retry against the winning row instead of admitting duplicates.
  const existing = await ctx.db
    .query('costCentres')
    .withIndex('by_org_key', (q) => q.eq('organizationId', args.organizationId).eq('key', args.key))
    .unique();
  if (existing !== null) return conflict();
  const costCentreId = await ctx.db.insert('costCentres', {
    organizationId: args.organizationId,
    key: args.key,
    name,
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.externalReference === undefined ? {} : { externalReference: args.externalReference }),
    searchText: normalizeSearchText(name),
    status: 'active',
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'costCentre.created',
    entityType: 'costCentre',
    entityId: costCentreId,
    metadata: { key: args.key, name },
  });
  return costCentreId;
}

export async function getCostCentre(ctx: QueryCtx, costCentreId: Id<'costCentres'>): Promise<Doc<'costCentres'>> {
  const { costCentre } = await requireCostCentreAccess(ctx, costCentreId);
  return costCentre;
}

export async function listCostCentres(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
  filters: CostCentreListFilters,
): Promise<PaginationResult<Doc<'costCentres'>>> {
  await requireOrganizationMembership(ctx, organizationId);
  assertSearchTermLength(filters.search);
  const term = normalizeSearchTerm(filters.search ?? '');
  if (term !== '') {
    const status = filters.status;
    return ctx.db.query('costCentres').withSearchIndex('search_text', (q) => {
      let search = q.search('searchText', term).eq('organizationId', organizationId);
      if (status !== undefined) search = search.eq('status', status);
      return search;
    }).paginate(paginationOpts);
  }
  if (filters.status !== undefined) {
    const status = filters.status;
    return ctx.db
      .query('costCentres')
      .withIndex('by_org_status', (q) => q.eq('organizationId', organizationId).eq('status', status))
      .paginate(paginationOpts);
  }
  return ctx.db
    .query('costCentres')
    .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
    .paginate(paginationOpts);
}

export async function updateCostCentre(
  ctx: MutationCtx,
  costCentreId: Id<'costCentres'>,
  patch: CostCentrePatch,
): Promise<void> {
  const { costCentre, access } = await requireCostCentreAccess(ctx, costCentreId, organizationConfigurationRole);
  if (costCentre.status === 'archived') {
    return invalidInput('costCentreArchived', 'Archived Cost Centres cannot be updated');
  }
  const name = patch.name === undefined ? undefined : validateEntityName(patch.name, 'cost centre');
  validateDescription(patch.description);
  const update: CostCentrePatch & { searchText?: string } = {};
  const changedFields: string[] = [];
  if (name !== undefined && name !== costCentre.name) {
    update.name = name;
    update.searchText = normalizeSearchText(name);
    changedFields.push('name');
  }
  if (patch.description !== undefined && patch.description !== costCentre.description) {
    update.description = patch.description;
    changedFields.push('description');
  }
  if (patch.externalReference !== undefined && patch.externalReference !== costCentre.externalReference) {
    update.externalReference = patch.externalReference;
    changedFields.push('externalReference');
  }
  if (changedFields.length === 0) return;
  await ctx.db.patch(costCentreId, update);
  await recordAuditEvent(ctx, {
    organizationId: costCentre.organizationId,
    actorUserId: access.user._id,
    action: 'costCentre.updated',
    entityType: 'costCentre',
    entityId: costCentreId,
    metadata: { changedFields: changedFields.join(',') },
  });
}

export async function archiveCostCentre(ctx: MutationCtx, costCentreId: Id<'costCentres'>): Promise<void> {
  const { costCentre, access } = await requireCostCentreAccess(ctx, costCentreId, organizationConfigurationRole);
  if (costCentre.status === 'archived') return;
  await ctx.db.patch(costCentreId, { status: 'archived' });
  await recordAuditEvent(ctx, {
    organizationId: costCentre.organizationId,
    actorUserId: access.user._id,
    action: 'costCentre.archived',
    entityType: 'costCentre',
    entityId: costCentreId,
    metadata: { previousStatus: costCentre.status },
  });
}

export async function deleteCostCentre(ctx: MutationCtx, costCentreId: Id<'costCentres'>): Promise<void> {
  const { costCentre, access } = await requireCostCentreAccess(ctx, costCentreId, organizationConfigurationRole);
  if (costCentre.status !== 'archived') {
    return invalidInput('costCentreArchiveRequired', 'Cost Centres must be archived before deletion');
  }
  // Each referencing table is checked first-hit through its mirror index before
  // this delete, exactly as `deleteLocation` does. Events and Assignments are
  // independent live references, so either one retains the catalogue row.
  const eventReference = await ctx.db
    .query('events')
    .withIndex('by_clientCostCentre', (q) => q.eq('clientCostCentreId', costCentreId))
    .first();
  if (eventReference !== null) {
    return invalidInput('costCentreDeleteBlocked', 'Referenced Cost Centres cannot be deleted; retain the archived Cost Centre instead');
  }
  const assignmentReference = await ctx.db
    .query('assignments')
    .withIndex('by_costCentre', (q) => q.eq('costCentreId', costCentreId))
    .first();
  if (assignmentReference !== null) {
    return invalidInput('costCentreDeleteBlocked', 'Referenced Cost Centres cannot be deleted; retain the archived Cost Centre instead');
  }
  // Recorded BEFORE the delete so the row's name is still readable, matching
  // `deleteEvent` and `deleteLocation`.
  await recordAuditEvent(ctx, {
    organizationId: costCentre.organizationId,
    actorUserId: access.user._id,
    action: 'costCentre.deleted',
    entityType: 'costCentre',
    entityId: costCentreId,
    metadata: { name: costCentre.name },
  });
  await ctx.db.delete(costCentreId);
}

/**
 * The single statement of "may this organization store a reference to this Cost
 * Centre?", mirroring `locations/model.ts` `assertUsableLocation`: it must
 * exist, belong to that organization, and still be active.
 *
 * Failure is always the generic error. The id arrives from the caller, so a
 * foreign, archived, or fabricated Cost Centre must be indistinguishable or
 * every writer of a Cost Centre reference becomes a tenant probe (I1/I9).
 */
export async function assertUsableCostCentre(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  costCentreId: Id<'costCentres'>,
  organizationId: Id<'organizations'>,
): Promise<Doc<'costCentres'>> {
  const costCentre = await ctx.db.get(costCentreId);
  if (costCentre === null || costCentre.organizationId !== organizationId || costCentre.status === 'archived') {
    return notFoundOrInaccessible();
  }
  return costCentre;
}

/** Authenticates before lookup so foreign and fabricated ids stay opaque (I9). */
export async function requireCostCentreAccess(
  ctx: QueryCtx | MutationCtx,
  costCentreId: Id<'costCentres'>,
  minimumRole?: Role,
): Promise<{ costCentre: Doc<'costCentres'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const costCentre = await ctx.db.get(costCentreId);
  if (costCentre === null) return notFoundOrInaccessible();
  const access = minimumRole === undefined
    ? await requireOrganizationMembership(ctx, costCentre.organizationId, authenticated)
    : await requireOrganizationRole(ctx, costCentre.organizationId, minimumRole, authenticated);
  return { costCentre, access };
}

function validateCostCentreKey(key: string): void {
  if (!costCentreKeyPattern.test(key) || key.length < 2 || key.length > 64) {
    return invalidInput('costCentreKeyInvalid', 'Cost Centre key must be 2–64 lowerCamelCase characters');
  }
}

function validateDescription(description: string | undefined): void {
  if (description !== undefined && description.length > maxCostCentreDescriptionLength) {
    return invalidInput('costCentreDescriptionTooLong', `Cost Centre description must not exceed ${maxCostCentreDescriptionLength} characters`);
  }
}
