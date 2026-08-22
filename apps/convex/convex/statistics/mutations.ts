import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { backfillOrganizationCounters as backfillOrganizationCountersModel } from './model';

/**
 * Deliberately `internalMutation`, not `mutation`: see the doc comment on
 * the model function for why owner-gating alone is not enough for a
 * destructive, replayable migration. `batchSize` exists only so tests can
 * force the multi-page cursor path without seeding hundreds of rows; the
 * model clamps it to a hard maximum of 100 regardless of what is passed.
 */
export const backfillOrganizationCounters = internalMutation({
  args: {
    organizationId: v.id('organizations'),
    phase: v.union(v.literal('clear'), v.literal('events'), v.literal('projects'), v.literal('recipes'), v.literal('locations')),
    cursor: v.union(v.string(), v.null()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({ continueCursor: v.string(), isDone: v.boolean() }),
  handler: (ctx, args) => backfillOrganizationCountersModel(ctx, args),
});
