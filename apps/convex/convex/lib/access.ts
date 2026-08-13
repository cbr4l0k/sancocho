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

/** Proves the complete identity → user → membership → organization access chain. */
export async function requireOrganizationMembership(
  ctx: UserAccessContext,
  organizationId: Id<'organizations'>,
): Promise<OrganizationMembershipAccess> {
  const authenticated = await requireAuthenticatedUser(ctx);
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
): Promise<OrganizationMembershipAccess> {
  const access = await requireOrganizationMembership(ctx, organizationId);
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
