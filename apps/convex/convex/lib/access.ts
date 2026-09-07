import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { getAuthenticatedIdentity, type AuthenticatedIdentity } from './authAdapter';
import { notFoundOrInaccessible, unauthenticated } from './errors';
import { roleAtLeast, type Role } from './roles';

type UserAccessContext = Pick<QueryCtx, 'auth' | 'db'> | Pick<MutationCtx, 'auth' | 'db'>;

export type AuthenticatedUser = {
  identity: AuthenticatedIdentity;
  user: Doc<'users'>;
};

/**
 * Resolves the first links in the I1 access chain. Callers must invoke
 * `ensureUser` before operations requiring an app user.
 */
export async function requireAuthenticatedUser(ctx: UserAccessContext): Promise<AuthenticatedUser> {
  const identity = await getAuthenticatedIdentity(ctx);
  if (identity === null) {
    return unauthenticated();
  }

  const user = await ctx.db
    .query('users')
    .withIndex('by_provider_subject', (q) =>
      q.eq('authProvider', identity.provider).eq('authSubject', identity.subject),
    )
    .unique();
  if (user === null) {
    return notFoundOrInaccessible();
  }

  return { identity, user };
}

export type OrganizationMembershipAccess = AuthenticatedUser & {
  membership: Doc<'organizationMemberships'>;
  organization: Doc<'organizations'>;
};

/**
 * Proves the complete identity → user → membership → organization access chain.
 *
 * `preResolvedUser` lets a caller that already proved identity → app user in the
 * same transaction (e.g. after an I9-ordered `ctx.db.get`) reuse that result
 * instead of resolving the user twice. It can only be produced by
 * `requireAuthenticatedUser`, so passing it skips no check; omitting it keeps
 * the original two-argument behaviour.
 */
export async function requireOrganizationMembership(
  ctx: UserAccessContext,
  organizationId: Id<'organizations'>,
  preResolvedUser?: AuthenticatedUser,
): Promise<OrganizationMembershipAccess> {
  const authenticated = preResolvedUser ?? (await requireAuthenticatedUser(ctx));
  const membership = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', authenticated.user._id))
    .unique();
  if (membership === null) {
    return notFoundOrInaccessible();
  }

  const organization = await ctx.db.get(organizationId);
  if (organization === null) {
    return notFoundOrInaccessible();
  }

  return { ...authenticated, membership, organization };
}

/** Requires an organization membership meeting the operation's minimum role. */
export async function requireOrganizationRole(
  ctx: UserAccessContext,
  organizationId: Id<'organizations'>,
  minimumRole: Role,
  preResolvedUser?: AuthenticatedUser,
): Promise<OrganizationMembershipAccess> {
  const access = await requireOrganizationMembership(ctx, organizationId, preResolvedUser);
  if (!roleAtLeast(access.membership.role, minimumRole)) {
    return notFoundOrInaccessible();
  }
  return access;
}

/** Viewer-or-higher organization access, named for readable call sites. */
export function requireOrganizationAccess(
  ctx: UserAccessContext,
  organizationId: Id<'organizations'>,
): Promise<OrganizationMembershipAccess> {
  return requireOrganizationMembership(ctx, organizationId);
}

/**
 * Proves that a user OTHER than the caller is a current member of the
 * organization. Used by writers that store a user reference on a tenant row
 * (`events.accountableUserId`), so such a column can never be SET to a
 * stranger or to a member of another tenant.
 *
 * Like `assertUsableLocation`, this is a write-time rule, not a stored
 * constraint: a membership removed afterwards leaves the stored id in place as
 * the true record of who was accountable at the time. Nothing dangles, because
 * `users` rows are never deleted. Guarding removal instead would make access
 * revocation refusable, which it must never be.
 *
 * It lives beside the caller-facing chain helpers because it reads the same
 * `by_org_user` membership edge — but it proves nothing about the caller and
 * grants nothing: authorization for the operation must already have been
 * established through `requireOrganizationRole` before this is reached.
 *
 * Failure is always the generic error: the user id arrives from the caller, so
 * "no such user" and "not a member here" must be indistinguishable or the
 * column becomes a directory probe (I1/I9).
 */
export async function assertCurrentMember(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  userId: Id<'users'>,
  organizationId: Id<'organizations'>,
): Promise<Doc<'organizationMemberships'>> {
  const membership = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', userId))
    .unique();
  if (membership === null) {
    return notFoundOrInaccessible();
  }
  return membership;
}
