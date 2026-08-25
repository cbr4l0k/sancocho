import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { invitationStatusValidator, organizationInvitationDocValidator, paginatedResult, roleValidator } from '../validators';
import { listMyPendingInvitations as listMyPendingInvitationsModel, listPendingInvitations as listPendingInvitationsModel } from './model';

export const listPendingInvitations = query({
  args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(organizationInvitationDocValidator),
  handler: (ctx, args) => listPendingInvitationsModel(ctx, args.organizationId, args.paginationOpts),
});

const organizationSummaryValidator = v.object({
  _id: v.id('organizations'),
  name: v.string(),
});

// Deliberately narrower than `organizationInvitationDocValidator`:
// `organizationId` is redundant with `organization` below, and
// `invitedByUserId` is a `users` id from an org this caller does not belong
// to — model.ts's `MyPendingInvitation` projects the same shape (I9).
const myPendingInvitationValidator = v.object({
  _id: v.id('organizationInvitations'),
  _creationTime: v.number(),
  email: v.string(),
  role: roleValidator,
  status: invitationStatusValidator,
  expiresAt: v.number(),
});

export const listMyPendingInvitations = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginatedResult(
    v.object({ invitation: myPendingInvitationValidator, organization: organizationSummaryValidator }),
  ),
  handler: (ctx, args) => listMyPendingInvitationsModel(ctx, args.paginationOpts),
});
