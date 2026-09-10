import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { recordAuditEvent } from '../audit/model';
import {
  assertCurrentMember,
  requireAuthenticatedUser,
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import {
  invitationTtlMs,
  normalizeEmailForComparison,
  normalizeInvitationEmail,
} from '../invitations/model';
import { maxEntityNameLength, validateEntityName } from '../lib/names';
import { providerHasAccessGrants, revokeAllProviderAccessGrants } from './grants';
import { providerHasFleetVehicles } from '../vehicles/references';
import { providerHasRateCards } from '../rateCards/references';
import { providerHasAssignments } from './references';
import { organizationConfigurationRole, roleAtLeast, type Role } from '../lib/roles';
import { assertSearchTermLength, normalizeSearchTerm, normalizeSearchText } from '../lib/search';
import type { archivalStatusValidator, providerClaimStateValidator, providerDocValidator } from '../validators';

type ArchivalStatus = typeof archivalStatusValidator.type;
type ProviderClaimState = typeof providerClaimStateValidator.type;
type ProviderListFilters = { status?: ArchivalStatus; search?: string };

/** The published Provider shape: the stored row plus its derived claim state. */
export type ProviderView = typeof providerDocValidator.type;

/**
 * The complete set of columns the GENERIC update path may touch.
 *
 * `linkedOrganizationId` is absent by construction, and its absence is the
 * whole point: a claim is a verified, audited transition owned by #86, not a
 * column a coordinator can hand-write onto a directory row. Structurally there
 * are three independent gates, so no single slip re-opens it:
 *
 *  1. `mutations.ts` `updateProvider` does not declare the argument, and Convex
 *     rejects undeclared arguments outright (I5) — a client that sends it gets a
 *     validation failure, not a silent drop.
 *  2. This type does not carry the key, so `updateProvider` below cannot even
 *     name it, and `ClaimLinkIsNotPatchable` fails `typecheck` if anyone adds it.
 *  3. The patch handed to `ctx.db.patch` is assembled field by field from named
 *     locals; caller input is never spread into a write.
 */
type ProviderPatch = {
  name?: string;
  legalName?: string;
  taxId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
};

type AssertTrue<Condition extends true> = Condition;
/**
 * Compile-time proof of gate 2 above: adding the claim link to `ProviderPatch`
 * makes this `AssertTrue<false>` and breaks `typecheck`. The alias is never
 * referenced on purpose — the constraint check IS its whole job.
 */
type ClaimLinkIsNotPatchable = AssertTrue<'linkedOrganizationId' extends keyof ProviderPatch ? false : true>;

/**
 * Notes are the one free-form paragraph on a Provider, bounded like a Cost
 * Centre description; every other optional string is an identifier or a contact
 * detail and is bounded like a display name.
 */
const maxProviderNotesLength = 2000;

const providerDetailFields = ['legalName', 'taxId', 'contactName', 'contactEmail', 'contactPhone'] as const;
type ProviderDetailField = (typeof providerDetailFields)[number];

export async function createProvider(
  ctx: MutationCtx,
  args: {
    organizationId: Id<'organizations'>;
    name: string;
    legalName?: string;
    taxId?: string;
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string;
    notes?: string;
  },
): Promise<Id<'providers'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, organizationConfigurationRole);
  // The validator returns the trimmed name, and the trimmed name is what is stored.
  const name = validateEntityName(args.name, 'provider');
  const details = validatedDetails(args);
  const notes = validatedNotes(args.notes);
  const searchText = normalizeSearchText(name);
  // Same-transaction indexed read-before-write on the NORMALISED name, so
  // `Acme SAS` and `  acme sas  ` are the same directory entry. Convex OCC
  // makes concurrent creators retry against the winning row instead of
  // admitting duplicates; this is never a scan.
  //
  // Accepted edge: a name containing no letters or digits at all (`###`)
  // normalises to the empty string, so the first such row claims the empty key
  // for the tenant. That is deliberately not special-cased — the alternative is
  // a second uniqueness key that search does not read, and two keys can drift.
  // A firm name with no alphanumeric character is not a name anyone searches
  // for, and the tenant can still store one such row.
  const existing = await ctx.db
    .query('providers')
    .withIndex('by_org_searchText', (q) => q.eq('organizationId', args.organizationId).eq('searchText', searchText))
    // `.first()`, not `.unique()`: the constraint is enforced by THIS read, not
    // by the index, so if a future change to `normalizeSearchText` ever folds
    // two existing rows onto one key, the next create must still fail as a
    // stable `conflict` code rather than as `unique()`'s untyped throw, which
    // no error catalogue can present.
    .first();
  if (existing !== null) return conflict();
  const providerId = await ctx.db.insert('providers', {
    organizationId: args.organizationId,
    name,
    ...details,
    ...(notes === undefined ? {} : { notes }),
    searchText,
    status: 'active',
    // `linkedOrganizationId` is deliberately never set here. Every Provider is
    // born unclaimed; #86's verified claim flow is the only writer of the link.
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'provider.created',
    entityType: 'provider',
    entityId: providerId,
    metadata: { name },
  });
  return providerId;
}

