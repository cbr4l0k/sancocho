import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import {
  grantProjectAccessToProvider as grantProjectAccessToProviderModel,
  revokeProviderAccessGrant as revokeProviderAccessGrantModel,
} from './grants';
import {
  archiveProvider as archiveProviderModel,
  claimProviderOrganization as claimProviderOrganizationModel,
  createProvider as createProviderModel,
  deleteProvider as deleteProviderModel,
  inviteProviderOrganization as inviteProviderOrganizationModel,
  revokeProviderClaimInvitation as revokeProviderClaimInvitationModel,
  revokeProviderOrganizationClaim as revokeProviderOrganizationClaimModel,
  updateProvider as updateProviderModel,
} from './model';

export const createProvider = mutation({
  args: {
    organizationId: v.id('organizations'),
    name: v.string(),
    legalName: v.optional(v.string()),
    taxId: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.id('providers'),
  handler: (ctx, args) => createProviderModel(ctx, args),
});

/**
 * The GENERIC Provider update. `linkedOrganizationId` is deliberately absent
 * from these args and cannot be added here: a claim is #86's verified,
 * separately-audited transition, not an editable column. Convex rejects
 * arguments this validator does not declare, so a client that sends the field
 * is refused outright rather than having it quietly ignored — see the
 * three-gate note on `ProviderPatch` in `model.ts`.
 */
export const updateProvider = mutation({
  args: {
    providerId: v.id('providers'),
    name: v.optional(v.string()),
    legalName: v.optional(v.string()),
    taxId: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { providerId, ...patch }) => {
    await updateProviderModel(ctx, providerId, patch);
    return null;
  },
});

export const archiveProvider = mutation({
  args: { providerId: v.id('providers') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await archiveProviderModel(ctx, args.providerId);
    return null;
  },
});

export const deleteProvider = mutation({
  args: { providerId: v.id('providers') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteProviderModel(ctx, args.providerId);
    return null;
  },
});

export const inviteProviderOrganization = mutation({
  args: { providerId: v.id('providers'), email: v.string() },
  returns: v.id('organizationInvitations'),
  handler: (ctx, args) => inviteProviderOrganizationModel(ctx, args),
});

export const claimProviderOrganization = mutation({
  args: {
    invitationId: v.id('organizationInvitations'),
    organizationId: v.id('organizations'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await claimProviderOrganizationModel(ctx, args);
    return null;
  },
});

export const revokeProviderOrganizationClaim = mutation({
  args: { providerId: v.id('providers') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await revokeProviderOrganizationClaimModel(ctx, args.providerId);
    return null;
  },
});

export const revokeProviderClaimInvitation = mutation({
  args: { invitationId: v.id('organizationInvitations') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await revokeProviderClaimInvitationModel(ctx, args.invitationId);
    return null;
  },
});

/**
 * The COORDINATOR side of the second principal arm (#71). Both entry points
 * below are member-arm operations by construction: the model functions prove an
 * `admin` MEMBERSHIP of the granting organization, which a Provider Principal
 * can never hold, so non-transitivity needs no rule here — there is no argument
 * a granted firm could send that would reach the write.
 */
export const grantProjectAccessToProvider = mutation({
  args: { projectId: v.id('projects'), providerId: v.id('providers') },
  returns: v.id('providerAccessGrants'),
  handler: (ctx, args) => grantProjectAccessToProviderModel(ctx, args),
});

export const revokeProviderAccessGrant = mutation({
  args: { grantId: v.id('providerAccessGrants') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await revokeProviderAccessGrantModel(ctx, args.grantId);
    return null;
  },
});
