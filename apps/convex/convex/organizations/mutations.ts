import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { roleValidator } from '../validators';
import {
  addMember as addMemberModel,
  changeMemberRole as changeMemberRoleModel,
  createOrganization as createOrganizationModel,
  removeMember as removeMemberModel,
  updateOrganization as updateOrganizationModel,
} from './model';

export const createOrganization = mutation({
  args: { name: v.string(), slug: v.string() },
  returns: v.id('organizations'),
  handler: (ctx, args) => createOrganizationModel(ctx, args),
});

export const updateOrganization = mutation({
  args: { organizationId: v.id('organizations'), name: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateOrganizationModel(ctx, args);
    return null;
  },
});

export const addMember = mutation({
  args: { organizationId: v.id('organizations'), userId: v.id('users'), role: roleValidator },
  returns: v.id('organizationMemberships'),
  handler: (ctx, args) => addMemberModel(ctx, args),
});

export const changeMemberRole = mutation({
  args: { membershipId: v.id('organizationMemberships'), role: roleValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await changeMemberRoleModel(ctx, args);
    return null;
  },
});

export const removeMember = mutation({
  args: { membershipId: v.id('organizationMemberships') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await removeMemberModel(ctx, args.membershipId);
    return null;
  },
});
