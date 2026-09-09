import type { PaginationOptions, PaginationResult } from 'convex/server';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { ensureBuiltinFieldDefinitions } from '../fields/builtins';
import {
  requireAuthenticatedUser,
  requireOrganizationAccess,
  requireOrganizationMembership,
  requireOrganizationRole,
} from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { validateEntityName } from '../lib/names';
import { canAssignRole, isOwner, type Role } from '../lib/roles';
import { provisionStarterServiceKinds } from '../serviceKinds/builtins';
import { provisionStarterVehicleClasses } from '../vehicles/builtins';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const minSlugLength = 3;
const maxSlugLength = 63;

export function validateOrganizationSlug(slug: string): void {
  if (slug.length < minSlugLength || slug.length > maxSlugLength || !slugPattern.test(slug)) {
    return invalidInput('organizationSlugInvalid', 'Invalid organization slug');
  }
}

/** Returns the trimmed name; callers store what they get back, never the raw argument. */
export function validateOrganizationName(name: string): string {
  return validateEntityName(name, 'organization');
}

export async function createOrganization(
  ctx: MutationCtx,
  args: { name: string; slug: string },
): Promise<Id<'organizations'>> {
  const { user } = await requireAuthenticatedUser(ctx);
  validateOrganizationSlug(args.slug);
  const name = validateOrganizationName(args.name);

  // Indexed read-before-write is race-safe under Convex serializable OCC (§10).
  // Note: slugs are a deployment-wide namespace, so a conflict necessarily
  // signals that some tenant owns the slug — documented in README.
  const existing = await ctx.db
    .query('organizations')
    .withIndex('by_slug', (q) => q.eq('slug', args.slug))
    .unique();
  if (existing !== null) {
    return conflict();
  }

  const organizationId = await ctx.db.insert('organizations', {
    name,
    slug: args.slug,
  });
  const membershipId = await ctx.db.insert('organizationMemberships', {
    organizationId,
    userId: user._id,
    role: 'owner',
  });
  await recordAuditEvent(ctx, {
    organizationId,
    actorUserId: user._id,
    action: 'organization.created',
    entityType: 'organization',
    entityId: organizationId,
    metadata: { slug: args.slug },
  });
  await recordAuditEvent(ctx, {
    organizationId,
    actorUserId: user._id,
    action: 'membership.created',
    entityType: 'membership',
    entityId: membershipId,
    metadata: { role: 'owner' },
  });
  // The membership exists before composition begins, so every field and serviceKind
  // model proves the new owner's ordinary role rather than receiving a bootstrap
  // exception. Keeping this in the creation transaction means no organization
  // can ever commit without its usable starter configuration.
  const fieldIds = await ensureBuiltinFieldDefinitions(ctx);
  await provisionStarterServiceKinds(ctx, organizationId, fieldIds);
  await provisionStarterVehicleClasses(ctx, organizationId);
  return organizationId;
}

export async function getOrganization(ctx: QueryCtx, organizationId: Id<'organizations'>): Promise<Doc<'organizations'>> {
  const { organization } = await requireOrganizationMembership(ctx, organizationId);
  return organization;
}

export async function updateOrganization(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; name?: string },
): Promise<void> {
  const { user } = await requireOrganizationRole(ctx, args.organizationId, 'admin');
  // Slugs are deliberately immutable until a dedicated rename policy exists.
  if (args.name === undefined) {
    return;
  }
  const name = validateOrganizationName(args.name);
  await ctx.db.patch(args.organizationId, { name });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: user._id,
    action: 'organization.updated',
    entityType: 'organization',
    entityId: args.organizationId,
    metadata: { name },
  });
}

export async function listMyOrganizations(ctx: QueryCtx): Promise<Array<{ organization: Doc<'organizations'>; role: Role }>> {
  const { user } = await requireAuthenticatedUser(ctx);
  // Bounded by a single user's organization memberships.
  const memberships = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_user', (q) => q.eq('userId', user._id))
    .collect();
  const organizations = await Promise.all(
    memberships.map(async (membership) => {
      const organization = await ctx.db.get(membership.organizationId);
      if (organization === null) {
        return notFoundOrInaccessible();
      }
      return { organization, role: membership.role };
    }),
  );
  return organizations;
}

/**
 * NOTE (issue #56 follow-up): the user-facing path is now
 * `invitations.createInvitation` → `invitations.acceptInvitation`
 * (`invitations/model.ts`), which is addressed to an email and requires the
 * recipient's own consent. This function still attaches an existing user id
 * directly with no consent step, so it stays deliberately public for internal
 * bootstrap (seeds) and the ~70 existing test fixtures across every other
 * domain's test suite that provision memberships this way — migrating all of
 * them to route through invitations belongs to a dedicated follow-up, not
 * this issue. Documented on #18 item 1 and `docs/deviations.md`; no product
 * surface calls this anymore.
 */