export async function getProvider(ctx: QueryCtx, providerId: Id<'providers'>): Promise<ProviderView> {
  const { provider } = await requireProviderAccess(ctx, providerId);
  return toProviderView(provider);
}

export async function listProviders(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
  filters: ProviderListFilters,
): Promise<PaginationResult<ProviderView>> {
  await requireProviderCatalogueAccess(ctx, organizationId);
  assertSearchTermLength(filters.search);
  const term = normalizeSearchTerm(filters.search ?? '');
  // Every branch narrows through a declared index BEFORE `.paginate`, never by
  // filtering an already-fetched page: a post-page filter would silently return
  // short pages and turn `numItems` into a lie.
  const page = await (async (): Promise<PaginationResult<Doc<'providers'>>> => {
    if (term !== '') {
      const status = filters.status;
      return ctx.db.query('providers').withSearchIndex('search_text', (q) => {
        let search = q.search('searchText', term).eq('organizationId', organizationId);
        if (status !== undefined) search = search.eq('status', status);
        return search;
      }).paginate(paginationOpts);
    }
    if (filters.status !== undefined) {
      const status = filters.status;
      return ctx.db
        .query('providers')
        .withIndex('by_org_status', (q) => q.eq('organizationId', organizationId).eq('status', status))
        .paginate(paginationOpts);
    }
    // Paginated because a tenant's Provider directory is unbounded (I6).
    return ctx.db
      .query('providers')
      .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
      .paginate(paginationOpts);
  })();
  return { ...page, page: page.page.map(toProviderView) };
}

export async function updateProvider(
  ctx: MutationCtx,
  providerId: Id<'providers'>,
  patch: ProviderPatch,
): Promise<void> {
  const { provider, access } = await requireProviderAccess(ctx, providerId, organizationConfigurationRole);
  if (provider.status === 'archived') {
    return invalidInput('providerArchived', 'Archived Providers cannot be updated');
  }
  // Validated (and therefore trimmed) before the diff, so what is compared
  // against the stored name is exactly what would be stored.
  const name = patch.name === undefined ? undefined : validateEntityName(patch.name, 'provider');
  const details = validatedDetails(patch);
  const notes = validatedNotes(patch.notes);

  const update: ProviderPatch & { searchText?: string } = {};
  const changedFields: string[] = [];
  if (name !== undefined && name !== provider.name) {
    const searchText = normalizeSearchText(name);
    // A rename is subject to the same normalised uniqueness rule as a create,
    // through the same index; otherwise the constraint would hold only until
    // somebody edited their way past it.
    if (searchText !== provider.searchText) {
      const existing = await ctx.db
        .query('providers')
        .withIndex('by_org_searchText', (q) => q.eq('organizationId', provider.organizationId).eq('searchText', searchText))
        .first();
      if (existing !== null) return conflict();
    }
    update.name = name;
    update.searchText = searchText;
    changedFields.push('name');
  }
  for (const field of providerDetailFields) {
    const next = details[field];
    if (next !== undefined && next !== provider[field]) {
      update[field] = next;
      changedFields.push(field);
    }
  }
  if (notes !== undefined && notes !== provider.notes) {
    update.notes = notes;
    changedFields.push('notes');
  }
  if (changedFields.length === 0) return;
  await ctx.db.patch(providerId, update);
  await recordAuditEvent(ctx, {
    organizationId: provider.organizationId,
    actorUserId: access.user._id,
    action: 'provider.updated',
    entityType: 'provider',
    entityId: providerId,
    metadata: { changedFields: changedFields.join(',') },
  });
}

