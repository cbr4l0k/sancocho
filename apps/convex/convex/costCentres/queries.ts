import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { archivalStatusValidator, costCentreDocValidator, paginatedResult } from '../validators';
import { getCostCentre as getCostCentreModel, listCostCentres as listCostCentresModel } from './model';

export const getCostCentre = query({
  args: { costCentreId: v.id('costCentres') },
  returns: costCentreDocValidator,
  handler: (ctx, args) => getCostCentreModel(ctx, args.costCentreId),
});

export const listCostCentres = query({
  args: {
    organizationId: v.id('organizations'),
    paginationOpts: paginationOptsValidator,
    status: v.optional(archivalStatusValidator),
    search: v.optional(v.string()),
  },
  returns: paginatedResult(costCentreDocValidator),
  handler: (ctx, args) => listCostCentresModel(ctx, args.organizationId, args.paginationOpts, {
    ...(args.status === undefined ? {} : { status: args.status }),
    ...(args.search === undefined ? {} : { search: args.search }),
  }),
});
