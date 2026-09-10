import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { recordAuditEvent } from '../audit/model';
import { assertUsableCostCentre } from '../costCentres/model';
import {
  auditActorFor,
  requireAuthenticatedUser,
  requirePrincipalForProject,
  type Principal,
  type ProjectIntent,
} from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { assertMinorUnits } from '../lib/money';
import { assertUsableProvider } from '../providers/model';
import { resolveRateForAssignment } from '../rateCards/model';
import { assertServiceWritable } from '../services/model';
import type { rateModalityValidator } from '../validators';
import { assertUsableVehicleClass } from '../vehicles/classes';
import { lineTotal } from './costing';

type RateModality = typeof rateModalityValidator.type;

/** The enforced ceiling that makes a Service's complete child read bounded. */
export const maxAssignmentsPerService = 200;
const maxAssignmentNotesLength = 2000;
const maxDeclinedReasonLength = 1000;

type AssignmentAccess = {
  assignment: Doc<'assignments'>;
  principal: Principal;
};

/**
 * The thin Assignment gate promised by I1. It resolves only the stable row and
 * delegates policy to the one Project principal gate. Supplying the row's
 * Provider narrows a dual-firm caller to the principal that owns this target;
 * list paths omit it so the centralized resolver can return the full union.
 */
export async function requireAssignmentAccess(
  ctx: QueryCtx | MutationCtx,
  assignmentId: Id<'assignments'>,
  intent: ProjectIntent,
): Promise<AssignmentAccess> {
  // Authentication precedes the caller-controlled id, preserving I9 for both
  // real and fabricated ids. The delegated gate re-proves it as part of its
  // complete access chain.
  await requireAuthenticatedUser(ctx);
  const assignment = await ctx.db.get(assignmentId);
  if (assignment === null) return notFoundOrInaccessible();
  const principal = await requirePrincipalForProject(
    ctx,
    assignment.projectId,
    intent,
    assignment.providerId,
  );
  return { assignment, principal };
}

export async function createAssignment(
  ctx: MutationCtx,
  args: {
    serviceId: Id<'services'>;
    providerId: Id<'providers'>;
    costCentreId?: Id<'costCentres'>;
    position: number;
    notes?: string;
  },
): Promise<Id<'assignments'>> {
  await requireAuthenticatedUser(ctx);
  const service = await ctx.db.get(args.serviceId);
  if (service === null) return notFoundOrInaccessible();
  const principal = await requirePrincipalForProject(ctx, service.projectId, 'writeAssignmentTerms');
  const project = await ctx.db.get(service.projectId);
  if (project === null || project.organizationId !== service.organizationId) {
    return notFoundOrInaccessible();
  }
  // Prove every caller-controlled reference before exposing lifecycle state.
  await assertUsableProvider(ctx, args.providerId, service.organizationId);
  if (args.costCentreId !== undefined) {
    await assertUsableCostCentre(ctx, args.costCentreId, service.organizationId);
  }
  assertServiceWritable(service, project);
  assertPosition(args.position);
  const notes = validateNotes(args.notes);

  // The Event default is not a caller choice: its ownership was proven when
  // written. Copy it without an archival re-check so catalogue configuration
  // cannot block operational work after the Event has already selected it.
  //
  // The org equality below is unreachable today — `service.eventId` has one
  // writer, and it resolves the Event through a gate that already proves this.
  // It is re-proven anyway because I4 says a denormalized link is checked and
  // never trusted, and because the day an Event can be re-parented this line
  // would otherwise stamp a foreign Cost Centre onto a local Assignment that
  // no update path exists to correct.
  let inheritedCostCentreId: Id<'costCentres'> | undefined;
  if (args.costCentreId === undefined) {
    const event = await ctx.db.get(service.eventId);
    if (event === null || event.organizationId !== service.organizationId) {
      return notFoundOrInaccessible();
    }
    inheritedCostCentreId = event.clientCostCentreId;
  }
  const costCentreId = args.costCentreId ?? inheritedCostCentreId;

  const duplicatePosition = await ctx.db
    .query('assignments')
    .withIndex('by_service_position', (q) =>
      q.eq('serviceId', service._id).eq('position', args.position),
    )
    .first();
  if (duplicatePosition !== null) return conflict();
  const existing = await ctx.db
    .query('assignments')
    .withIndex('by_service_position', (q) => q.eq('serviceId', service._id))
    .take(maxAssignmentsPerService);
  if (existing.length >= maxAssignmentsPerService) {
    return invalidInput('assignmentLimitExceeded', `A Service cannot hold more than ${maxAssignmentsPerService} Assignments`);
  }

  const assignmentId = await ctx.db.insert('assignments', {
    organizationId: service.organizationId,
    serviceId: service._id,
    projectId: service.projectId,
    providerId: args.providerId,
    ...(costCentreId === undefined ? {} : { costCentreId }),
    position: args.position,
    ...(notes === undefined ? {} : { notes }),
  });
  await recordAuditEvent(ctx, {
    organizationId: service.organizationId,
    ...auditActorFor(principal),
    action: 'assignment.created',
    entityType: 'assignment',
    entityId: assignmentId,
    // Attribution is recorded here because it is materialized once and no update
    // path exists: without it the log cannot answer who a movement was charged to.
    metadata: {
      providerId: args.providerId,
      position: args.position,
      ...(costCentreId === undefined ? {} : { costCentreId }),
    },
  });
  return assignmentId;
}

