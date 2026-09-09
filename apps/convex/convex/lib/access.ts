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

// ---------------------------------------------------------------------------
// The second principal arm (#71, docs/provider-access.md shape (b)).
//
// EVERYTHING below this line is the whole of the two-principal access chain.
// `requirePrincipalForProject` is THE ONLY function in the codebase that
// resolves which kind of principal a caller is, and the only reader of
// `providerAccessGrants` for authorization purposes. No operation may inline
// either arm; adding a third principal must remain a change to this file alone.
// `tests/providerAccess.test.ts` asserts that mechanically over the sources.
// ---------------------------------------------------------------------------

/**
 * Every capability a Provider grant confers. It is a SET, not a ladder: nothing
 * here implies anything else here, and `roleAtLeast` must never be applied to
 * it.
 *
 * There is deliberately no `readProject`, no `readOtherAssignments` and no
 * `readRates` — see docs/provider-access.md "What a Provider MAY NOT see".
 * Adding a member is a reviewed security change with tests, never configuration.
 */
export type Capability =
  | 'readAssignment'
  | 'writeExecution'
  | 'respondToTerms'
  | 'readLinkedServiceProjection';

/**
 * The complete gate vocabulary. Commercial Assignment authoring is member-only
 * until #88 adds Provider response actions, so it is intentionally not part of
 * the Provider grant's closed `Capability` set.
 */
export type ProjectIntent = Capability | 'writeAssignmentTerms';

/**
 * The closed capability set an active Provider grant confers. Code-owned and
 * constant: it is not stored on the grant row, not derived from a role, and not
 * reachable by any tenant-settable value, so no coordinator can widen a
 * provider's reach by misconfiguration (I8).
 */
const providerGrantCapabilities: readonly Capability[] = Object.freeze([
  'readAssignment',
  'writeExecution',
  'respondToTerms',
  'readLinkedServiceProjection',
]);

/**
 * The member arm's translation of the same intents into the OTHER vocabulary —
 * the role ladder. The two axes never compose (a provider's rank in its own
 * Organization is not an argument about somebody else's project, and a
 * coordinator's role is not a capability); this map is simply how a coordinator
 * member's ranked role answers the same question the grant answers by
 * enumeration.
 *
 * Reading and responding mirror the floors the rest of the codebase already
 * uses: viewers read, operators run what is planned (`changeServiceStatus`),
 * planners author commercial intent.
 */
const memberRoleForCapability: Readonly<Record<ProjectIntent, Role>> = Object.freeze({
  readAssignment: 'viewer',
  writeAssignmentTerms: 'planner',
  readLinkedServiceProjection: 'viewer',
  writeExecution: 'operator',
  respondToTerms: 'planner',
});

/**
 * A coordinator member acting inside their own tenant. Carries the membership
 * and organization, and deliberately carries NO capability set: the member
 * vocabulary is the ranked role, and publishing a capability set here would
 * invite call sites to conflate the two axes.
 */
export type MemberPrincipal = OrganizationMembershipAccess & { kind: 'member' };

/**
 * An external firm's user reaching one granted Project of somebody else's
 * tenant. Everything it names was re-proven from stored rows on this call: the
 * Provider row, the live claim to its Organization, and the active grant.
 * Nothing is cached anywhere, in this shape or outside it.
 *
 * It carries IDENTIFIERS, never the documents they came from, and that is a
 * confinement decision distinct from the authorization one above. A capability
 * says what a caller may DO; it says nothing about what a handler may then
 * return. If this shape carried `Doc<'providers'>`, every handler authorized
 * for `readAssignment` would be one property access away from returning the
 * coordinator's private `notes` about that firm, its `taxId` or its
 * `searchText` — and from returning the grant's `grantedByUserId` and
 * coordinator `organizationId` — with the compiler's blessing. The warning on
 * `requireProviderAccess` in `providers/model.ts` asks for exactly this; the
 * type is what enforces it, because a comment is not a gate.
 *
 * The full rows stay local to the resolver, which is the only code that needs
 * them. A downstream consumer that genuinely needs another column adds a named
 * field here deliberately, so widening what a Provider Principal can reach is a
 * reviewed edit to this file rather than an accident at a call site.
 */
export type ProviderPrincipal = AuthenticatedUser & {
  kind: 'provider';
  providerId: Id<'providers'>;
  /** Every Provider row through which this caller may read Project lists. */
  accessibleProviderIds: ReadonlySet<Id<'providers'>>;
  providerOrganizationId: Id<'organizations'>;
  grantId: Id<'providerAccessGrants'>;
  capabilities: ReadonlySet<Capability>;
};

