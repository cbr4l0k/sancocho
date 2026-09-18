import { ConvexError, v } from 'convex/values';

import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { counterAssignmentRevision } from '../assignments/model';
import { ensureAuthenticatedUser } from '../auth/model';
import { invalidInput } from '../lib/errors';
import { normalizeSearchText } from '../lib/search';
import { assertSeedingEnabled } from '../lib/seedGuard';
import { createOrganization } from '../organizations/model';
import { grantProjectAccessToProvider, listProjectProviderAccessGrants } from '../providers/grants';
import { claimProviderOrganization, inviteProviderOrganization } from '../providers/model';
import { resolveSeedOwnerContext, withSeedAuthoredIdentity } from './identity';

/**
 * Completes the Cordillera supply half with the second principal arm.
 *
 * `seed/cordillera.ts` writes coordinator-owned Provider *rows*. `/portal/dispatch`
 * renders for a Provider *principal*, which `lib/access.ts` only resolves from a
 * claimed Organization holding an active `providerAccessGrants` row. An unclaimed
 * directory row is refused at grant time (`providerGrantRequiresClaim`), so this
 * seed walks the public invite → claim → grant handshake rather than patching
 * `linkedOrganizationId`.
 *
 * A counter is authored here for the same reason: `counterAssignmentRevision`
 * refuses any principal but the Provider arm, and every Cordillera call is the
 * coordinator owner.
 *
 * Identities are minted through `withSeedAuthoredIdentity`, never
 * `withOwnerIdentity`. `ensureAuthenticatedUser` PATCHes `users.email` when a
 * verified address disagrees with the stored column; asserting a Provider
 * contact address on top of a real stored human would silently move which
 * pending invitations that person can accept.
 */

const providerSeedIssuer = 'https://seed.priamo.internal';
const defaultProjectName = 'Cordillera 2026';

const providerFirms: readonly {
  name: string;
  slug: string;
  grantProjectAccess: boolean;
}[] = [
  { name: 'Transportes Andes SAS', slug: 'transportes-andes', grantProjectAccess: true },
  // Rutas del Altiplano gets an Organization and a claim but deliberately NO
  // grant. The portal's refusal of that firm is the negative case that proves
  // the grant — not the Provider row, not the claim — is what admits a
  // principal. Do not "fix" this by granting both.
  { name: 'Rutas del Altiplano SAS', slug: 'rutas-altiplano', grantProjectAccess: false },
];

function isConflictError(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return false;
  return data.code === 'conflict';
}

async function requireProviderByName(
  ctx: MutationCtx,
  organizationId: Id<'organizations'>,
  name: string,
): Promise<Doc<'providers'>> {
  const existing = await ctx.db
    .query('providers')
    .withIndex('by_org_searchText', (q) =>
      q.eq('organizationId', organizationId).eq('searchText', normalizeSearchText(name)),
    )
    .first();
  if (existing === null) {
    return invalidInput('seedProviderConflict', `Seed provider is missing: ${name}`);
  }
  return existing;
}

async function requireProjectByName(
  ctx: MutationCtx,
  organizationId: Id<'organizations'>,
  projectName: string,
): Promise<Doc<'projects'>> {
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
    .collect();
  const project = projects.find((row) => row.name === projectName);
  if (project === undefined) {
    return invalidInput('seedServiceMissing', `Seed project is missing: ${projectName}`);
  }
  return project;
}

async function hasActiveProjectGrant(
  ctx: MutationCtx,
  projectId: Id<'projects'>,
  providerId: Id<'providers'>,
): Promise<boolean> {
  // Listed through the grants module rather than `providerAccessGrants`
  // directly: `tests/providerAccess.test.ts` pins readers of that table to
  // exactly `lib/access.ts` and `providers/grants.ts`.
  let cursor: string | null = null;
  for (;;) {
    const page = await listProjectProviderAccessGrants(ctx, {
      projectId,
      paginationOpts: { numItems: 100, cursor },
    });
    if (page.page.some((grant) => grant.providerId === providerId && grant.status === 'active')) {
      return true;
    }
    if (page.isDone) return false;
    cursor = page.continueCursor;
  }
}

