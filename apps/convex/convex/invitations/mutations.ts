import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { roleValidator } from '../validators';
import {
  acceptInvitation as acceptInvitationModel,
  createInvitation as createInvitationModel,
  revokeInvitation as revokeInvitationModel,
} from './model';

export const createInvitation = mutation({
  args: { organizationId: v.id('organizations'), email: v.string(), role: roleValidator },
  returns: v.id('organizationInvitations'),
  handler: (ctx, args) => createInvitationModel(ctx, args),
});

export const revokeInvitation = mutation({
  args: { invitationId: v.id('organizationInvitations') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await revokeInvitationModel(ctx, args.invitationId);
    return null;
  },
});

export const acceptInvitation = mutation({
  args: { invitationId: v.id('organizationInvitations') },
  returns: v.id('organizationMemberships'),
  handler: (ctx, args) => acceptInvitationModel(ctx, args.invitationId),
});