export type Principal = MemberPrincipal | ProviderPrincipal;

/**
 * THE GATE. The single place either principal arm is resolved (#71).
 *
 * `identity → app user → principal (member | provider grant) → capability →
 * ownership of every referenced entity`, for one Project, in one function.
 * #67's `requireAssignmentAccess(assignmentId, intent)` resolves an Assignment
 * to its Project and delegates here; it adds no policy of its own, and neither
 * may anything else.
 *
 * Ordering is load-bearing three times over:
 *
 *  1. Authenticate BEFORE the caller-supplied id is loaded, so a fabricated id
 *     and a real foreign one are indistinguishable to an anonymous caller (I9).
 *  2. Try the member arm first. A coordinator's own member is the overwhelming
 *     case and costs one indexed read; the provider arm's membership walk is
 *     only reached by callers who are not members of the owning tenant.
 *  3. EVERY failure — no project, no principal, insufficient role, revoked
 *     grant, dead claim, unheld capability — leaves through the same
 *     `notFoundOrInaccessible()`. Probing an adjacent project id must be
 *     indistinguishable from probing one that never existed, on both arms (I9).
 *
 * With no expected Provider (the list case), every valid grant held through
 * the caller's memberships is retained in `accessibleProviderIds`. Supplying
 * an expected Provider (the single-row case) narrows that set to the target.
 *
 * A caller who IS a member of the owning organization but whose role does not
 * reach the intent is refused here rather than falling through to the provider
 * arm. That fails closed: somebody the coordinator deliberately admitted as a
 * `viewer` does not get more by also belonging to a granted provider firm.
 */
export async function requirePrincipalForProject(
  ctx: UserAccessContext,
  projectId: Id<'projects'>,
  intent: ProjectIntent,
  expectedProviderId?: Id<'providers'>,
): Promise<Principal> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const project = await ctx.db.get(projectId);
  if (project === null) {
    return notFoundOrInaccessible();
  }

  const membership = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_org_user', (q) =>
      q.eq('organizationId', project.organizationId).eq('userId', authenticated.user._id),
    )
    .unique();
  if (membership !== null) {
    if (!roleAtLeast(membership.role, memberRoleForCapability[intent])) {
      return notFoundOrInaccessible();
    }
    const organization = await ctx.db.get(project.organizationId);
    if (organization === null) {
      return notFoundOrInaccessible();
    }
    return { kind: 'member', ...authenticated, membership, organization };
  }

  const principal = await resolveProviderPrincipal(ctx, project, authenticated, expectedProviderId);
  if (principal === null) {
    return notFoundOrInaccessible();
  }
  // The enforcement point for the closed set. It is total by construction today
  // (the grant confers every capability the type declares), and it stays here
  // precisely so that the day the two diverge — a narrower grant, a new intent
  // providers must not hold — the refusal is already centralized here and can
  // be pinned at this gate instead of remembered at forty call sites.
  if (intent === 'writeAssignmentTerms' || !principal.capabilities.has(intent)) {
    return notFoundOrInaccessible();
  }
  // Defence in depth. The resolver above already skips non-matching grants, so
  // this can only fire if that filter is ever weakened; it is kept because the
  // cost is one comparison and the failure it guards is cross-tenant.
  if (expectedProviderId !== undefined && principal.providerId !== expectedProviderId) {
    return notFoundOrInaccessible();
  }
  return principal;
}

/**
 * The provider arm, resolved from the CALLER's side.
 *
 * The caller proves a membership in some Organization; that Organization then
 * has to hold a live grant on this Project. Walking the caller's memberships
 * (rather than the Project's grants) keeps the work proportional to the caller
 * — one indexed read per organization the signed-in user actually belongs to,
 * which for a provider's dispatcher is one — instead of proportional to how
 * many firms a festival happens to have engaged.
 *
 * The membership `.collect()` is bounded by a single user's memberships,
 * exactly as `listMyOrganizations` already relies on. The grant `.collect()` is
 * bounded by how many Provider rows one coordinator has linked to one firm for
 * one project — one, in every non-pathological case, because
 * `by_provider_project` admits a single grant per (Provider, Project).
 *
 * Returns `null` rather than throwing so the caller owns the single I9 exit.
 * For lists it walks the complete bounded membership/grant set so the result
 * carries every Provider through which the caller has live Project access.
 */
