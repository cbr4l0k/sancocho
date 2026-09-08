import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { archivalStatusValidator, paginatedResult, providerDocValidator } from '../validators';
import { getProvider as getProviderModel, listProviders as listProvidersModel } from './model';

export const getProvider = query({
  args: { providerId: v.id('providers') },
  returns: providerDocValidator,
  handler: (ctx, args) => getProviderModel(ctx, args.providerId),
});

export const listProviders = query({
  args: {
    organizationId: v.id('organizations'),
    paginationOpts: paginationOptsValidator,
    status: v.optional(archivalStatusValidator),
    search: v.optional(v.string()),
  },
  returns: paginatedResult(providerDocValidator),
  handler: (ctx, args) => listProvidersModel(ctx, args.organizationId, args.paginationOpts, {
    ...(args.status === undefined ? {} : { status: args.status }),
    ...(args.search === undefined ? {} : { search: args.search }),
  }),
});
