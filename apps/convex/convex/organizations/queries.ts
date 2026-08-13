import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { paginatedResult, roleValidator } from '../validators';
import {
  getOrganization as getOrganizationModel,
  listMembers as listMembersModel,
  listMyOrganizations as listMyOrganizationsModel,
} from './model';

const organizationValidator = v.object({
  _id: v.id('organizations'),
  _creationTime: v.number(),
  name: v.string(),
  slug: v.string(),
});

const membershipValidator = v.object({
  _id: v.id('organizationMemberships'),
  _creationTime: v.number(),
  organizationId: v.id('organizations'),
  userId: v.id('users'),
  role: roleValidator,
});

const displayUserValidator = v.object({
  _id: v.id('users'),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
});

export const getOrganization = query({
  args: { organizationId: v.id('organizations') },
  returns: organizationValidator,
  handler: (ctx, args) => getOrganizationModel(ctx, args.organizationId),
});

export const listMyOrganizations = query({
  args: {},
  returns: v.array(v.object({ organization: organizationValidator, role: membershipValidator.fields.role })),
  handler: (ctx) => listMyOrganizationsModel(ctx),
});

export const listMembers = query({
  args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(v.object({ membership: membershipValidator, user: displayUserValidator })),
  handler: (ctx, args) => listMembersModel(ctx, args.organizationId, args.paginationOpts),
});
