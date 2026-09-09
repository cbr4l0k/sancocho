import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { recordAuditEvent } from '../audit/model';
import {
  auditActorFor,
  requireAuthenticatedUser,
  requirePrincipalForProject,
  type Principal,
  type ProjectIntent,
} from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { assertMinorUnits, multiply } from '../lib/money';
import { assertUsableProvider } from '../providers/model';
import { resolveRate } from '../rateCards/model';
import { assertServiceWritable } from '../services/model';
import type { rateModalityValidator } from '../validators';
import { assertUsableVehicleClass } from '../vehicles/classes';

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
 * Provider is the dual-firm correction: the centralized resolver refuses a
 * provider principal when the first matching grant belongs to another firm.
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
  assertServiceWritable(service, project);
  assertPosition(args.position);
  const notes = validateNotes(args.notes);

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
    position: args.position,
    ...(notes === undefined ? {} : { notes }),
  });
  await recordAuditEvent(ctx, {
    organizationId: service.organizationId,
    ...auditActorFor(principal),
    action: 'assignment.created',
    entityType: 'assignment',
    entityId: assignmentId,
    metadata: { providerId: args.providerId, position: args.position },
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
  const rate = await resolveRate(ctx, {
    rateCardVersionId: args.rateCardVersionId,
    providerId: assignment.providerId,
    vehicleClassId: args.vehicleClassId,
    modality: args.modality,
  });
  if (rate.rateLineId !== args.rateLineId) return notFoundOrInaccessible();
  assertMinorUnits(rate.unitAmount);
  const lineTotal = multiply(rate.unitAmount, args.quantity);

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
    lineTotal,
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
  if (revision.status !== 'draft' && revision.status !== 'accepted') {
    return invalidInput('assignmentRevisionNotDeclinable', 'Only draft or accepted Assignment Revisions can be declined');
  }
  const reason = validateDeclinedReason(args.reason);

  if (revision.status === 'accepted') {
    const accepted = await ctx.db
      .query('assignmentRevisions')
      .withIndex('by_assignment_status', (q) =>
        q.eq('assignmentId', assignment._id).eq('status', 'accepted'),
      )
      .unique();
    assertCurrentRevisionMirror(assignment, accepted);
    if (accepted?._id !== revision._id) return notFoundOrInaccessible();
    await ctx.db.patch(assignment._id, { currentRevisionId: undefined });
  }
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

export async function getAssignment(
  ctx: QueryCtx,
  assignmentId: Id<'assignments'>,
): Promise<Doc<'assignments'>> {
  return (await requireAssignmentAccess(ctx, assignmentId, 'readAssignment')).assignment;
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
): Promise<Doc<'assignments'>[]> {
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
  // Response shaping is separate from principal resolution: a Provider sees
  // only its own rows, while a member sees the complete bounded Service child set.
  return principal.kind === 'provider'
    ? assignments.filter((assignment) => assignment.providerId === principal.providerId)
    : assignments;
}

export async function listProjectAssignments(
  ctx: QueryCtx,
  args: { projectId: Id<'projects'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'assignments'>>> {
  const principal = await requirePrincipalForProject(ctx, args.projectId, 'readAssignment');
  return principal.kind === 'provider'
    ? ctx.db
        .query('assignments')
        .withIndex('by_project_provider_position', (q) =>
          q.eq('projectId', args.projectId).eq('providerId', principal.providerId),
        )
        .paginate(args.paginationOpts)
    : ctx.db
        .query('assignments')
        .withIndex('by_project_position', (q) => q.eq('projectId', args.projectId))
        .paginate(args.paginationOpts);
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
