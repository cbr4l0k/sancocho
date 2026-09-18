import type { UserIdentity } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';

/**
 * The single definition of *whose authority* a seed writes under.
 *
 * This is the most security-sensitive primitive in `seed/`: every domain write
 * a seed performs runs through the models' ordinary authentication, role and
 * ownership checks, and this is what those checks resolve the caller from. It
 * lives in one file precisely so a future tightening (refusing a stale
 * membership, refusing the synthetic demonstration owner) cannot be applied to
 * one seed and silently missed in another.
 *
 * The context is rebuilt member by member rather than spread from `ctx`: a
 * shallow spread copies only own enumerable properties, so anything the runtime
 * exposes through a prototype or accessor would be dropped. Listing the members
 * makes the compiler fail if `MutationCtx` ever grows one.
 */
function seedContext(ctx: MutationCtx, identity: UserIdentity): MutationCtx {
  return {
    db: ctx.db,
    auth: { getUserIdentity: async () => identity },
    storage: ctx.storage,
    scheduler: ctx.scheduler,
    runQuery: ctx.runQuery,
    runMutation: ctx.runMutation,
    meta: ctx.meta,
  };
}

/**
 * Borrows the authority of an ALREADY-STORED owner, resolved from the
 * membership rows.
 *
 * This deliberately carries NO email, and the omission is load-bearing rather
 * than an oversight. `ensureAuthenticatedUser` does not merely read an
 * identity's address: when the identity reports one as verified and it differs
 * from the stored column, it PATCHES `users.email`. That column is the
 * acceptance key for both invitation arms, so asserting an address on top of a
 * real human's identity would silently move which pending invitations — an
 * organization membership at any role, or a Provider claim — that person can
 * accept, and which they can no longer accept. Capability would then come from
 * something other than a stored membership or grant, which is exactly what I1
 * forbids.
 *
 * A seed that needs an address asserts it on an identity it INVENTS, through
 * `withSeedAuthoredIdentity` below. Keeping the two apart makes the dangerous
 * combination unspellable instead of merely discouraged.
 */
export function withOwnerIdentity(ctx: MutationCtx, issuer: string, subject: string): MutationCtx {
  return seedContext(ctx, { tokenIdentifier: `${issuer}|${subject}`, issuer, subject });
}

/**
 * Builds a context for an identity the SEED ITSELF authors — a demonstration
 * provider firm's owner, say — rather than one belonging to an existing person.
 *
 * A supplied email is asserted as verified because these are internal entry
 * points behind `assertSeedingEnabled()`, run by whoever administers the
 * deployment: the assertion is theirs, not a caller-claimed address arriving
 * through a public door. `seed/mutations.ts:withSeedIdentity` states the same
 * rule for the demonstration owner.
 *
 * Safe here precisely because the `(issuer, subject)` pair is one the seed
 * minted: a first run creates that user row with this address, and a re-run
 * re-asserts the identical address, so the patch described above is a no-op.
 * Never pass a pair belonging to a real person.
 */
export function withSeedAuthoredIdentity(
  ctx: MutationCtx,
  authored: { issuer: string; subject: string; email?: string },
): MutationCtx {
  return seedContext(ctx, {
    tokenIdentifier: `${authored.issuer}|${authored.subject}`,
    issuer: authored.issuer,
    subject: authored.subject,
    ...(authored.email === undefined ? {} : { email: authored.email, emailVerified: true }),
  });
}

/**
 * Resolves the organization named by `slug` and returns a context authenticated
 * as its own owner. A seed therefore adds no parallel write path: it borrows an
 * existing member's authority rather than bypassing authorization, and an
 * organization with no owner membership cannot be seeded at all.
 *
 * `ownerUserId` is the same user the context authenticates as, returned so a
 * seed can name them (Event accountable, and similar) without re-querying
 * memberships.
 */
export async function resolveSeedOwnerContext(
  ctx: MutationCtx,
  organizationSlug: string,
): Promise<{ organization: Doc<'organizations'>; ownerUserId: Id<'users'>; seeded: MutationCtx }> {
  const organization = await ctx.db
    .query('organizations')
    .withIndex('by_slug', (q) => q.eq('slug', organizationSlug))
    .unique();
  if (organization === null) {
    return invalidInput('seedOrganizationMissing', `No organization has the slug ${organizationSlug}`);
  }

  // Bounded, internal-only administrative read: a demonstration tenant's
  // membership list, never a public tenant read (I6 governs those).
  const memberships = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_org_user', (q) => q.eq('organizationId', organization._id))
    .collect();
  const ownerMembership = memberships.find((membership) => membership.role === 'owner');
  if (ownerMembership === undefined) {
    return invalidInput('seedOrganizationOwnerMissing', 'The organization has no owner to seed as');
  }
  const owner = await ctx.db.get(ownerMembership.userId);
  if (owner === null) return notFoundOrInaccessible();

  return {
    organization,
    ownerUserId: owner._id,
    seeded: withOwnerIdentity(ctx, owner.authProvider, owner.authSubject),
  };
}
