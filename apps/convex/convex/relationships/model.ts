import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { requireAuthenticatedUser } from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import type { Role } from '../lib/roles';
import { assertEventWritable, assertProjectAcceptsEventWrites, requireEventAccess } from '../events/model';
import type { relationshipTypeValidator } from '../validators';

type RelationshipType = typeof relationshipTypeValidator.type;
type RelationshipWithCounterpart = Doc<'eventRelationships'> & {
  counterpartEvent: Pick<Doc<'events'>, '_id' | 'name' | 'status'>;
};

/** Relationship authoring has the same planner-and-above floor as Event authoring. */
const authoringRole: Role = 'planner';

/**
 * Stores a typed directed link between two Events in one organization.
 *
 * Relationships deliberately do not run workflows and do not detect cycles:
 * this is a structured link catalogue, not a workflow engine (I8). Events are
 * never deleted, so there is no event-delete cascade to maintain.
 *
 * LIFECYCLE POLICY (stated once, for both write paths below): a link is a write
 * to its SOURCE Event, so it passes the same gate every other event write passes
 * — `assertEventWritable` from events/model.ts. Archival is a freeze through
 * every door, relationships included: a fully archived project's events cannot
 * gain or lose links, and neither can a cancelled or completed event. Without
 * this, a planner could restructure the link graph of frozen history, which is
 * exactly what the freeze exists to prevent.
 *
 * The TARGET is gated on its project only (`assertProjectAcceptsEventWrites`),
 * not on its own status: pointing a live event at a completed one — "this
 * follows the arrival that already happened" — is ordinary planning, whereas
 * writing anything into an archived project is not.
 */
export async function createRelationship(
  ctx: MutationCtx,
  args: { sourceEventId: Id<'events'>; targetEventId: Id<'events'>; type: RelationshipType },
): Promise<Id<'eventRelationships'>> {
  // Authenticate before either caller-supplied Event id is resolved (I9).
  const authenticated = await requireAuthenticatedUser(ctx);
  if (args.sourceEventId === args.targetEventId) return invalidInput('An Event cannot relate to itself');

  const { event: sourceEvent, project: sourceProject, access } = await requireEventAccess(ctx, args.sourceEventId, authoringRole, authenticated);
  const { event: targetEvent, project: targetProject } = await requireEventAccess(ctx, args.targetEventId, authoringRole, authenticated);
  // The two organizations come from Events whose stored project ownership was
  // checked by requireEventAccess, never from client-provided organization ids.
  if (sourceEvent.organizationId !== targetEvent.organizationId) return notFoundOrInaccessible();
  // Lifecycle comes after the tenancy check on purpose: its messages are
  // specific, and a caller must never learn a foreign event's status (I9).
  assertEventWritable(sourceEvent, sourceProject);
  assertProjectAcceptsEventWrites(targetProject);

  const existing = await ctx.db
    .query('eventRelationships')
    .withIndex('by_source_target_type', (q) =>
      q.eq('sourceEventId', sourceEvent._id).eq('targetEventId', targetEvent._id).eq('type', args.type),
    )
    .unique();
  if (existing !== null) return conflict();

  const relationshipId = await ctx.db.insert('eventRelationships', {
    organizationId: sourceEvent.organizationId,
    sourceEventId: sourceEvent._id,
    targetEventId: targetEvent._id,
    type: args.type,
  });
  await recordAuditEvent(ctx, {
    organizationId: sourceEvent.organizationId,
    actorUserId: access.user._id,
    action: 'relationship.created',
    entityType: 'eventRelationship',
    entityId: relationshipId,
    // Both endpoints are recorded: the row is hard-deleted on removal, so a
    // `created` entry read in isolation must still say what the link joined.
    metadata: { type: args.type, sourceEventId: sourceEvent._id, targetEventId: targetEvent._id },
  });
  return relationshipId;
}

/**
 * Deletes a relationship link after auditing it. Hard deletion is intentional:
 * links are not historical operational records, and Events themselves remain.
 *
 * Removal is a write to the source Event and passes the same lifecycle gate as
 * creation — see the policy on `createRelationship`.
 */
