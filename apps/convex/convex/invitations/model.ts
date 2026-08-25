import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { requireAuthenticatedUser, requireOrganizationRole } from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { canAssignRole, type Role } from '../lib/roles';

/**
 * Invitations are addressed to an email, never to a user id, and nothing is
 * ever looked up by address (I9): inviting an address that has an account is
 * indistinguishable from inviting one that doesn't. Consent lives in
 * acceptance — a membership is only ever created inside `acceptInvitation`,
 * by the recipient authenticated as themselves.
 */

const invitationTtlMs = 14 * 24 * 60 * 60 * 1000;
const maxInvitationEmailLength = 254; // RFC 5321 mailbox length ceiling.
const invitationEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trims and lowercases an address for comparison. `users.email` is stored
 * verbatim from the provider's claim (auth/model.ts) with no normalization —
 * this is the one place both sides of an invitation match get folded to the
 * same case, so a mixed-case IdP claim (`Jane.Doe@Example.com`) still finds
 * and can still accept an invitation stored lowercase.
 */
function normalizeEmailForComparison(email: string): string {
  return email.trim().toLowerCase();
}

/** Normalizes, then checks a pragmatic shape for the caller's OWN input (I9: message may be specific). */
function normalizeInvitationEmail(email: string): string {
  const normalized = normalizeEmailForComparison(email);
  if (
    normalized.length === 0 ||
    normalized.length > maxInvitationEmailLength ||
    !invitationEmailPattern.test(normalized)
  ) {
    return invalidInput('invitationEmailInvalid', 'Invalid invitation email');
  }
  return normalized;
}

export async function createInvitation(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; email: string; role: Role },
): Promise<Id<'organizationInvitations'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, 'admin');
  // Same ownership policy as addMember/changeMemberRole: an admin may invite
  // anyone except as owner (canAssignRole is the single statement of that rule).
  if (!canAssignRole(access.membership.role, undefined, args.role)) {
    return notFoundOrInaccessible();
  }
  const email = normalizeInvitationEmail(args.email);

  // Indexed read-before-write on (org, email, status) — race-safe under
  // Convex serializable OCC, same idiom as every other uniqueness check.
  const existing = await ctx.db
    .query('organizationInvitations')
    .withIndex('by_org_email_status', (q) =>
      q.eq('organizationId', args.organizationId).eq('email', email).eq('status', 'pending'),
    )
    .unique();
  if (existing !== null) {
    // A `pending` row past its own `expiresAt` is effectively expired (see
    // the note on `invitationStatusValidator`), but nothing has settled its
    // stored status yet — `acceptInvitation` can't (a throwing mutation
    // rolls back its own writes) and there is no cron sweep. This call path
    // doesn't throw afterward, so it CAN durably settle it: free the address
    // up rather than reporting a conflict against a dead row the admin has
    // no way to see or clear.
    if (existing.expiresAt <= Date.now()) {
      await ctx.db.patch(existing._id, { status: 'expired' });
    } else {
      return conflict();
    }
  }

  const invitationId = await ctx.db.insert('organizationInvitations', {
    organizationId: args.organizationId,
    email,
    role: args.role,
    status: 'pending',
    invitedByUserId: access.user._id,
    expiresAt: Date.now() + invitationTtlMs,
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'invitation.created',
    entityType: 'invitation',
    entityId: invitationId,
    metadata: { role: args.role },
  });
  return invitationId;
}

export async function revokeInvitation(ctx: MutationCtx, invitationId: Id<'organizationInvitations'>): Promise<void> {
  // Authenticate before the id lookup, same I9 ordering as changeMemberRole /
  // removeMember: an unauthenticated caller must not be able to distinguish a
  // real invitation id from a fabricated one.
  const authenticated = await requireAuthenticatedUser(ctx);
  const invitation = await ctx.db.get(invitationId);
  if (invitation === null) {
    return notFoundOrInaccessible();
  }
  // Membership in the invitation's OWN organization is proven next — an
  // invitation belonging to a foreign org fails here with the same generic
  // error as a fabricated id, whether or not the caller is an admin anywhere
  // else (I9). `preResolvedUser` reuses the identity already proven above
  // instead of resolving it a second time (lib/access.ts).
  const access = await requireOrganizationRole(ctx, invitation.organizationId, 'admin', authenticated);
  if (invitation.status !== 'pending') {
    return invalidInput('invitationNotPending', 'Invitation is no longer pending');
  }
  await ctx.db.patch(invitation._id, { status: 'revoked' });
  await recordAuditEvent(ctx, {
    organizationId: invitation.organizationId,
    actorUserId: access.user._id,
    action: 'invitation.revoked',
    entityType: 'invitation',
    entityId: invitation._id,
    metadata: { previousStatus: invitation.status, status: 'revoked' },
  });
}