export async function removeAssignment(
  ctx: MutationCtx,
  assignmentId: Id<'assignments'>,
): Promise<void> {
  const { assignment, principal } = await requireAssignmentAccess(
    ctx,
    assignmentId,
    'writeAssignmentTerms',
  );
  const { service, project } = await loadAssignmentService(ctx, assignment);
  assertServiceWritable(service, project);
  const revision = await ctx.db
    .query('assignmentRevisions')
    .withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id))
    .first();
  if (revision !== null) {
    return invalidInput('assignmentRemoveBlocked', 'Assignments with negotiation history cannot be removed');
  }
  await recordAuditEvent(ctx, {
    organizationId: assignment.organizationId,
    ...auditActorFor(principal),
    action: 'assignment.removed',
    entityType: 'assignment',
    entityId: assignment._id,
    metadata: { providerId: assignment.providerId, position: assignment.position },
  });
  await ctx.db.delete(assignment._id);
}

export async function createAssignmentRevision(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<'assignments'>;
    vehicleClassId: Id<'vehicleClasses'>;
    modality: RateModality;
    quantity: number;
    rateCardVersionId: Id<'rateCardVersions'>;
    rateLineId: Id<'rateLines'>;
  },
): Promise<Id<'assignmentRevisions'>> {
  const { assignment, principal } = await requireAssignmentAccess(
    ctx,
    args.assignmentId,
    'writeAssignmentTerms',
  );
  assertQuantity(args.quantity);

  // Resolve all commercial references through their existing single-purpose
  // gates before exposing whether the Service itself is writable (I1/I9).
  await assertUsableProvider(ctx, assignment.providerId, assignment.organizationId);
  await assertUsableVehicleClass(ctx, args.vehicleClassId, assignment.organizationId);
  const rate = await resolveRateForAssignment(ctx, {
    rateCardVersionId: args.rateCardVersionId,
    providerId: assignment.providerId,
    vehicleClassId: args.vehicleClassId,
    modality: args.modality,
  });
  if (rate.rateLineId !== args.rateLineId) return notFoundOrInaccessible();
  assertMinorUnits(rate.unitAmount);
  const resolvedLineTotal = lineTotal(rate.unitAmount, args.quantity);

  const { service, project } = await loadAssignmentService(ctx, assignment);
  assertServiceWritable(service, project);
  const latest = await ctx.db
    .query('assignmentRevisions')
    .withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id))
    .order('desc')
    .first();
  const revisionNumber = (latest?.revisionNumber ?? 0) + 1;
  const revisionId = await ctx.db.insert('assignmentRevisions', {
    organizationId: assignment.organizationId,
    assignmentId: assignment._id,
    revisionNumber,
    status: 'draft',
    vehicleClassId: args.vehicleClassId,
    modality: args.modality,
    quantity: args.quantity,
    rateCardVersionId: args.rateCardVersionId,
    rateLineId: rate.rateLineId,
    unitAmount: rate.unitAmount,
    currency: rate.currency,
    lineTotal: resolvedLineTotal,
  });
  await recordAuditEvent(ctx, {
    organizationId: assignment.organizationId,
    ...auditActorFor(principal),
    action: 'assignmentRevision.created',
    entityType: 'assignmentRevision',
    entityId: revisionId,
    metadata: { assignmentId: assignment._id, versionNumber: revisionNumber },
  });
  return revisionId;
}