async function resolveProviderPrincipal(
  ctx: UserAccessContext,
  project: Doc<'projects'>,
  authenticated: AuthenticatedUser,
  expectedProviderId?: Id<'providers'>,
): Promise<ProviderPrincipal | null> {
  const memberships = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_user', (q) => q.eq('userId', authenticated.user._id))
    .collect();

  let resolved: Omit<ProviderPrincipal, 'accessibleProviderIds'> | null = null;
  const accessibleProviderIds = new Set<Id<'providers'>>();
  for (const membership of memberships) {
    const grants = await ctx.db
      .query('providerAccessGrants')
      // The `projectId` component of the index range IS the project equality
      // check: a grant issued for Project A is simply not in the range read for
      // Project B, so a grant can never leak sideways across projects.
      .withIndex('by_providerOrganization_project', (q) =>
        q.eq('providerOrganizationId', membership.organizationId).eq('projectId', project._id),
      )
      .collect();

    for (const grant of grants) {
      // Read from the stored row on THIS call. Revocation is effective on the
      // very next call because there is nothing anywhere that remembers the
      // previous answer — no token claim, no session, no memoized principal.
      if (grant.status !== 'active') continue;
      // A caller who belongs to two granted firms must resolve as the firm that
      // owns the TARGET row, not whichever grant the membership walk reached
      // first. Skipping non-matching grants here (rather than validating the
      // first result afterwards) is what lets such a dispatcher read BOTH
      // firms' assignments — validating after would make one of the two
      // permanently unreachable, depending only on membership order.
      if (expectedProviderId !== undefined && grant.providerId !== expectedProviderId) continue;
      // The denormalized coordinator column must agree with the Project's own
      // organization; authorization walks the stored graph and never trusts a
      // cached id (I4).
      if (grant.organizationId !== project.organizationId) continue;

      const provider = await ctx.db.get(grant.providerId);
      if (provider === null) continue;
      // The Provider row must be the granting coordinator's own directory
      // entry, not some other tenant's row that happens to be referenced.
      if (provider.organizationId !== project.organizationId) continue;
      // An archived Provider is out of service, and out of service means it
      // reads nothing — archival is the coordinator's off switch.
      if (provider.status !== 'active') continue;
      // THE CLAIM CHECK, re-proven every call. It covers both failure shapes at
      // once, which is why there is no separate `undefined` test: an UNCLAIMED
      // Provider (no link at all) and a RELINKED one (claimed by a different
      // firm since the grant was issued) both fail this comparison, so revoking
      // a claim revokes every grant riding on it without touching a grant row.
      if (provider.linkedOrganizationId !== membership.organizationId) continue;

      const providerOrganization = await ctx.db.get(membership.organizationId);
      if (providerOrganization === null) continue;

      // `providerOrganization` is proven to exist and then deliberately
      // dropped: the principal names it by id. Same for `provider` and `grant`
      // — every one of them was needed to DECIDE, and none of them is something
      // a downstream handler should be handed wholesale.
      const candidate = {
        kind: 'provider',
        ...authenticated,
        providerId: provider._id,
        providerOrganizationId: providerOrganization._id,
        grantId: grant._id,
        // A fresh set per principal: the module-level list is the source of
        // truth and never escapes. Tests mutate one returned copy and prove a
        // later principal still receives the complete closed set.
        capabilities: new Set(providerGrantCapabilities),
      } satisfies Omit<ProviderPrincipal, 'accessibleProviderIds'>;
      resolved ??= candidate;
      accessibleProviderIds.add(provider._id);
    }
  }
  return resolved === null ? null : { ...resolved, accessibleProviderIds };
}

/**
 * The capability set exactly as an active grant confers it. Exported for the
 * tests that pin the closed set and for #87's portal, never as something a
 * caller may edit — a mutation-isolation test proves the returned set is a copy.
 */
export function providerCapabilitySet(): ReadonlySet<Capability> {
  return new Set(providerGrantCapabilities);
}

/**
 * BOTH actor dimensions of an audited operation, derived from the resolved
 * principal rather than assembled at each call site.
 *
 * A member acts as itself, so member rows carry no `onBehalfOfProviderId` at
 * all. A provider principal's writes (#88) record the human AND the Provider
 * whose grant admitted them, which is what makes "who changed this" answerable
 * once two principals can reach the same row.
 */
export function auditActorFor(
  principal: Principal,
): { actorUserId: Id<'users'>; onBehalfOfProviderId?: Id<'providers'> } {
  return principal.kind === 'member'
    ? { actorUserId: principal.user._id }
    : { actorUserId: principal.user._id, onBehalfOfProviderId: principal.providerId };
}