export async function archiveProvider(ctx: MutationCtx, providerId: Id<'providers'>): Promise<void> {
  const { provider, access } = await requireProviderAccess(ctx, providerId, organizationConfigurationRole);
  if (provider.status === 'archived') return;
  await ctx.db.patch(providerId, { status: 'archived' });
  await recordAuditEvent(ctx, {
    organizationId: provider.organizationId,
    actorUserId: access.user._id,
    action: 'provider.archived',
    entityType: 'provider',
    entityId: providerId,
    metadata: { previousStatus: provider.status },
  });
}

export async function deleteProvider(ctx: MutationCtx, providerId: Id<'providers'>): Promise<void> {
  const { provider, access } = await requireProviderAccess(ctx, providerId, organizationConfigurationRole);
  if (provider.status !== 'archived') {
    return invalidInput('providerArchiveRequired', 'Providers must be archived before deletion');
  }
  // Reference guard, mirroring `deleteLocation` and `deleteCostCentre`: each
  // referencing relationship is checked first-hit before the delete, and the
  // refusal is always the same code so the caller learns "still referenced",
  // never which table holds the reference.
  //
  // Exactly ONE referencer can exist today, and it is stored on this row
  // itself: a claimed link names a real, external Organization whose members
  // sign in against it (docs/provider-access.md shape (b)). Deleting the
  // coordinator's half of a live claim would strand those accounts, so a
  // claimed Provider is archived, never destroyed — revoking the claim (#86) is
  // the deliberate step that releases it.
  //
  // Access grants (#71) are the second referencer and DO exist: a grant row
  // survives its Provider otherwise, and revoked grants are the record of who
  // used to be able to read a Project, so both statuses block deletion.
  // Rate Cards are the fourth referencer: archived Cards retain their Provider
  // reference because their immutable commercial history remains readable.
  // Assignments are the final direct referencer: even an Assignment with no
  // Revision is stable operational identity and keeps its Provider alive.
  //
  // Fleet Vehicles (#65) are the third: a plate belongs to exactly one Provider
  // row, and destroying that row would leave the vehicle pointing at nothing.
  // Archived vehicles count — see `providerHasFleetVehicles`.
  if (
    provider.linkedOrganizationId !== undefined ||
    (await providerHasAccessGrants(ctx, providerId)) ||
    (await providerHasFleetVehicles(ctx, provider.organizationId, providerId)) ||
    (await providerHasRateCards(ctx, provider.organizationId, providerId)) ||
    (await providerHasAssignments(ctx, provider.organizationId, providerId))
  ) {
    return invalidInput('providerDeleteBlocked', 'Referenced Providers cannot be deleted; retain the archived Provider instead');
  }
  // Recorded BEFORE the delete so the row's name is still readable, matching
  // `deleteLocation` and `deleteCostCentre`. Both writes share the transaction.
  await recordAuditEvent(ctx, {
    organizationId: provider.organizationId,
    actorUserId: access.user._id,
    action: 'provider.deleted',
    entityType: 'provider',
    entityId: providerId,
    metadata: { name: provider.name },
  });
  await ctx.db.delete(providerId);
}

/**
 * Invites an address to attach its own Organization to one coordinator-owned
 * Provider row. The address is stored without an account lookup (I9), and the
 * recipient supplies the Organization only after authenticating as that
 * address; the coordinator can therefore invite a firm that has not signed up
 * yet without learning whether an account exists.
 */
