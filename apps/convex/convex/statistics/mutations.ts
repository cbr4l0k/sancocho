import { v } from 'convex/values';
import { mutation } from '../_generated/server';
import { backfillOrganizationCounters as backfillOrganizationCountersModel } from './model';

export const backfillOrganizationCounters = mutation({
  args: {
    organizationId: v.id('organizations'),
    phase: v.union(v.literal('clear'), v.literal('events'), v.literal('projects'), v.literal('recipes'), v.literal('locations')),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ continueCursor: v.string(), isDone: v.boolean() }),
  handler: (ctx, args) => backfillOrganizationCountersModel(ctx, args),
});
