import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** Indexed first-hit guard used before deleting a Provider. */
export async function providerHasAssignments(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  organizationId: Id<'organizations'>,
  providerId: Id<'providers'>,
): Promise<boolean> {
  const reference = await ctx.db
    .query('assignments')
    .withIndex('by_org_provider', (q) =>
      q.eq('organizationId', organizationId).eq('providerId', providerId),
    )
    .first();
  return reference !== null;
}