async function findAndesCounterTarget(
  ctx: MutationCtx,
  projectId: Id<'projects'>,
  providerId: Id<'providers'>,
): Promise<Doc<'assignmentRevisions'> | null> {
  const assignments = await ctx.db
    .query('assignments')
    .withIndex('by_project_position', (q) => q.eq('projectId', projectId))
    .collect();
  for (const assignment of assignments) {
    // A counter is Provider-arm only and is scoped to the assignment's own
    // firm, so only Andes rows are eligible — Altiplano has no grant.
    if (assignment.providerId !== providerId) continue;
    const service = await ctx.db.get(assignment.serviceId);
    if (service === null || service.status !== 'planned') continue;
    const revisions = await ctx.db
      .query('assignmentRevisions')
      .withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id))
      .collect();
    if (revisions.some((revision) => revision.proposedOnBehalfOfProviderId !== undefined)) {
      return null;
    }
    const current =
      assignment.currentRevisionId === undefined
        ? revisions.find(
            (revision) => revision.status === 'draft' && revision.proposedOnBehalfOfProviderId === undefined,
          )
        : revisions.find((revision) => revision._id === assignment.currentRevisionId);
    if (current === undefined || current.status !== 'draft') continue;
    return current;
  }
  return null;
}

export const seedProviderOrganizations = internalMutation({
  args: {
    organizationSlug: v.string(),
    projectName: v.optional(v.string()),
  },
  returns: v.object({
    organizations: v.number(),
    claims: v.number(),
    grants: v.number(),
    counteredRevisions: v.number(),
  }),
  handler: async (ctx, args) => {
    assertSeedingEnabled();

    const { organization, seeded: coordinator } = await resolveSeedOwnerContext(ctx, args.organizationSlug);
    const projectName = args.projectName ?? defaultProjectName;
    const project = await requireProjectByName(ctx, organization._id, projectName);

    let organizations = 0;
    let claims = 0;
    let grants = 0;
    let counteredRevisions = 0;
    let andes:
      | {
          providerId: Id<'providers'>;
          providerCtx: MutationCtx;
        }
      | undefined;

    for (const firm of providerFirms) {
      const provider = await requireProviderByName(ctx, organization._id, firm.name);
      const contactEmail = provider.contactEmail;
      if (contactEmail === undefined) {
        return invalidInput('seedProviderConflict', `Seed provider has no contact email: ${firm.name}`);
      }

      const providerCtx = withSeedAuthoredIdentity(ctx, {
        issuer: providerSeedIssuer,
        subject: `provider-organization:${firm.slug}`,
        email: contactEmail,
      });
      await ensureAuthenticatedUser(providerCtx);

      const existingOrganization = await ctx.db
        .query('organizations')
        .withIndex('by_slug', (q) => q.eq('slug', firm.slug))
        .unique();
      const providerOrganizationId =
        existingOrganization === null
          ? await createOrganization(providerCtx, { name: firm.name, slug: firm.slug })
          : existingOrganization._id;
      if (existingOrganization === null) organizations += 1;

      // An accepted invitation no longer occupies the pending address key, so a
      // re-run would otherwise call `inviteProviderOrganization` again and
      // conflict. The Provider's own claim column is the completion marker.
      const alreadyClaimed = provider.linkedOrganizationId !== undefined;
      if (!alreadyClaimed) {
        const invitationId = await inviteProviderOrganization(coordinator, {
          providerId: provider._id,
          email: contactEmail,
        });
        await claimProviderOrganization(providerCtx, {
          invitationId,
          organizationId: providerOrganizationId,
        });
        claims += 1;
      }

      if (firm.grantProjectAccess) {
        andes = { providerId: provider._id, providerCtx };
      }
    }

    if (andes !== undefined) {
      if (!(await hasActiveProjectGrant(coordinator, project._id, andes.providerId))) {
        try {
          await grantProjectAccessToProvider(coordinator, {
            projectId: project._id,
            providerId: andes.providerId,
          });
          grants += 1;
        } catch (error) {
          if (!isConflictError(error)) throw error;
        }
      }

      const offer = await findAndesCounterTarget(ctx, project._id, andes.providerId);
      if (offer !== null) {
        await counterAssignmentRevision(andes.providerCtx, {
          revisionId: offer._id,
          quantity: offer.quantity + 1,
          modality: offer.modality,
        });
        counteredRevisions += 1;
      }
    }

    return { organizations, claims, grants, counteredRevisions };
  },
});