export async function removeRelationship(ctx: MutationCtx, relationshipId: Id<'eventRelationships'>): Promise<void> {
  // Authentication precedes the caller-supplied relationship lookup (I9).
  const authenticated = await requireAuthenticatedUser(ctx);
  const relationship = await ctx.db.get(relationshipId);
  if (relationship === null) return notFoundOrInaccessible();
  // Authorization follows the stored Event graph rather than the link's own
  // denormalized organizationId (I4), matching how requireEventAccess derives a
  // project's org and loadVersion derives a version's: the column is a cache for
  // indexing, never the authority. A row whose column disagrees with its source
  // Event is inconsistent, and inconsistency is refused generically.
  const { event: sourceEvent, project: sourceProject, access } = await requireEventAccess(
    ctx,
    relationship.sourceEventId,
    authoringRole,
    authenticated,
  );
  if (relationship.organizationId !== sourceEvent.organizationId) return notFoundOrInaccessible();
  assertEventWritable(sourceEvent, sourceProject);
  // Audit precedes delete, as with locations: the audit remains after the link.
  await recordAuditEvent(ctx, {
    organizationId: relationship.organizationId,
    actorUserId: access.user._id,
    action: 'relationship.removed',
    entityType: 'eventRelationship',
    entityId: relationship._id,
    metadata: {
      type: relationship.type,
      sourceEventId: relationship.sourceEventId,
      targetEventId: relationship.targetEventId,
    },
  });
  await ctx.db.delete(relationshipId);
}

/**
 * Two directional queries are intentional: no index spans both source and
 * target. Merging them would require an unbounded read before pagination (I6).
 */
export async function listOutgoingRelationships(
  ctx: QueryCtx,
  args: { eventId: Id<'events'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<RelationshipWithCounterpart>> {
  const { event } = await requireEventAccess(ctx, args.eventId);
  const result = await ctx.db
    .query('eventRelationships')
    .withIndex('by_source_target_type', (q) => q.eq('sourceEventId', event._id))
    .paginate(args.paginationOpts);
  return joinCounterparts(ctx, result, 'targetEventId');
}

export async function listIncomingRelationships(
  ctx: QueryCtx,
  args: { eventId: Id<'events'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<RelationshipWithCounterpart>> {
  const { event } = await requireEventAccess(ctx, args.eventId);
  const result = await ctx.db
    .query('eventRelationships')
    .withIndex('by_target', (q) => q.eq('targetEventId', event._id))
    .paginate(args.paginationOpts);
  return joinCounterparts(ctx, result, 'sourceEventId');
}

/**
 * Joins each link's counterpart Event onto the page.
 *
 * An anomalous row — counterpart gone, or its organization disagreeing with the
 * link's — is SKIPPED, not thrown on. The security argument does not rest on
 * this loop: the caller already proved access to the anchor Event via
 * `requireEventAccess`, and `createRelationship` only ever writes links whose
 * two endpoints and organization column are the same tenant's, so a row reaching
 * here with a mismatch is corruption rather than a leak vector. Failing the whole
 * page instead would let one inconsistent row make an entire directional list
 * permanently unreadable, with no way to see the healthy links or diagnose the
 * bad one. A short page is legal in Convex pagination, so skipping degrades the
 * read instead of destroying it.
 */
async function joinCounterparts(
  ctx: QueryCtx,
  result: PaginationResult<Doc<'eventRelationships'>>,
  counterpartIdField: 'sourceEventId' | 'targetEventId',
): Promise<PaginationResult<RelationshipWithCounterpart>> {
  const page: RelationshipWithCounterpart[] = [];
  for (const relationship of result.page) {
    const counterpartEvent = await ctx.db.get(relationship[counterpartIdField]);
    if (counterpartEvent === null || counterpartEvent.organizationId !== relationship.organizationId) continue;
    page.push({
      ...relationship,
      counterpartEvent: { _id: counterpartEvent._id, name: counterpartEvent.name, status: counterpartEvent.status },
    });
  }
  return { ...result, page };
}