export async function acceptInvitation(
  ctx: MutationCtx,
  invitationId: Id<'organizationInvitations'>,
): Promise<Id<'organizationMemberships'>> {
  const { user } = await requireAuthenticatedUser(ctx);
  const invitation = await ctx.db.get(invitationId);
  if (invitation === null) {
    return notFoundOrInaccessible();
  }
  // The recipient check comes before anything about the invitation's own
  // lifecycle state (I9): a caller who is not the addressee learns nothing at
  // all — not the organization, not the role, not whether it has expired or
  // was revoked. `user.email` is only ever a provider-verified address
  // (auth/model.ts), so this comparison can never be spoofed by an unverified
  // claim.
  const callerEmail = user.email;
  if (callerEmail === undefined || normalizeEmailForComparison(callerEmail) !== invitation.email) {
    return notFoundOrInaccessible();
  }

  if (invitation.status === 'revoked' || invitation.status === 'accepted') {
    return invalidInput('invitationNotPending', 'Invitation is no longer pending');
  }
  if (invitation.status === 'expired' || invitation.expiresAt <= Date.now()) {
    // A Convex mutation is one atomic transaction: a write made here would be
    // rolled back by the throw below, so an expired-but-still-`pending` row
    // stays stored as `pending` — this check reads `expiresAt` directly
    // rather than relying on a `status` a throwing call could never persist.
    // There is no cron sweep to settle it either (I8: no scheduled workflow
    // machinery for this). Callers that list invitations must compute
    // "effectively expired" from `expiresAt` themselves, the same way this
    // check does.
    return invalidInput('invitationExpired', 'Invitation has expired');
  }

  // Guards against the same membership being created twice: once by this
  // accept and once more by a concurrent retry (Convex OCC replays the
  // loser's read against the winner's write) or by an admin who separately
  // added this user directly. Same indexed check and same `conflict()` as
  // `addMember`.
  const existingMembership = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_org_user', (q) => q.eq('organizationId', invitation.organizationId).eq('userId', user._id))
    .unique();
  if (existingMembership !== null) {
    return conflict();
  }

  const membershipId = await ctx.db.insert('organizationMemberships', {
    organizationId: invitation.organizationId,
    userId: user._id,
    role: invitation.role,
  });
  await ctx.db.patch(invitation._id, { status: 'accepted' });
  await recordAuditEvent(ctx, {
    organizationId: invitation.organizationId,
    actorUserId: user._id,
    action: 'membership.created',
    entityType: 'membership',
    entityId: membershipId,
    metadata: { role: invitation.role },
  });
  await recordAuditEvent(ctx, {
    organizationId: invitation.organizationId,
    actorUserId: user._id,
    action: 'invitation.accepted',
    entityType: 'invitation',
    entityId: invitation._id,
    metadata: { previousStatus: 'pending', status: 'accepted' },
  });
  return membershipId;
}

export async function listPendingInvitations(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<Doc<'organizationInvitations'>>> {
  await requireOrganizationRole(ctx, organizationId, 'admin');
  return ctx.db
    .query('organizationInvitations')
    .withIndex('by_org_status', (q) => q.eq('organizationId', organizationId).eq('status', 'pending'))
    .order('desc')
    .paginate(paginationOpts);
}

/**
 * Deliberately narrower than the stored row: `organizationId` is redundant
 * with `organization` below, and `invitedByUserId` is a `users` id from an
 * organization this caller does not (yet) belong to — nothing they need to
 * see, and not disclosed just because the doc validator happened to include
 * it (I9: minimal, deliberate disclosure, not "whatever the table has").
 */
export type MyPendingInvitation = {
  _id: Id<'organizationInvitations'>;
  _creationTime: number;
  email: string;
  role: Role;
  status: Doc<'organizationInvitations'>['status'];
  expiresAt: number;
};

export type MyPendingInvitationEntry = {
  invitation: MyPendingInvitation;
  organization: { _id: Id<'organizations'>; name: string };
};

/**
 * The one deliberate disclosure this domain makes: an invitation names the
 * inviting organization to the exact address it was addressed to. That is
 * the point of an invite, not a leak — the admin who created it already chose
 * to reveal the organization to this address.
 */
export async function listMyPendingInvitations(
  ctx: QueryCtx,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<MyPendingInvitationEntry>> {
  const { user } = await requireAuthenticatedUser(ctx);
  if (user.email === undefined) {
    // No provider-verified email on file: nothing can be addressed to this
    // caller, so there is nothing to look up.
    return { page: [], isDone: true, continueCursor: '' };
  }
  // `users.email` is stored verbatim from the provider claim (no
  // normalization in auth/model.ts); fold to the same case the stored
  // invitation address uses so a mixed-case IdP claim still matches.
  const email = normalizeEmailForComparison(user.email);
  const page = await ctx.db
    .query('organizationInvitations')
    .withIndex('by_email_status', (q) => q.eq('email', email).eq('status', 'pending'))
    .order('desc')
    .paginate(paginationOpts);
  const entries = await Promise.all(
    page.page.map(async (invitation): Promise<MyPendingInvitationEntry> => {
      const organization = await ctx.db.get(invitation.organizationId);
      if (organization === null) {
        return notFoundOrInaccessible();
      }
      return {
        invitation: {
          _id: invitation._id,
          _creationTime: invitation._creationTime,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
        },
        organization: { _id: organization._id, name: organization.name },
      };
    }),
  );
  return { ...page, page: entries };
}
