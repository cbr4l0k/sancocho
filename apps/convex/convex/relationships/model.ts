import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { requireAuthenticatedUser } from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import type { Role } from '../lib/roles';
import { assertServiceWritable, assertProjectAcceptsServiceWrites, requireServiceAccess } from '../services/model';
import type { relationshipTypeValidator } from '../validators';

type RelationshipType = typeof relationshipTypeValidator.type;
type RelationshipWithCounterpart = Doc<'serviceRelationships'> & {
  counterpartService: Pick<Doc<'services'>, '_id' | 'name' | 'status'>;
};

/** Relationship authoring has the same planner-and-above floor as Service authoring. */
const authoringRole: Role = 'planner';

/**
 * Stores a typed directed link between two Services in one organization.
 *
 * Relationships deliberately do not run workflows and do not detect cycles:
 * this is a structured link catalogue, not a workflow engine (I8). Services are
 * never deleted, so there is no service-delete cascade to maintain.
 *
 * LIFECYCLE POLICY (stated once, for both write paths below): a link is a write
 * to its SOURCE Service, so it passes the same gate every other service write passes
 * — `assertServiceWritable` from services/model.ts. Archival is a freeze through
 * every door, relationships included: a fully archived project's services cannot
 * gain or lose links, and neither can a cancelled or completed service. Without
 * this, a planner could restructure the link graph of frozen history, which is
 * exactly what the freeze exists to prevent.
 *
 * The TARGET is gated on its project only (`assertProjectAcceptsServiceWrites`),
 * not on its own status: pointing a live service at a completed one — "this
 * follows the arrival that already happened" — is ordinary planning, whereas
 * writing anything into an archived project is not.
 */
export async function createRelationship(
  ctx: MutationCtx,
  args: { sourceServiceId: Id<'services'>; targetServiceId: Id<'services'>; type: RelationshipType },
): Promise<Id<'serviceRelationships'>> {
  // Authenticate before either caller-supplied Service id is resolved (I9).
  const authenticated = await requireAuthenticatedUser(ctx);
  if (args.sourceServiceId === args.targetServiceId) return invalidInput('relationshipSelfReference', 'An Service cannot relate to itself');

  const { service: sourceService, project: sourceProject, access } = await requireServiceAccess(ctx, args.sourceServiceId, authoringRole, authenticated);
  const { service: targetService, project: targetProject } = await requireServiceAccess(ctx, args.targetServiceId, authoringRole, authenticated);
  // The two organizations come from Services whose stored project ownership was
  // checked by requireServiceAccess, never from client-provided organization ids.
  if (sourceService.organizationId !== targetService.organizationId) return notFoundOrInaccessible();
  // Lifecycle comes after the tenancy check on purpose: its messages are
  // specific, and a caller must never learn a foreign service's status (I9).
  assertServiceWritable(sourceService, sourceProject);
  assertProjectAcceptsServiceWrites(targetProject);

  const existing = await ctx.db
    .query('serviceRelationships')
    .withIndex('by_source_target_type', (q) =>
      q.eq('sourceServiceId', sourceService._id).eq('targetServiceId', targetService._id).eq('type', args.type),
    )
    .unique();
  if (existing !== null) return conflict();

  const relationshipId = await ctx.db.insert('serviceRelationships', {
    organizationId: sourceService.organizationId,
    sourceServiceId: sourceService._id,
    targetServiceId: targetService._id,
    type: args.type,
  });
  await recordAuditEvent(ctx, {
    organizationId: sourceService.organizationId,
    actorUserId: access.user._id,
    action: 'relationship.created',
    entityType: 'serviceRelationship',
    entityId: relationshipId,
    // Both endpoints are recorded: the row is hard-deleted on removal, so a
    // `created` entry read in isolation must still say what the link joined.
    metadata: { type: args.type, sourceServiceId: sourceService._id, targetServiceId: targetService._id },
  });
  return relationshipId;
}