export async function acceptAssignmentRevision(
  ctx: MutationCtx,
  revisionId: Id<'assignmentRevisions'>,
): Promise<void> {
  const { revision, assignment, principal } = await requireRevisionAccess(
    ctx,
    revisionId,
    'writeAssignmentTerms',
  );
  const { service, project } = await loadAssignmentService(ctx, assignment);
  assertServiceWritable(service, project);
  if (revision.status !== 'draft') {
    return invalidInput('assignmentRevisionNotDraft', 'Only draft Assignment Revisions can be accepted');
  }

  const accepted = await ctx.db
    .query('assignmentRevisions')
    .withIndex('by_assignment_status', (q) =>
      q.eq('assignmentId', assignment._id).eq('status', 'accepted'),
    )
    .unique();
  assertCurrentRevisionMirror(assignment, accepted);
  if (accepted !== null) {
    // Commercial columns are immutable. Status is intentionally NOT frozen:
    // accepted -> superseded is the mechanism that installs replacement terms.
    await ctx.db.patch(accepted._id, { status: 'superseded' });
    await recordAuditEvent(ctx, {
      organizationId: assignment.organizationId,
      ...auditActorFor(principal),
      action: 'assignmentRevision.superseded',
      entityType: 'assignmentRevision',
      entityId: accepted._id,
      metadata: { assignmentId: assignment._id, versionNumber: accepted.revisionNumber },
    });
  }

  const acceptedAt = Date.now();
  await ctx.db.patch(revision._id, {
    status: 'accepted',
    acceptedAt,
    acceptedByUserId: principal.user._id,
  });
  // The denormalized pointer moves in this same transaction and can therefore
  // never be observed pointing at the just-superseded row.
  await ctx.db.patch(assignment._id, { currentRevisionId: revision._id });
  await recordAuditEvent(ctx, {
    organizationId: assignment.organizationId,
    ...auditActorFor(principal),
    action: 'assignmentRevision.accepted',
    entityType: 'assignmentRevision',
    entityId: revision._id,
    metadata: { assignmentId: assignment._id, versionNumber: revision.revisionNumber },
  });
}

export async function declineAssignmentRevision(
  ctx: MutationCtx,
  args: { revisionId: Id<'assignmentRevisions'>; reason?: string },
): Promise<void> {
  const { revision, assignment, principal } = await requireRevisionAccess(
    ctx,
    args.revisionId,
    'writeAssignmentTerms',
  );
  const { service, project } = await loadAssignmentService(ctx, assignment);
  assertServiceWritable(service, project);
  if (revision.status !== 'draft') {
    return invalidInput('assignmentRevisionNotDeclinable', 'Only draft Assignment Revisions can be declined');
  }
  const reason = validateDeclinedReason(args.reason);
  await ctx.db.patch(revision._id, {
    status: 'declined',
    ...(reason === undefined ? {} : { declinedReason: reason }),
  });
  await recordAuditEvent(ctx, {
    organizationId: assignment.organizationId,
    ...auditActorFor(principal),
    action: 'assignmentRevision.declined',
    entityType: 'assignmentRevision',
    entityId: revision._id,
    metadata: { assignmentId: assignment._id, versionNumber: revision.revisionNumber },
  });
}

