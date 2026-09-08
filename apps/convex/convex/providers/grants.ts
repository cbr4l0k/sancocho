import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { recordAuditEvent } from '../audit/model';
import { requireAuthenticatedUser, requireOrganizationRole } from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { organizationConfigurationRole } from '../lib/roles';
import { requireProjectAccess } from '../projects/model';

/**
 * The COORDINATOR side of the second principal arm: issuing, revoking and
 * listing `providerAccessGrants` rows (#71).
 *
 * This module writes the rows; `lib/access.ts` is the only module that reads
 * them for authorization. The split is the point. Nothing here resolves a
 * principal, and nothing here is reachable by one:
 *
 * **NON-TRANSITIVITY IS STRUCTURAL, NOT A RULE.** Every entry point below
 * proves a coordinator MEMBERSHIP through `requireProjectAccess` /
 * `requireOrganizationRole` — helpers whose return type is
 * `OrganizationMembershipAccess`, which a Provider Principal can never satisfy
 * because a granted firm holds no membership in the granting tenant. A provider
 * therefore cannot create, delegate, extend or re-grant access; it fails at the
 * gate with the same generic error as a stranger. There is no delegation
 * column on the row and no code path that would read one. If a broker needs a
 * second firm involved, the coordinator issues that firm its own Provider row,
 * its own claim and its own grant — so the coordinator always knows every party
 * that can read its data (docs/provider-access.md §"Grants are non-transitive").
 */

/**
 * Letting an outside firm read into a Project is at least as consequential as
 * editing the directory that names the firm, so it sits at the same floor:
 * configuration, i.e. `admin`. Planners run projects; they do not decide who
 * outside the company gets to see one.
 */
const providerAccessGrantRole = organizationConfigurationRole;

/**
 * Issues (or reinstates) the one grant that lets a claimed Provider reach one
 * Project.
 *
 * Four independent parties have to agree before a row exists, and each
 * disagreement is checked separately (I1/I4):
 *
 *  1. The CALLER is an `admin` of the Project's organization — proven first, so
 *     every later failure is already behind an authorization wall.
 *  2. The PROVIDER ROW belongs to that same organization. A coordinator can
 *     only grant access to a firm in its own directory; naming another tenant's
 *     Provider id is indistinguishable from naming a fabricated one (I9).
 *  3. The PROVIDER IS CLAIMED, and the claimed Organization is resolved from
 *     the row's own `linkedOrganizationId` — never from a client argument
 *     (I4). This is the decided answer to "can an unclaimed Provider be
 *     granted?": no, refused at creation. Resolution independently refuses too,
 *     so a claim revoked afterwards kills the grant without editing it.
 *  4. The PROVIDER ORGANIZATION is not the coordinator itself. Granting to
 *     yourself would manufacture a provider principal out of your own members
 *     and quietly hand them a capability set their role never granted.
 */
export async function grantProjectAccessToProvider(
  ctx: MutationCtx,
  args: { projectId: Id<'projects'>; providerId: Id<'providers'> },
): Promise<Id<'providerAccessGrants'>> {
  const { project, access } = await requireProjectAccess(ctx, args.projectId, providerAccessGrantRole);
  // An archived Project is read-only for everything it contains; admitting a
  // new outside reader to one is a write, and a pointless one.
  if (project.status === 'archived') {
    return invalidInput('projectArchived', 'Archived projects cannot be granted to Providers');
  }

  const provider = await ctx.db.get(args.providerId);
  // Both "no such Provider" and "a Provider belonging to somebody else" leave
  // through the same generic error: the id arrives from the caller (I9).
  if (provider === null || provider.organizationId !== project.organizationId) {
    return notFoundOrInaccessible();
  }
  // A specific code, because by this point the row is proven to be the caller's
  // OWN tenant data and its state discloses nothing about anyone else.
  if (provider.status === 'archived') {
    return invalidInput('providerArchived', 'Archived Providers cannot be granted project access');
  }
  const providerOrganizationId = provider.linkedOrganizationId;
  if (providerOrganizationId === undefined) {
    return invalidInput(
      'providerGrantRequiresClaim',
      'Only a claimed Provider can be granted project access',
    );
  }
  if (providerOrganizationId === project.organizationId) {
    return invalidInput(
      'providerGrantSelfReference',
      'A Provider linked to the granting organization cannot hold a grant on its own project',
    );
  }
  const providerOrganization = await ctx.db.get(providerOrganizationId);
  if (providerOrganization === null) {
    return notFoundOrInaccessible();
  }

  // Uniqueness = indexed read-before-write in this same mutation, on the
  // (Provider, Project) key. Convex serializable OCC retries a losing concurrent
  // creator against the winning row, so this admits no duplicate without a lock.
  const existing = await ctx.db
    .query('providerAccessGrants')
    .withIndex('by_provider_project', (q) => q.eq('providerId', args.providerId).eq('projectId', args.projectId))
    .unique();
  if (existing !== null) {
    if (existing.status === 'active') {
      return conflict();
    }
    // Reinstatement REUSES the row rather than inserting a second one, so the
    // uniqueness key stays true and no resolution path ever has to choose
    // between two grants for one pair. `revokedAt: undefined` removes the
    // column outright — a reinstated grant is not "revoked with a stale date".
    // `providerOrganizationId` is re-derived, so reinstating after a re-claim
    // records the firm that holds the Provider now, not the one that did then.
    await ctx.db.patch(existing._id, {
      status: 'active',
      providerOrganizationId,
      grantedByUserId: access.user._id,
      grantedAt: Date.now(),
      revokedAt: undefined,
    });
    await recordGrantAudit(ctx, {
      organizationId: project.organizationId,
      actorUserId: access.user._id,
      action: 'providerAccessGrant.granted',
      grantId: existing._id,
      providerId: args.providerId,
      projectId: args.projectId,
    });
    return existing._id;
  }

  const grantId = await ctx.db.insert('providerAccessGrants', {
    // Every column is server-derived from the proven graph (I4): the
    // coordinator from the Project, the provider organization from the
    // Provider's own claim, the actor and the clock from the transaction.
    organizationId: project.organizationId,
    providerId: args.providerId,
    providerOrganizationId,
    projectId: args.projectId,
    status: 'active',
    grantedByUserId: access.user._id,
    grantedAt: Date.now(),
  });
  await recordGrantAudit(ctx, {
    organizationId: project.organizationId,
    actorUserId: access.user._id,
    action: 'providerAccessGrant.granted',
    grantId,
    providerId: args.providerId,
    projectId: args.projectId,
  });
  return grantId;
}

