import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { recordAuditEvent } from '../audit/model';
import {
  requireAuthenticatedUser,
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { validateEntityName } from '../lib/names';
import type { Role } from '../lib/roles';
import { assertProjectAcceptsChildWrites, assertProjectAcceptsNewChildren, requireProjectAccess } from '../projects/model';
import { isFiniteNumber, type eventStatusValidator } from '../validators';

export type EventStatus = typeof eventStatusValidator.type;

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
type EventPatch = {
  name?: string;
  startsAt?: number;
  endsAt?: number | null;
};

/**
 * Creates an Event under a stored Project. `organizationId` is derived from
 * that Project in this transaction and is not part of any public argument (I4).
 * Resolving through `requireProjectAccess` proves, rather than assumes, that
 * the resulting Event and Project share an organization.
 */
export async function createEvent(
  ctx: MutationCtx,
  args: { projectId: Id<'projects'>; name: string } & EventDates,
): Promise<Id<'events'>> {
  const { project, access } = await requireProjectAccess(ctx, args.projectId, authoringRole);
  assertProjectAcceptsNewChildren(project, 'eventProjectUnavailable', 'events');
  const name = validateEntityName(args.name, 'event');
  validateEventDates(args.startsAt, args.endsAt);
  validateEventWithinProjectWindow(project, args.startsAt, args.endsAt);
  const eventId = await ctx.db.insert('events', {
    organizationId: project.organizationId,
    projectId: project._id,
    name,
    status: 'draft',
    startsAt: args.startsAt,
    ...(args.endsAt === undefined ? {} : { endsAt: args.endsAt }),
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
  const endsAt = patch.endsAt === undefined ? event.endsAt : patch.endsAt === null ? undefined : patch.endsAt;
  validateEventDates(startsAt, endsAt);
  validateEventWithinProjectWindow(project, startsAt, endsAt);

  const update: { name?: string; startsAt?: number; endsAt?: number | undefined } = {};
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
  if (event.status !== 'archived') return invalidInput('eventArchiveRequired', 'Events must be archived before deletion');
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