export async function inviteProviderOrganization(
  ctx: MutationCtx,
  args: { providerId: Id<'providers'>; email: string },
): Promise<Id<'organizationInvitations'>> {
  // This named Provider gate comes first. Every specific lifecycle result below
  // is consequently about the caller's own directory rather than a foreign row
  // whose existence or state could otherwise be probed (I1/I9).
  const { provider, access } = await requireProviderAccess(ctx, args.providerId, organizationConfigurationRole);
  if (provider.status === 'archived') {
    return invalidInput('providerArchived', 'Archived Providers cannot be invited to claim an Organization');
  }
  if (provider.linkedOrganizationId !== undefined) {
    return invalidInput('providerClaimAlreadyClaimed', 'Provider is already linked to an Organization');
  }
  const email = normalizeInvitationEmail(args.email);

  // Claims share the invitation address key with membership invites. That is
  // intentional: one live row is one unambiguous action for an address inside
  // this coordinator, while settled rows no longer occupy the key. As in the
  // membership path, this successful mutation can durably settle a dead row;
  // an accepting mutation that throws cannot.
  const existing = await ctx.db
    .query('organizationInvitations')
    .withIndex('by_org_email_status', (q) =>
      q.eq('organizationId', provider.organizationId).eq('email', email).eq('status', 'pending'),
    )
    .unique();
  if (existing !== null) {
    if (existing.expiresAt <= Date.now()) {
      await ctx.db.patch(existing._id, { status: 'expired' });
    } else {
      return conflict();
    }
  }

  const invitationId = await ctx.db.insert('organizationInvitations', {
    kind: 'providerClaim',
    organizationId: provider.organizationId,
    email,
    providerId: provider._id,
    status: 'pending',
    invitedByUserId: access.user._id,
    expiresAt: Date.now() + invitationTtlMs,
  });
  await recordAuditEvent(ctx, {
    organizationId: provider.organizationId,
    actorUserId: access.user._id,
    action: 'providerClaim.invited',
    entityType: 'providerClaimInvitation',
    entityId: invitationId,
    metadata: { providerId: provider._id },
  });
  return invitationId;
}

/**
 * Accepts the Provider claim and writes both halves of the transition in one
 * transaction. The invitation is proof of control over the addressed mailbox;
 * the current admin membership is independent proof that the recipient may
 * attach the Organization they named.
 */
