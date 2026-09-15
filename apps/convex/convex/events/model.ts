import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { recordAuditEvent } from '../audit/model';
import {
  assertCurrentMember,
  findCurrentMember,
  requireAuthenticatedUser,
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { assertUsableCostCentre } from '../costCentres/model';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { assertMinorUnits } from '../lib/money';
import { validateEntityName } from '../lib/names';
import type { Role } from '../lib/roles';
import { assertUsableLocation } from '../locations/model';
import { assertProjectAcceptsChildWrites, assertProjectAcceptsNewChildren, requireProjectAccess } from '../projects/model';
import {
  isFiniteNumber,
  type currencyValidator,
  type displayUserValidator,
  type eventStatusValidator,
} from '../validators';

export type EventStatus = typeof eventStatusValidator.type;
type Currency = typeof currencyValidator.type;

const authoringRole: Role = 'planner';

/**
 * The single Event lifecycle policy. Every status-changing door consults this
 * table: ordinary status changes use the non-archival edges, while
 * `archiveEvent` owns the archival edges and its distinct audit action.
 * `archived` has no outgoing edge and is therefore genuinely terminal.
 */
const transitions = (...statuses: EventStatus[]): readonly EventStatus[] => Object.freeze(statuses);

export const eventStatusTransitions: Readonly<Record<EventStatus, readonly EventStatus[]>> = Object.freeze({
  draft: transitions('active', 'archived'),
  active: transitions('completed', 'archived'),
  completed: transitions('archived'),
  archived: transitions(),
});

type EventDates = { startsAt: number; endsAt?: number };

/**
 * The referenced half of the shared context an Event carries on behalf of every
 * Service under it. Each member is optional and proven against the Event's own
 * organization by `assertEventReferences`, the single place those rules live
 * for both the create and the update door.
 *
 * The budget pair is deliberately NOT a member: it needs no database read, and
 * on the update door it is checked against the RESOLVED values rather than the
 * supplied ones, so folding it in here would make the update door's call a
 * silent no-op.
 */
type EventReferences = {
  venueLocationId?: Id<'locations'>;
  clientCostCentreId?: Id<'costCentres'>;
  accountableUserId?: Id<'users'>;
};

/** The full context accepted by `createEvent`: references plus the budget pair. */
type EventContext = EventReferences & {
  budgetAmount?: number;
  budgetCurrency?: Currency;
};

/**
 * `null` clears a stored optional column, `undefined` leaves it alone — the
 * same two-state convention `endsAt` already used, extended to every optional
 * column so a value can be removed as well as replaced.
 */
type EventPatch = {
  name?: string;
  startsAt?: number;
  endsAt?: number | null;
  venueLocationId?: Id<'locations'> | null;
  clientCostCentreId?: Id<'costCentres'> | null;
  budgetAmount?: number | null;
  budgetCurrency?: Currency | null;
  accountableUserId?: Id<'users'> | null;
};

type EventUpdate = {
  name?: string;
  startsAt?: number;
  endsAt?: number | undefined;
  venueLocationId?: Id<'locations'> | undefined;
  clientCostCentreId?: Id<'costCentres'> | undefined;
  budgetAmount?: number | undefined;
  budgetCurrency?: Currency | undefined;
  accountableUserId?: Id<'users'> | undefined;
};

/**
 * Creates an Event under a stored Project. `organizationId` is derived from
 * that Project in this transaction and is not part of any public argument (I4).
 * Resolving through `requireProjectAccess` proves, rather than assumes, that
 * the resulting Event and Project share an organization.
 */
export async function createEvent(
  ctx: MutationCtx,
  args: { projectId: Id<'projects'>; name: string } & EventDates & EventContext,
): Promise<Id<'events'>> {
  const { project, access } = await requireProjectAccess(ctx, args.projectId, authoringRole);
  assertProjectAcceptsNewChildren(project, 'eventProjectUnavailable', 'events');
  const name = validateEntityName(args.name, 'event');
  validateEventDates(args.startsAt, args.endsAt);
  validateEventWithinProjectWindow(project, args.startsAt, args.endsAt);
  await assertEventReferences(ctx, project.organizationId, args);
  validateEventBudget(args.budgetAmount, args.budgetCurrency);
  const eventId = await ctx.db.insert('events', {
    organizationId: project.organizationId,
    projectId: project._id,
    name,
    status: 'draft',
    startsAt: args.startsAt,
    ...(args.endsAt === undefined ? {} : { endsAt: args.endsAt }),
    ...(args.venueLocationId === undefined ? {} : { venueLocationId: args.venueLocationId }),
    ...(args.clientCostCentreId === undefined ? {} : { clientCostCentreId: args.clientCostCentreId }),
    ...(args.budgetAmount === undefined ? {} : { budgetAmount: args.budgetAmount }),
    ...(args.budgetCurrency === undefined ? {} : { budgetCurrency: args.budgetCurrency }),
    ...(args.accountableUserId === undefined ? {} : { accountableUserId: args.accountableUserId }),
  });
  await recordAuditEvent(ctx, {
    organizationId: project.organizationId,
    actorUserId: access.user._id,
    action: 'event.created',
    entityType: 'event',
    entityId: eventId,
    metadata: { name },
  });
  return eventId;
}

export async function getEvent(ctx: QueryCtx, eventId: Id<'events'>): Promise<Doc<'events'>> {
  const { event } = await requireEventAccess(ctx, eventId);
  return event;
}

export type EventDetail = {
  event: Doc<'events'>;
  project: Pick<Doc<'projects'>, '_id' | 'name' | 'status'>;
  venue: Pick<Doc<'locations'>, '_id' | 'name' | 'type'> | null;
  /**
   * `key` keeps the column's own name. An earlier draft published it as `code`,
   * which would have given one stored value two names — the database, the Cost
   * Centre surface and this header would each have called it something else,
   * and the next reader would have had to discover they were the same thing.
   */
  clientCostCentre: Pick<Doc<'costCentres'>, '_id' | 'key' | 'name' | 'status'> | null;
  /** Derived from the shared validator so the roster and this header cannot drift. */
  accountable: typeof displayUserValidator.type | null;
};

/** The Event header projection, gated by the existing Event access policy. */
export async function getEventDetail(ctx: QueryCtx, eventId: Id<'events'>): Promise<EventDetail> {
  const { event, project } = await requireEventAccess(ctx, eventId);
  const venueRow = event.venueLocationId === undefined ? null : await ctx.db.get(event.venueLocationId);
  const costCentreRow = event.clientCostCentreId === undefined ? null : await ctx.db.get(event.clientCostCentreId);
  const accountableRow = event.accountableUserId === undefined ? null : await ctx.db.get(event.accountableUserId);
  const accountableMembership = accountableRow === null
    ? null
    : await findCurrentMember(ctx, accountableRow._id, event.organizationId);

  return {
    event,
    project: { _id: project._id, name: project.name, status: project.status },
    // References are write-proven, but old/corrupt rows must remain safe to
    // read: a missing or foreign joined row becomes null instead of disclosing
    // another tenant or making the whole Event unavailable (I9).
    venue: venueRow === null || venueRow.organizationId !== event.organizationId
      ? null
      : { _id: venueRow._id, name: venueRow.name, type: venueRow.type },
    clientCostCentre: costCentreRow === null || costCentreRow.organizationId !== event.organizationId
      ? null
      : { _id: costCentreRow._id, key: costCentreRow.key, name: costCentreRow.name, status: costCentreRow.status },
    // A stored accountable id is historical context, but its display identity
    // stops crossing the tenant boundary as soon as membership is removed.
    accountable: accountableRow === null || accountableMembership === null
      ? null
      : {
          _id: accountableRow._id,
          ...(accountableRow.name === undefined ? {} : { name: accountableRow.name }),
          ...(accountableRow.email === undefined ? {} : { email: accountableRow.email }),
        },
  };
}

/** Organization-wide Event list with every narrowing applied by an index. */
export async function listOrganizationEvents(
  ctx: QueryCtx,
  args: {
    organizationId: Id<'organizations'>;
    projectId?: Id<'projects'>;
    status?: EventStatus;
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<Doc<'events'>>> {
  const authenticated = await requireAuthenticatedUser(ctx);
  await requireOrganizationMembership(ctx, args.organizationId, authenticated);
  if (args.projectId !== undefined) {
    const { project } = await requireProjectAccess(ctx, args.projectId);
    // The membership proves the organization while this proves the filtered
    // Project; both are needed so neither tenant id can reach the other (I1).
    if (project.organizationId !== args.organizationId) return notFoundOrInaccessible();
  }
  const page = await paginateEvents(ctx, args);
  return { ...page, page: await assertPageBelongsToOrganization(ctx, page.page) };
}

/**
 * Re-derives each row's tenant through the stored graph instead of trusting the
 * column the index selected on.
 *
 * `events.organizationId` is a denormalized copy of `projects.organizationId`.
 * Every write path derives it from a proven Project and `EventUpdate` cannot
 * name the column, so the two cannot diverge today — but "today" is the whole
 * weight this would be carrying, and a bad migration or seed is all it takes.
 * `listOrganizationServices` re-derives for exactly this reason (I4: the
 * denormalized column is an index cache; authorization walks the stored graph),
 * and the single-Event doors here already re-prove the same pair in
 * `requireEventAccess`. This was the one Events read that skipped it.
 *
 * The project read is memoized because a page is usually a handful of Projects,
 * so the guard costs distinct-parents reads, not one per row.
 */
async function assertPageBelongsToOrganization(
  ctx: QueryCtx,
  rows: readonly Doc<'events'>[],
): Promise<Doc<'events'>[]> {
  const projects = new Map<Id<'projects'>, Doc<'projects'> | null>();
  for (const row of rows) {
    if (!projects.has(row.projectId)) projects.set(row.projectId, await ctx.db.get(row.projectId));
    const project = projects.get(row.projectId) ?? null;
    // The whole page is refused rather than the offending row silently dropped:
    // a divergence here is a corrupt database, not a permission outcome, and a
    // quietly shortened page would hide it.
    if (project === null || project.organizationId !== row.organizationId) return notFoundOrInaccessible();
  }
  return [...rows];
}

function paginateEvents(
  ctx: QueryCtx,
  args: {
    organizationId: Id<'organizations'>;
    projectId?: Id<'projects'>;
    status?: EventStatus;
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<Doc<'events'>>> {
  const { organizationId, projectId, status, paginationOpts } = args;
  const events = ctx.db.query('events');
  if (projectId !== undefined) {
    return status === undefined
      ? events.withIndex('by_project_startsAt', (q) => q.eq('projectId', projectId)).paginate(paginationOpts)
      : events
          .withIndex('by_project_status_startsAt', (q) => q.eq('projectId', projectId).eq('status', status))
          .paginate(paginationOpts);
  }
  return status === undefined
    ? events.withIndex('by_org_startsAt', (q) => q.eq('organizationId', organizationId)).paginate(paginationOpts)
    : events
        .withIndex('by_org_status_startsAt', (q) => q.eq('organizationId', organizationId).eq('status', status))
        .paginate(paginationOpts);
}

export async function listProjectEvents(
  ctx: QueryCtx,
  args: { projectId: Id<'projects'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'events'>>> {
  const { project } = await requireProjectAccess(ctx, args.projectId);
  return ctx.db
    .query('events')
    .withIndex('by_project_startsAt', (q) => q.eq('projectId', project._id))
    .paginate(args.paginationOpts);
}

export async function updateEvent(ctx: MutationCtx, eventId: Id<'events'>, patch: EventPatch): Promise<void> {
  const { event, project, access } = await requireEventAccess(ctx, eventId, authoringRole);
  assertProjectAcceptsEventWrites(project);
  if (event.status === 'archived') return invalidInput('eventArchived', 'Archived events cannot be updated');
  const name = patch.name === undefined ? undefined : validateEntityName(patch.name, 'event');
  const startsAt = patch.startsAt ?? event.startsAt;
  const endsAt = resolveOptional(patch.endsAt, event.endsAt);
  validateEventDates(startsAt, endsAt);
  validateEventWithinProjectWindow(project, startsAt, endsAt);

  const venueLocationId = resolveOptional(patch.venueLocationId, event.venueLocationId);
  const clientCostCentreId = resolveOptional(patch.clientCostCentreId, event.clientCostCentreId);
  const accountableUserId = resolveOptional(patch.accountableUserId, event.accountableUserId);
  const budgetAmount = resolveOptional(patch.budgetAmount, event.budgetAmount);
  const budgetCurrency = resolveOptional(patch.budgetCurrency, event.budgetCurrency);
  // Only a reference the patch actually supplies is re-proven. Re-proving the
  // stored ones would make an unrelated rename fail once a venue is archived,
  // which is the opposite of the archival policy: archived rows stay readable
  // where they are already referenced, they are merely unselectable anew.
  await assertEventReferences(ctx, event.organizationId, {
    ...(isSupplied(patch.venueLocationId) ? { venueLocationId: patch.venueLocationId } : {}),
    ...(isSupplied(patch.clientCostCentreId) ? { clientCostCentreId: patch.clientCostCentreId } : {}),
    ...(isSupplied(patch.accountableUserId) ? { accountableUserId: patch.accountableUserId } : {}),
  });
  // The budget pair is checked on the RESOLVED values, not the supplied ones:
  // clearing or adding one half alone would otherwise leave a half-stored
  // budget that no single call ever looked at as a pair.
  validateEventBudget(budgetAmount, budgetCurrency);

  const update: EventUpdate = {};
  const changedFields: string[] = [];
  if (name !== undefined && name !== event.name) {
    update.name = name;
    changedFields.push('name');
  }
  if (patch.startsAt !== undefined && patch.startsAt !== event.startsAt) {
    update.startsAt = patch.startsAt;
    changedFields.push('startsAt');
  }
  if (patch.endsAt !== undefined && endsAt !== event.endsAt) {
    update.endsAt = endsAt;
    changedFields.push('endsAt');
  }
  if (patch.venueLocationId !== undefined && venueLocationId !== event.venueLocationId) {
    update.venueLocationId = venueLocationId;
    changedFields.push('venueLocationId');
  }
  if (patch.clientCostCentreId !== undefined && clientCostCentreId !== event.clientCostCentreId) {
    update.clientCostCentreId = clientCostCentreId;
    changedFields.push('clientCostCentreId');
  }
  if (patch.budgetAmount !== undefined && budgetAmount !== event.budgetAmount) {
    update.budgetAmount = budgetAmount;
    changedFields.push('budgetAmount');
  }
  if (patch.budgetCurrency !== undefined && budgetCurrency !== event.budgetCurrency) {
    update.budgetCurrency = budgetCurrency;
    changedFields.push('budgetCurrency');
  }
  if (patch.accountableUserId !== undefined && accountableUserId !== event.accountableUserId) {
    update.accountableUserId = accountableUserId;
    changedFields.push('accountableUserId');
  }
  if (changedFields.length === 0) return;
  await ctx.db.patch(event._id, update);
  await recordAuditEvent(ctx, {
    organizationId: event.organizationId,
    actorUserId: access.user._id,
    action: 'event.updated',
    entityType: 'event',
    entityId: event._id,
    metadata: { changedFields: changedFields.join(',') },
  });
}

export async function changeEventStatus(
  ctx: MutationCtx,
  args: { eventId: Id<'events'>; status: EventStatus },
): Promise<void> {
  const { event, project, access } = await requireEventAccess(ctx, args.eventId, authoringRole);
  assertProjectAcceptsEventWrites(project);
  if (args.status === 'archived') {
    return invalidInput('eventArchiveRequired', 'Use archiveEvent to archive an event');
  }
  assertEventTransition(event.status, args.status);
  await ctx.db.patch(event._id, { status: args.status });
  await recordAuditEvent(ctx, {
    organizationId: event.organizationId,
    actorUserId: access.user._id,
    action: 'event.statusChanged',
    entityType: 'event',
    entityId: event._id,
    metadata: { previousStatus: event.status, status: args.status },
  });
}

/** Archival changes only the Event; its Services are neither patched nor cancelled. */
export async function archiveEvent(ctx: MutationCtx, eventId: Id<'events'>): Promise<void> {
  const { event, project, access } = await requireEventAccess(ctx, eventId, authoringRole);
  assertProjectAcceptsEventWrites(project);
  assertEventTransition(event.status, 'archived');
  await ctx.db.patch(event._id, { status: 'archived' });
  await recordAuditEvent(ctx, {
    organizationId: event.organizationId,
    actorUserId: access.user._id,
    action: 'event.archived',
    entityType: 'event',
    entityId: event._id,
    metadata: { previousStatus: event.status },
  });
}

/**
 * Hard deletion is only available while the Event is unreferenced. The indexed
 * first-hit guard makes the rule independent of tenant size. There is no
 * cascade: even one Service refuses deletion, and archival likewise never
 * changes a child Service.
 */
export async function deleteEvent(ctx: MutationCtx, eventId: Id<'events'>): Promise<void> {
  const { event, project, access } = await requireEventAccess(ctx, eventId, authoringRole);
  assertProjectAcceptsEventWrites(project);
  if (event.status !== 'archived') return invalidInput('eventDeleteRequiresArchive', 'Events must be archived before deletion');
  const service = await ctx.db
    .query('services')
    .withIndex('by_event_startsAt', (q) => q.eq('eventId', event._id))
    .first();
  if (service !== null) return invalidInput('eventDeleteBlocked', 'Events referenced by services cannot be deleted');
  await recordAuditEvent(ctx, {
    organizationId: event.organizationId,
    actorUserId: access.user._id,
    action: 'event.deleted',
    entityType: 'event',
    entityId: event._id,
    metadata: { name: event.name },
  });
  await ctx.db.delete(event._id);
}

/**
 * Resolves the stored Event→Project chain before authorization. The equality
 * check proves the redundant organization link and treats corrupt, missing,
 * and foreign graphs identically (I1/I4/I9).
 */
export async function requireEventAccess(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<'events'>,
  minimumRole?: Role,
): Promise<{ event: Doc<'events'>; project: Doc<'projects'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const event = await ctx.db.get(eventId);
  if (event === null) return notFoundOrInaccessible();
  const project = await ctx.db.get(event.projectId);
  if (project === null || project.organizationId !== event.organizationId) return notFoundOrInaccessible();
  const access =
    minimumRole === undefined
      ? await requireOrganizationMembership(ctx, event.organizationId, authenticated)
      : await requireOrganizationRole(ctx, event.organizationId, minimumRole, authenticated);
  return { event, project, access };
}

function assertEventTransition(current: EventStatus, next: EventStatus): void {
  if (eventStatusTransitions[current].length === 0) {
    return invalidInput('eventTerminal', 'Archived events are terminal');
  }
  if (!eventStatusTransitions[current].includes(next)) {
    return invalidInput('eventStatusTransitionInvalid', 'Event status transition is not permitted');
  }
}

/** An archived Project freezes every write to its Events, matching its Services. */
function assertProjectAcceptsEventWrites(project: Doc<'projects'>): void {
  assertProjectAcceptsChildWrites(project, 'eventProjectReadOnly', 'events');
}

/** The one Event-lifecycle gate used when attaching a newly created Service. */
export function assertEventAcceptsNewServices(event: Doc<'events'>): void {
  const acceptingStatuses: ReadonlySet<EventStatus> = new Set(['draft', 'active']);
  if (!acceptingStatuses.has(event.status)) {
    return invalidInput('serviceEventUnavailable', 'Only draft and active events can receive new services');
  }
}

/**
 * The single gate for every Event context reference, used identically by the
 * create and update door.
 *
 * Both doors call this BEFORE `validateEventBudget`, deliberately: every
 * supplied id is resolved and scope-checked against the Event's organization
 * before any purely local input error can be reported, so a malformed budget
 * in the same call can never become an oracle that answers faster than the
 * tenant proof (I1/I9). Each resolver collapses "does not exist", "belongs to
 * another tenant" and "archived" into the same generic error, so nothing here
 * can be used to probe another tenant's catalogue.
 */
async function assertEventReferences(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<'organizations'>,
  context: EventReferences,
): Promise<void> {
  if (context.venueLocationId !== undefined) {
    // Ownership, existence and archival are proven first and generically; only
    // then does the code-owned taxonomy become a reportable input error, so a
    // foreign location's type is never disclosed.
    const location = await assertUsableLocation(ctx, context.venueLocationId, organizationId);
    if (location.type !== 'venue') {
      return invalidInput('eventVenueLocationTypeInvalid', 'An event venue must be a location of type venue');
    }
  }
  if (context.clientCostCentreId !== undefined) {
    await assertUsableCostCentre(ctx, context.clientCostCentreId, organizationId);
  }
  if (context.accountableUserId !== undefined) {
    await assertCurrentMember(ctx, context.accountableUserId, organizationId);
  }
}

/**
 * A budget is a pair or it is nothing: an amount without its currency is not a
 * money value, and a currency without an amount states nothing. The amount goes
 * through the shared money boundary, so an Event budget is integer minor units
 * on exactly the same terms as every other persisted money figure (#83).
 */
function validateEventBudget(amount: number | undefined, currency: Currency | undefined): void {
  if ((amount === undefined) !== (currency === undefined)) {
    return invalidInput('eventBudgetIncomplete', 'Event budget amount and currency must be provided together');
  }
  if (amount !== undefined) assertMinorUnits(amount);
}

/** `undefined` keeps the stored value, `null` clears it, anything else replaces it. */
function resolveOptional<T>(patched: T | null | undefined, stored: T | undefined): T | undefined {
  if (patched === undefined) return stored;
  return patched === null ? undefined : patched;
}

/** Narrows a patch member to the "replace with this value" case. */
function isSupplied<T>(patched: T | null | undefined): patched is T {
  return patched !== undefined && patched !== null;
}

function validateEventDates(startsAt: number, endsAt: number | undefined): void {
  if (!isFiniteNumber(startsAt)) return invalidInput('eventStartInvalid', 'Event start must be a finite timestamp');
  if (endsAt !== undefined && !isFiniteNumber(endsAt)) return invalidInput('eventEndInvalid', 'Event end must be a finite timestamp');
  if (endsAt !== undefined && endsAt < startsAt) return invalidInput('eventDateRangeInvalid', 'Event end must not precede its start');
}

function validateEventWithinProjectWindow(project: Doc<'projects'>, startsAt: number, endsAt: number | undefined): void {
  if (project.startsAt !== undefined && startsAt < project.startsAt) {
    return invalidInput('eventBeforeProjectWindow', 'Event starts before its project window');
  }
  if (project.endsAt !== undefined && (endsAt ?? startsAt) > project.endsAt) {
    return invalidInput('eventAfterProjectWindow', 'Event ends after its project window');
  }
}
