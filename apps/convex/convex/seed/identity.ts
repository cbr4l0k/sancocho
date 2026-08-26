import type { UserIdentity } from 'convex/server';

import type { Doc } from '../_generated/dataModel';
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
export function withOwnerIdentity(ctx: MutationCtx, issuer: string, subject: string): MutationCtx {
  const identity: UserIdentity = { tokenIdentifier: `${issuer}|${subject}`, issuer, subject };
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
 * Resolves the organization named by `slug` and returns a context authenticated
 * as its own owner. A seed therefore adds no parallel write path: it borrows an
 * existing member's authority rather than bypassing authorization, and an
 * organization with no owner membership cannot be seeded at all.
 */
export async function resolveSeedOwnerContext(
  ctx: MutationCtx,
  organizationSlug: string,
): Promise<{ organization: Doc<'organizations'>; seeded: MutationCtx }> {
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

  return { organization, seeded: withOwnerIdentity(ctx, owner.authProvider, owner.authSubject) };
}