export async function addMember(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; userId: Id<'users'>; role: Role },
): Promise<Id<'organizationMemberships'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, 'admin');
  if (!canAssignRole(access.membership.role, undefined, args.role)) {
    return notFoundOrInaccessible();
  }
  const targetUser = await ctx.db.get(args.userId);
  if (targetUser === null) {
    return notFoundOrInaccessible();
  }
  const existing = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_org_user', (q) => q.eq('organizationId', args.organizationId).eq('userId', args.userId))
    .unique();
  if (existing !== null) {
    return conflict();
  }
  const membershipId = await ctx.db.insert('organizationMemberships', {
    organizationId: args.organizationId,
    userId: args.userId,
    role: args.role,
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'membership.created',
    entityType: 'membership',
    entityId: membershipId,
    metadata: { role: args.role },
  });
  return membershipId;
}

export async function changeMemberRole(
  ctx: MutationCtx,
  args: { membershipId: Id<'organizationMemberships'>; role: Role },
): Promise<void> {
  // Authenticate before touching the membership id so unauthenticated probes
  // cannot distinguish real from fabricated ids (I9).
  await requireAuthenticatedUser(ctx);
  const membership = await ctx.db.get(args.membershipId);
  if (membership === null) {
    return notFoundOrInaccessible();
  }
  const access = await requireOrganizationRole(ctx, membership.organizationId, 'admin');
  if (!canAssignRole(access.membership.role, membership.role, args.role)) {
    return notFoundOrInaccessible();
  }
  if (isOwner(membership.role) && !isOwner(args.role)) {
    await requireAnotherOwner(ctx, membership.organizationId, membership._id);
  }
  const previousRole = membership.role;
  await ctx.db.patch(membership._id, { role: args.role });
  await recordAuditEvent(ctx, {
    organizationId: membership.organizationId,
    actorUserId: access.user._id,
    action: 'membership.updated',
    entityType: 'membership',
    entityId: membership._id,
    metadata: { previousRole, role: args.role },
  });
}

export async function removeMember(ctx: MutationCtx, membershipId: Id<'organizationMemberships'>): Promise<void> {
  // Same I9 ordering as changeMemberRole: authenticate before the id lookup.
  await requireAuthenticatedUser(ctx);
  const membership = await ctx.db.get(membershipId);
  if (membership === null) {
    return notFoundOrInaccessible();
  }
  const access = await requireOrganizationRole(ctx, membership.organizationId, 'admin');
  if (!canAssignRole(access.membership.role, membership.role, undefined)) {
    return notFoundOrInaccessible();
  }
  if (isOwner(membership.role)) {
    await requireAnotherOwner(ctx, membership.organizationId, membership._id);
  }
  // Removal is deliberately NOT guarded by `events.accountableUserId`.
  // Membership is the only principal arm today, so this is the tenant's only
  // access-revocation path, and a data-dependent refusal would make revocation
  // impossible rather than merely inconvenient: `archiveProject` is terminal
  // and freezes every Event write beneath it, so an Event naming a departing
  // member under an archived Project could never be reassigned, never be
  // deleted, and would pin that member's access forever.
  //
  // Instead `accountableUserId` follows the same rule as every other stored
  // reference here (see `assertUsableLocation`): it is proven at WRITE time and
  // the stored value survives afterwards. Nothing dangles — `users` rows are
  // never deleted — and an archived Event keeps the true record of who was
  // accountable while it ran. The one thing a former member cannot be is
  // newly assigned, which `assertCurrentMember` enforces on every write.
  await ctx.db.delete(membership._id);
  await recordAuditEvent(ctx, {
    organizationId: membership.organizationId,
    actorUserId: access.user._id,
    action: 'membership.removed',
    entityType: 'membership',
    entityId: membership._id,
    metadata: { previousRole: membership.role },
  });
}

export type MemberListEntry = {
  membership: Doc<'organizationMemberships'>;
  user: { _id: Id<'users'>; name?: string; email?: string };
};

export async function listMembers(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<MemberListEntry>> {
  await requireOrganizationAccess(ctx, organizationId);
  // Paginated: membership rosters grow with the tenant (I6).
  const page = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId))
    .paginate(paginationOpts);
  const entries = await Promise.all(
    page.page.map(async (membership): Promise<MemberListEntry> => {
      const user = await ctx.db.get(membership.userId);
      if (user === null) {
        return notFoundOrInaccessible();
      }
      return {
        membership,
        user: {
          _id: user._id,
          ...(user.name === undefined ? {} : { name: user.name }),
          ...(user.email === undefined ? {} : { email: user.email }),
        },
      };
    }),
  );
  return { ...page, page: entries };
}

async function requireAnotherOwner(
  ctx: MutationCtx,
  organizationId: Id<'organizations'>,
  changingMembershipId: Id<'organizationMemberships'>,
): Promise<void> {
  // Reachable only by owners (canAssignRole gate), so conflict() here never
  // leaks to non-members. Membership sets are read via the org's index prefix;
  // the full-prefix read also makes concurrent owner-removals OCC-conflict.
  const memberships = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId))
    .collect();
  const hasAnotherOwner = memberships.some(
    (membership) => membership._id !== changingMembershipId && isOwner(membership.role),
  );
  if (!hasAnotherOwner) {
    return conflict();
  }
}