export async function claimProviderOrganization(
  ctx: MutationCtx,
  args: { invitationId: Id<'organizationInvitations'>; organizationId: Id<'organizations'> },
): Promise<void> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const invitation = await ctx.db.get(args.invitationId);
  if (invitation === null) {
    return notFoundOrInaccessible();
  }
  // This comparison deliberately precedes kind, status, expiry and every graph
  // lookup. A non-recipient learns only the same generic result as for a made-up
  // id, never whether the row is a claim or which coordinator sent it (I9).
  const callerEmail = authenticated.user.email;
  if (callerEmail === undefined || normalizeEmailForComparison(callerEmail) !== invitation.email) {
    return notFoundOrInaccessible();
  }
  if (invitation.kind !== 'providerClaim') {
    return invalidInput('invitationKindMismatch', 'Invitation kind does not match this operation');
  }

  const provider = await ctx.db.get(invitation.providerId);
  // The invitation's denormalized organization must agree with the Provider's
  // authoritative owner before either is used. A broken or dangling stored
  // graph is not recipient-facing lifecycle information (I4/I9).
  if (provider === null || provider.organizationId !== invitation.organizationId) {
    return notFoundOrInaccessible();
  }

  // The target Organization is caller-supplied, so prove current authority
  // before comparing it with a completed claim. Otherwise an accepted row lets
  // its recipient use status differences to test which foreign Organization
  // currently holds the link (I9).
  await requireOrganizationRole(ctx, args.organizationId, 'admin', authenticated);

  if (
    invitation.status === 'revoked' ||
    (invitation.status === 'accepted' && provider.linkedOrganizationId !== args.organizationId)
  ) {
    return invalidInput('invitationNotPending', 'Invitation is no longer pending');
  }
  // An ACCEPTED claim is exempt from the clock. The TTL bounds how long an
  // unanswered offer stays open; it says nothing about a link that already
  // exists, which has no expiry. Without this exemption the idempotent replay
  // below becomes unreachable fourteen days after acceptance — that is, for
  // every claim in steady state rather than for an unusual few.
  if (invitation.status !== 'accepted' && (invitation.status === 'expired' || invitation.expiresAt <= Date.now())) {
    // Throwing rolls back every write in a Convex mutation, so patching status
    // immediately before this error could never settle it. Read the clock-bound
    // lifecycle directly, matching ordinary membership acceptance.
    return invalidInput('invitationExpired', 'Invitation has expired');
  }

  // Claim authority is live, unlike the deliberately grandfathered membership
  // arm. The inviter's current membership is read by its indexed relationship
  // and ranked centrally; this proves a stored authoritative relationship, not
  // a second caller principal or an identity-derived permission (I1/I4).
  if (invitation.status === 'pending') {
    const inviterMembership = await assertCurrentMember(
      ctx,
      invitation.invitedByUserId,
      invitation.organizationId,
    );
    if (!roleAtLeast(inviterMembership.role, 'admin')) {
      // The recipient has no principal in the coordinator tenant. A generic
      // result keeps its staffing and permission changes private (I9).
      return notFoundOrInaccessible();
    }
  }

  if (provider.organizationId === args.organizationId) {
    return invalidInput(
      'providerGrantSelfReference',
      'A coordinator cannot link its own Organization as an external Provider',
    );
  }
  // A client retry after an ambiguous network result observes the completed
  // pair and succeeds without another patch or audit row. It still re-proves
  // current authority over the attached Organization above, but only the exact
  // same invitation, Provider and target Organization qualify for the no-op.
  if (invitation.status === 'accepted') return;
  if (provider.status === 'archived') {
    return invalidInput('providerArchived', 'Archived Providers cannot be claimed');
  }
  if (provider.linkedOrganizationId !== undefined) {
    return invalidInput('providerClaimAlreadyClaimed', 'Provider is already linked to an Organization');
  }

  // The pair, not `linkedOrganizationId` alone, is the uniqueness key. A firm
  // may work for many coordinators, but one coordinator cannot create two
  // directory identities that resolve to the same outside principal. This
  // indexed read participates in the mutation's OCC conflict set, so a retry
  // sees and refuses the winning sequential claim without a scan.
  const existingLink = await ctx.db
    .query('providers')
    .withIndex('by_linkedOrganization_org', (q) =>
      q.eq('linkedOrganizationId', args.organizationId).eq('organizationId', provider.organizationId),
    )
    .first();
  if (existingLink !== null) {
    return invalidInput(
      'providerClaimOrganizationConflict',
      'This Organization is already linked to another Provider in the coordinator directory',
    );
  }

  await ctx.db.patch(provider._id, { linkedOrganizationId: args.organizationId });
  await ctx.db.patch(invitation._id, { status: 'accepted' });
  await recordAuditEvent(ctx, {
    organizationId: provider.organizationId,
    actorUserId: authenticated.user._id,
    action: 'providerClaim.accepted',
    entityType: 'providerClaimInvitation',
    entityId: invitation._id,
    metadata: { providerId: provider._id, linkedOrganizationId: args.organizationId },
  });
}

/** Withdraws an unanswered claim offer without touching any live Provider link. */
export async function revokeProviderClaimInvitation(
  ctx: MutationCtx,
  invitationId: Id<'organizationInvitations'>,
): Promise<void> {
  // Resolve identity before the caller-supplied id, so fabricated ids and
  // foreign invitations remain indistinguishable (I9).
  const authenticated = await requireAuthenticatedUser(ctx);
  const invitation = await ctx.db.get(invitationId);
  if (invitation === null) return notFoundOrInaccessible();

  if (invitation.kind === 'providerClaim') {
    // Authorization follows the Provider row rather than trusting the
    // invitation's denormalized organization id; a broken stored graph grants
    // neither authority nor visibility (I4/I9).
    const { provider, access } = await requireProviderAccess(
      ctx,
      invitation.providerId,
      organizationConfigurationRole,
    );
    if (provider.organizationId !== invitation.organizationId) return notFoundOrInaccessible();
    if (invitation.status !== 'pending') {
      return invalidInput('invitationNotPending', 'Invitation is no longer pending');
    }
    await ctx.db.patch(invitation._id, { status: 'revoked' });
    await recordAuditEvent(ctx, {
      organizationId: provider.organizationId,
      actorUserId: access.user._id,
      action: 'providerClaim.invitationRevoked',
      entityType: 'providerClaimInvitation',
      entityId: invitation._id,
      metadata: { providerId: provider._id },
    });
    return;
  }

  // Prove the membership invitation belongs to the caller's own tenant before
  // disclosing that it is the wrong transition for this endpoint (I9).
  await requireOrganizationRole(ctx, invitation.organizationId, organizationConfigurationRole, authenticated);
  return invalidInput('invitationKindMismatch', 'Invitation kind does not match this operation');
}