/**
 * The Provider arm's Assignment shape.
 *
 * `docs/provider-access.md` may-not-see #7 forbids a Provider from learning the
 * party a movement is charged to, and #9 names the Event's `clientCostCentreId`
 * specifically. Whenever the Event default was inherited, `costCentreId` IS that
 * value copied verbatim, so returning the stored row would smuggle the forbidden
 * field back as data hanging off an Assignment — exactly the shape may-not-see #1
 * rules out. Filtering rows is not enough; the columns have to narrow too.
 *
 * The body is a whitelist and the return type is an `Omit` of the stored row, so
 * a new REQUIRED Assignment column fails to compile here until someone decides
 * whether a Provider may see it, and a new OPTIONAL one is excluded by default.
 * Both outcomes fail closed. #87 owns the wider Service projection; this is only
 * the Assignment row itself.
 */
type ProviderAssignmentView = Omit<Doc<'assignments'>, 'costCentreId'>;

function providerAssignmentView(assignment: Doc<'assignments'>): ProviderAssignmentView {
  return {
    _id: assignment._id,
    _creationTime: assignment._creationTime,
    organizationId: assignment.organizationId,
    serviceId: assignment.serviceId,
    projectId: assignment.projectId,
    providerId: assignment.providerId,
    position: assignment.position,
    ...(assignment.notes === undefined ? {} : { notes: assignment.notes }),
    ...(assignment.currentRevisionId === undefined
      ? {}
      : { currentRevisionId: assignment.currentRevisionId }),
  };
}

export async function getAssignment(
  ctx: QueryCtx,
  assignmentId: Id<'assignments'>,
): Promise<Doc<'assignments'> | ProviderAssignmentView> {
  const { assignment, principal } = await requireAssignmentAccess(ctx, assignmentId, 'readAssignment');
  return principal.kind === 'provider' ? providerAssignmentView(assignment) : assignment;
}

export async function getAssignmentRevision(
  ctx: QueryCtx,
  revisionId: Id<'assignmentRevisions'>,
): Promise<Doc<'assignmentRevisions'>> {
  return (await requireRevisionAccess(ctx, revisionId, 'readAssignment')).revision;
}

export async function listAssignmentRevisions(
  ctx: QueryCtx,
  args: { assignmentId: Id<'assignments'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'assignmentRevisions'>>> {
  const { assignment } = await requireAssignmentAccess(ctx, args.assignmentId, 'readAssignment');
  return ctx.db
    .query('assignmentRevisions')
    .withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id))
    .paginate(args.paginationOpts);
}

export async function listServiceAssignments(
  ctx: QueryCtx,
  serviceId: Id<'services'>,
): Promise<(Doc<'assignments'> | ProviderAssignmentView)[]> {
  await requireAuthenticatedUser(ctx);
  const service = await ctx.db.get(serviceId);
  if (service === null) return notFoundOrInaccessible();
  const principal = await requirePrincipalForProject(ctx, service.projectId, 'readAssignment');
  const project = await ctx.db.get(service.projectId);
  if (project === null || project.organizationId !== service.organizationId) {
    return notFoundOrInaccessible();
  }
  const assignments = await ctx.db
    .query('assignments')
    .withIndex('by_service_position', (q) => q.eq('serviceId', service._id))
    .take(maxAssignmentsPerService);
  // Response shaping is separate from principal resolution, and it narrows in
  // BOTH directions: a Provider sees only the union of its granted firms' rows
  // (which rows), and only the columns its arm may read (which fields).
  return principal.kind === 'provider'
    ? assignments
        .filter((assignment) => principal.accessibleProviderIds.has(assignment.providerId))
        .map(providerAssignmentView)
    : assignments;
}