/**
 * Withdraws a grant. The Provider loses access on the very next call, because
 * the gate reads `status` off this row every time and caches nothing anywhere.
 *
 * Idempotent: revoking an already-revoked grant is a no-op rather than an
 * error, so a revocation can always be repeated. Access withdrawal must never
 * be refusable.
 */
export async function revokeProviderAccessGrant(
  ctx: MutationCtx,
  grantId: Id<'providerAccessGrants'>,
): Promise<void> {
  // Authenticate before the caller-supplied id is loaded, so a fabricated grant
  // id and a real foreign one are indistinguishable (I9).
  const authenticated = await requireAuthenticatedUser(ctx);
  const grant = await ctx.db.get(grantId);
  if (grant === null) {
    return notFoundOrInaccessible();
  }
  // Authorization walks the stored graph: the Project owns the answer to "whose
  // grant is this", and the row's denormalized `organizationId` is then checked
  // against it rather than trusted (I4).
  const project = await ctx.db.get(grant.projectId);
  if (project === null) {
    return notFoundOrInaccessible();
  }
  const access = await requireOrganizationRole(ctx, project.organizationId, providerAccessGrantRole, authenticated);
  if (grant.organizationId !== project.organizationId) {
    return notFoundOrInaccessible();
  }
  if (grant.status === 'revoked') {
    return;
  }
  await ctx.db.patch(grantId, { status: 'revoked', revokedAt: Date.now() });
  await recordGrantAudit(ctx, {
    organizationId: project.organizationId,
    actorUserId: access.user._id,
    action: 'providerAccessGrant.revoked',
    grantId,
    providerId: grant.providerId,
    projectId: grant.projectId,
  });
}

/**
 * The coordinator's own list of who it has let into a Project — including
 * revoked rows, which are the record of who used to be able to read it.
 *
 * Paginated and index-narrowed (I6). The index is keyed by the GRANTING
 * organization as well as the project, so a member supplying a foreign project
 * id reads an empty range rather than another tenant's grants — and the
 * `requireProjectAccess` gate has already refused them by then anyway.
 */
export async function listProjectProviderAccessGrants(
  ctx: QueryCtx,
  args: { projectId: Id<'projects'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'providerAccessGrants'>>> {
  const { project } = await requireProjectAccess(ctx, args.projectId, providerAccessGrantRole);
  return ctx.db
    .query('providerAccessGrants')
    .withIndex('by_org_project', (q) => q.eq('organizationId', project.organizationId).eq('projectId', project._id))
    .paginate(args.paginationOpts);
}

/**
 * The referential-integrity guard `deleteProvider` asks before destroying a
 * directory row (I4). It lives here, beside the writer, so `providerAccessGrants`
 * keeps exactly two readers in the whole codebase: this module, which owns the
 * row's lifecycle, and `lib/access.ts`, which is the only place a row here
 * becomes a capability.
 *
 * REVOKED grants count. A revoked row is not dead weight — it is the record of
 * who used to be able to read this Project, returned by
 * `listProjectProviderAccessGrants` and pointed at by two audit events. Letting
 * a delete orphan it would leave a `providerId` resolving to nothing and quietly
 * turn that history into a dangling reference, which is precisely the state the
 * archival-over-deletion policy exists to prevent. First-hit and indexed: this
 * never scans.
 */
export async function providerHasAccessGrants(
  ctx: QueryCtx | MutationCtx,
  providerId: Id<'providers'>,
): Promise<boolean> {
  const grant = await ctx.db
    .query('providerAccessGrants')
    .withIndex('by_provider_project', (q) => q.eq('providerId', providerId))
    .first();
  return grant !== null;
}

/**
 * One statement of the grant audit row, so granting and revoking cannot drift
 * into recording different things about the same relationship.
 *
 * `onBehalfOfProviderId` is deliberately NOT set: these are member-arm
 * operations. The coordinator is acting as itself when it decides who gets in;
 * recording it as acting "on behalf of" the firm it is admitting would invert
 * the meaning of the column the first time anyone read the log.
 */
function recordGrantAudit(
  ctx: MutationCtx,
  args: {
    organizationId: Id<'organizations'>;
    actorUserId: Id<'users'>;
    action: 'providerAccessGrant.granted' | 'providerAccessGrant.revoked';
    grantId: Id<'providerAccessGrants'>;
    providerId: Id<'providers'>;
    projectId: Id<'projects'>;
  },
) {
  return recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    action: args.action,
    entityType: 'providerAccessGrant',
    entityId: args.grantId,
    metadata: { providerId: args.providerId, projectId: args.projectId },
  });
}
