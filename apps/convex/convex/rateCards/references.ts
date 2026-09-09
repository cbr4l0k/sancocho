import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** Indexed first-hit guard used before deleting a Provider. Archived cards count. */
export async function providerHasRateCards(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  organizationId: Id<'organizations'>,
  providerId: Id<'providers'>,
): Promise<boolean> {
  const reference = await ctx.db
    .query('rateCards')
    .withIndex('by_org_provider', (q) => q.eq('organizationId', organizationId).eq('providerId', providerId))
    .first();
  return reference !== null;
}

/** Indexed first-hit guard used before deleting a Vehicle Class. */
export async function vehicleClassHasRateLines(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  organizationId: Id<'organizations'>,
  vehicleClassId: Id<'vehicleClasses'>,
): Promise<boolean> {
  const reference = await ctx.db
    .query('rateLines')
    .withIndex('by_org_class', (q) => q.eq('organizationId', organizationId).eq('vehicleClassId', vehicleClassId))
    .first();
  return reference !== null;
}

/**
 * True when a retained Assignment Revision was priced from this Version.
 * Rate Card Versions currently have no destructive public door; this guard is
 * colocated here so any future internal deletion must account for the history.
 */
export async function rateCardVersionHasAssignmentRevisions(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  rateCardVersionId: Id<'rateCardVersions'>,
): Promise<boolean> {
  const reference = await ctx.db
    .query('assignmentRevisions')
    .withIndex('by_rateCardVersion', (q) => q.eq('rateCardVersionId', rateCardVersionId))
    .first();
  return reference !== null;
}