export async function listProjectAssignments(
  ctx: QueryCtx,
  args: { projectId: Id<'projects'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'assignments'> | ProviderAssignmentView>> {
  const principal = await requirePrincipalForProject(ctx, args.projectId, 'readAssignment');
  if (principal.kind !== 'provider') {
    return ctx.db
      .query('assignments')
      .withIndex('by_project_position', (q) => q.eq('projectId', args.projectId))
      .paginate(args.paginationOpts);
  }
  // The page is narrowed to the Provider arm's columns after pagination, so the
  // index range and page size stay exactly what the member path uses (I6).
  const page = await (principal.accessibleProviderIds.size === 1
      ? ctx.db
          .query('assignments')
          .withIndex('by_project_provider_position', (q) =>
            q.eq('projectId', args.projectId).eq('providerId', principal.providerId),
          )
          .paginate(args.paginationOpts)
      : ctx.db
          .query('assignments')
          .withIndex('by_project_position', (q) => q.eq('projectId', args.projectId))
          .filter((q) => q.or(
            ...[...principal.accessibleProviderIds].map((providerId) =>
              q.eq(q.field('providerId'), providerId),
            ),
          ))
          .paginate(args.paginationOpts));
  return { ...page, page: page.page.map(providerAssignmentView) };
}

async function requireRevisionAccess(
  ctx: QueryCtx | MutationCtx,
  revisionId: Id<'assignmentRevisions'>,
  intent: ProjectIntent,
): Promise<{
  revision: Doc<'assignmentRevisions'>;
  assignment: Doc<'assignments'>;
  principal: Principal;
}> {
  await requireAuthenticatedUser(ctx);
  const revision = await ctx.db.get(revisionId);
  if (revision === null) return notFoundOrInaccessible();
  const { assignment, principal } = await requireAssignmentAccess(ctx, revision.assignmentId, intent);
  if (revision.organizationId !== assignment.organizationId) return notFoundOrInaccessible();
  return { revision, assignment, principal };
}

async function loadAssignmentService(
  ctx: QueryCtx | MutationCtx,
  assignment: Doc<'assignments'>,
): Promise<{ service: Doc<'services'>; project: Doc<'projects'> }> {
  const service = await ctx.db.get(assignment.serviceId);
  if (
    service === null ||
    service.organizationId !== assignment.organizationId ||
    service.projectId !== assignment.projectId
  ) return notFoundOrInaccessible();
  const project = await ctx.db.get(service.projectId);
  if (project === null || project.organizationId !== service.organizationId) {
    return notFoundOrInaccessible();
  }
  return { service, project };
}

function assertCurrentRevisionMirror(
  assignment: Doc<'assignments'>,
  accepted: Doc<'assignmentRevisions'> | null,
): void {
  if (
    (accepted === null && assignment.currentRevisionId !== undefined) ||
    (accepted !== null && assignment.currentRevisionId !== accepted._id)
  ) return notFoundOrInaccessible();
}

function assertPosition(position: number): void {
  if (!Number.isSafeInteger(position) || position < 0) {
    return invalidInput('assignmentPositionInvalid', 'Assignment position must be a non-negative safe integer');
  }
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return invalidInput('assignmentRevisionQuantityInvalid', 'Assignment quantity must be a positive safe integer');
  }
}

function validateNotes(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined;
  const trimmed = notes.trim();
  if (trimmed.length > maxAssignmentNotesLength) {
    return invalidInput('assignmentNotesTooLong', `Assignment notes must not exceed ${maxAssignmentNotesLength} characters`);
  }
  return trimmed;
}

function validateDeclinedReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const trimmed = reason.trim();
  if (trimmed.length > maxDeclinedReasonLength) {
    return invalidInput('assignmentDeclinedReasonTooLong', `Declined reason must not exceed ${maxDeclinedReasonLength} characters`);
  }
  return trimmed;
}
