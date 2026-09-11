import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import {
  archivalStatusValidator,
  anyArmProviderDocValidator,
  paginatedResult,
  providerAccessGrantDocValidator,
  providerEngagementDocValidator,
  providerDocValidator,
  organizationInvitationDocValidator,
} from '../validators';
import { listMyProviderEngagements as listMyProviderEngagementsModel } from '../lib/access';
import { listProjectProviderAccessGrants as listProjectProviderAccessGrantsModel } from './grants';
import {
  getProvider as getProviderModel,
  listProviderClaimInvitations as listProviderClaimInvitationsModel,
  listProviders as listProvidersModel,
} from './model';

export const getProvider = query({
  args: { providerId: v.id('providers') },
  returns: anyArmProviderDocValidator,
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

export const listProviderClaimInvitations = query({
  args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(organizationInvitationDocValidator),
  handler: (ctx, args) => listProviderClaimInvitationsModel(ctx, args),
});

/**
 * The coordinator's own record of who it has let into one Project, revoked rows
 * included (#71). Paginated because a Project's grant list grows with every firm
 * engaged (I6), and index-narrowed by the GRANTING organization as well as the
 * project so a foreign project id reads an empty range rather than another
 * tenant's grants — behind an `admin` gate that has already refused it anyway.
 *
 * There is deliberately no provider-side counterpart here: a Provider Principal
 * enumerating the grants on a Project would learn which other firms the
 * coordinator engaged (docs/provider-access.md "What a Provider MAY NOT see" §4).
 */
export const listProjectProviderAccessGrants = query({
  args: { projectId: v.id('projects'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(providerAccessGrantDocValidator),
  handler: (ctx, args) => listProjectProviderAccessGrantsModel(ctx, args),
});

export const listMyProviderEngagements = query({
  args: {
    providerOrganizationId: v.id('organizations'),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedResult(providerEngagementDocValidator),
  handler: (ctx, args) => listMyProviderEngagementsModel(ctx, args),
});