/**
 * Deletes a relationship link after auditing it. Hard deletion is intentional:
 * links are not historical operational records, and Services themselves remain.
 *
 * Removal is a write to the source Service and passes the same lifecycle gate as
 * creation — see the policy on `createRelationship`.
 */
export async function removeRelationship(ctx: MutationCtx, relationshipId: Id<'serviceRelationships'>): Promise<void> {
  // Authentication precedes the caller-supplied relationship lookup (I9).
  const authenticated = await requireAuthenticatedUser(ctx);
  const relationship = await ctx.db.get(relationshipId);
  if (relationship === null) return notFoundOrInaccessible();
  // Authorization follows the stored Service graph rather than the link's own
  // denormalized organizationId (I4), matching how requireServiceAccess derives a
  // project's org and loadVersion derives a version's: the column is a cache for
  // indexing, never the authority. A row whose column disagrees with its source
  // Service is inconsistent, and inconsistency is refused generically.
  const { service: sourceService, project: sourceProject, access } = await requireServiceAccess(
    ctx,
    relationship.sourceServiceId,
    authoringRole,
    authenticated,
  );
  if (relationship.organizationId !== sourceService.organizationId) return notFoundOrInaccessible();
  assertServiceWritable(sourceService, sourceProject);
  // Audit precedes delete, as with locations: the audit remains after the link.
  await recordAuditEvent(ctx, {
    organizationId: relationship.organizationId,
    actorUserId: access.user._id,
    action: 'relationship.removed',
    entityType: 'serviceRelationship',
    entityId: relationship._id,
    metadata: {
      type: relationship.type,
      sourceServiceId: relationship.sourceServiceId,
      targetServiceId: relationship.targetServiceId,
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
  args: { serviceId: Id<'services'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<RelationshipWithCounterpart>> {
  const { service } = await requireServiceAccess(ctx, args.serviceId);
  const result = await ctx.db
    .query('serviceRelationships')
    .withIndex('by_source_target_type', (q) => q.eq('sourceServiceId', service._id))
    .paginate(args.paginationOpts);
  return joinCounterparts(ctx, result, 'targetServiceId');
}

export async function listIncomingRelationships(
  ctx: QueryCtx,
  args: { serviceId: Id<'services'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<RelationshipWithCounterpart>> {
  const { service } = await requireServiceAccess(ctx, args.serviceId);
  const result = await ctx.db
    .query('serviceRelationships')
    .withIndex('by_target', (q) => q.eq('targetServiceId', service._id))
    .paginate(args.paginationOpts);
  return joinCounterparts(ctx, result, 'sourceServiceId');
}

/**
 * Joins each link's counterpart Service onto the page.
 *
 * An anomalous row — counterpart gone, or its organization disagreeing with the
 * link's — is SKIPPED, not thrown on. The security argument does not rest on
 * this loop: the caller already proved access to the anchor Service via
 * `requireServiceAccess`, and `createRelationship` only ever writes links whose
 * two endpoints and organization column are the same tenant's, so a row reaching
 * here with a mismatch is corruption rather than a leak vector. Failing the whole
 * page instead would let one inconsistent row make an entire directional list
 * permanently unreadable, with no way to see the healthy links or diagnose the
 * bad one. A short page is legal in Convex pagination, so skipping degrades the
 * read instead of destroying it.
 */
async function joinCounterparts(
  ctx: QueryCtx,
  result: PaginationResult<Doc<'serviceRelationships'>>,
  counterpartIdField: 'sourceServiceId' | 'targetServiceId',
): Promise<PaginationResult<RelationshipWithCounterpart>> {
  const page: RelationshipWithCounterpart[] = [];
  for (const relationship of result.page) {
    const counterpartService = await ctx.db.get(relationship[counterpartIdField]);
    if (counterpartService === null || counterpartService.organizationId !== relationship.organizationId) continue;
    page.push({
      ...relationship,
      counterpartService: { _id: counterpartService._id, name: counterpartService.name, status: counterpartService.status },
    });
  }
  return { ...result, page };
}