/** Lists the coordinator's still-withdrawable Provider claim offers. */
export async function listProviderClaimInvitations(
  ctx: QueryCtx,
  args: { organizationId: Id<'organizations'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'organizationInvitations'>>> {
  await requireOrganizationRole(ctx, args.organizationId, organizationConfigurationRole);
  // Kind and status are part of the indexed range before pagination. Filtering
  // a page afterward would create short pages and false pagination metadata.
  return ctx.db
    .query('organizationInvitations')
    .withIndex('by_org_kind_status', (q) =>
      q.eq('organizationId', args.organizationId).eq('kind', 'providerClaim').eq('status', 'pending'),
    )
    .order('desc')
    .paginate(args.paginationOpts);
}

/**
 * Withdraws the Organization link and retires this coordinator's project
 * grants. It is intentionally idempotent: removing access must remain possible
 * even when a caller retries after the link is already absent.
 */
export async function revokeProviderOrganizationClaim(
  ctx: MutationCtx,
  providerId: Id<'providers'>,
): Promise<void> {
  const { provider, access } = await requireProviderAccess(ctx, providerId, organizationConfigurationRole);
  const revokedAt = Date.now();
  const linkedOrganizationId = provider.linkedOrganizationId;
  if (linkedOrganizationId !== undefined) {
    await ctx.db.patch(provider._id, { linkedOrganizationId: undefined });
  }

  // This cascade is defence-in-depth and bookkeeping, not the authorization
  // boundary: the single project gate already re-proves the live claim on every
  // call, so clearing the link alone removes access immediately. Retiring this
  // Provider row's own grants prevents coordinator lists from showing
  // phantom-active access. Walking by Provider is essential — walking by the
  // linked Organization would revoke grants issued by other coordinators who
  // have no relationship to this caller.
  await revokeAllProviderAccessGrants(ctx, provider._id, revokedAt);
  if (linkedOrganizationId === undefined) return;

  await recordAuditEvent(ctx, {
    organizationId: provider.organizationId,
    actorUserId: access.user._id,
    action: 'providerClaim.revoked',
    entityType: 'provider',
    entityId: provider._id,
    metadata: { providerId: provider._id, linkedOrganizationId },
  });
}

/**
 * The single statement of "is this Provider claimed?", derived from the link
 * rather than stored beside it, so the two can never disagree.
 *
 * It is published as a value because the alternative — letting each client read
 * meaning out of an absent `linkedOrganizationId` — makes every consumer
 * reimplement a lifecycle rule it does not own, and makes "absent because
 * unclaimed" indistinguishable from "absent because this response omits it".
 */
export function toProviderView(provider: Doc<'providers'>): ProviderView {
  return { ...provider, claimState: claimStateOf(provider) };
}

function claimStateOf(provider: Doc<'providers'>): ProviderClaimState {
  return provider.linkedOrganizationId === undefined ? 'unclaimed' : 'claimed';
}

/**
 * ONE OF THE TWO PROVIDER READ GATES. #71 adds the second principal arm here.
 *
 * Today the access chain has a single principal type — an organization
 * membership — so this proves identity → app user → membership → role, exactly
 * like `requireLocationAccess` and `requireCostCentreAccess`. #71 introduces the
 * `Principal` union and the scoped, non-transitive Provider grant, at which
 * point a Provider Principal must be able to read ITS OWN row (and nothing else
 * in the directory, per docs/provider-access.md "What a Provider MAY see" §1).
 *
 * That second arm belongs in this function and in `requireProviderCatalogueAccess`
 * below — deliberately the only two places any Provider read is authorized, and
 * deliberately adjacent, so #71 is one file rather than forty. No query,
 * mutation, or future domain may inline its own membership check against
 * `providers`: that is what turns a second principal into a rewrite.
 *
 * WARNING for #71: this gate centralizes AUTHORIZATION, not SHAPING, and the
 * two are not the same decision. It hands back the whole `Doc<'providers'>`,
 * and `getProvider` publishes that row verbatim under `providerDocValidator` —
 * `notes` (the coordinator's private commentary about that firm), `taxId`,
 * `searchText` and `linkedOrganizationId` included. That is correct for a
 * member of the owning tenant and WRONG for a Provider Principal, which may see
 * only "the identity the coordinator recorded for it"
 * (docs/provider-access.md §"What a Provider MAY see" 1).
 *
 * So admitting the second arm here is only half the change: #71 must also
 * return a narrower projection on that arm — either by having this gate report
 * WHICH principal it resolved so `getProvider` can shape per arm, or by adding
 * a `providerSelfViewValidator` carrying name and contact only. Adding the arm
 * without the projection silently discloses the coordinator's notes to the firm
 * they are about.
 *
 * Authenticates BEFORE the lookup so foreign and fabricated ids stay
 * indistinguishable (I9).
 */
export async function requireProviderAccess(
  ctx: QueryCtx | MutationCtx,
  providerId: Id<'providers'>,
  minimumRole?: Role,
): Promise<{ provider: Doc<'providers'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const provider = await ctx.db.get(providerId);
  if (provider === null) return notFoundOrInaccessible();
  const access = minimumRole === undefined
    ? await requireOrganizationMembership(ctx, provider.organizationId, authenticated)
    : await requireOrganizationRole(ctx, provider.organizationId, minimumRole, authenticated);
  return { provider, access };
}

/**
 * The single statement of "may this organization store a reference to this
 * Provider?", mirroring `assertUsableCostCentre` and `assertUsableLocation`: it
 * must exist, belong to that organization, and still be active.
 *
 * This is NOT one of the two read gates below and grants nothing: authorization
 * for the operation must already have been established. It answers the
 * write-time question "is this a Provider row THIS tenant may point at?".
 *
 * Failure is always the generic error. The id arrives from the caller, so a
 * foreign, archived, or fabricated Provider must be indistinguishable, or every
 * writer of a Provider reference becomes a directory probe (I1/I9) — in
 * particular a caller must never learn that another coordinator's Provider
 * exists but is archived.
 */
export async function assertUsableProvider(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  providerId: Id<'providers'>,
  organizationId: Id<'organizations'>,
): Promise<Doc<'providers'>> {
  const provider = await ctx.db.get(providerId);
  if (provider === null || provider.organizationId !== organizationId || provider.status === 'archived') {
    return notFoundOrInaccessible();
  }
  return provider;
}

/**
 * THE OTHER PROVIDER READ GATE — the catalogue-wide one, kept beside
 * `requireProviderAccess` for the reason spelled out there.
 *
 * A Provider Principal must NEVER pass through this one: enumerating a
 * coordinator's directory is explicitly outside what a Provider may see
 * (docs/provider-access.md "What a Provider MAY NOT see" §4). #71 therefore
 * changes this function by REFUSING the second arm, not by admitting it — which
 * is exactly why it is a named gate rather than an inline call.
 */
export function requireProviderCatalogueAccess(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<'organizations'>,
): Promise<OrganizationMembershipAccess> {
  return requireOrganizationMembership(ctx, organizationId);
}

/**
 * Trims, then bounds, every short free-form column the caller supplies, and
 * returns what the caller must store. Trimming before the bound is the same
 * rule `validateEntityName` states for display names: validating a trimmed
 * value and then persisting the raw one holds the value to a rule it never
 * actually met.
 *
 * The rule is length only. An email, tax id or phone number is the
 * coordinator's own record of whom they deal with, and inventing a format for
 * it here would reject legitimate international values without protecting
 * anything.
 */
function validatedDetails(source: Partial<Record<ProviderDetailField, string>>): Partial<Record<ProviderDetailField, string>> {
  const details: Partial<Record<ProviderDetailField, string>> = {};
  for (const field of providerDetailFields) {
    const value = source[field];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length > maxEntityNameLength) {
      return invalidInput('providerDetailTooLong', `Provider ${field} must not exceed ${maxEntityNameLength} characters`);
    }
    details[field] = trimmed;
  }
  return details;
}

/** Same trim-then-bound rule as `validatedDetails`, at the notes column's own bound. */
function validatedNotes(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined;
  const trimmed = notes.trim();
  if (trimmed.length > maxProviderNotesLength) {
    return invalidInput('providerNotesTooLong', `Provider notes must not exceed ${maxProviderNotesLength} characters`);
  }
  return trimmed;
}
