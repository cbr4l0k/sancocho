import type { PaginationOptions, PaginationResult, Query } from 'convex/server';

import type { DataModel, Doc, Id } from '../_generated/dataModel';
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
import { assertProjectAcceptsServiceWrites, assertServiceWritable } from '../services/model';
import type { rateModalityValidator } from '../validators';
import { assertUsableVehicleClass } from '../vehicles/classes';
import { assertAssignableFleetVehicle } from '../vehicles/fleet';
import { assignmentNet, lineTotal } from './costing';
import { executionStatuses, transitionExecution, type ExecutionStatus } from './execution';

type RateModality = typeof rateModalityValidator.type;

/** The enforced ceiling that makes a Service's complete child read bounded. */
export const maxAssignmentsPerService = 200;
const maxAssignmentNotesLength = 2000;
const maxDeclinedReasonLength = 1000;
const maxVehiclePlateOverrideLength = 32;
const maxDriverNameLength = 200;
const maxNotExecutedReasonLength = 1000;
/** The ceiling one dispatch-queue call may emit, and so the ceiling on its reads. */
const maxDispatchPageSize = 200;
const maxDriverPhoneLength = 64;
const maxAdditionalDetailLength = 2000;

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
    executionStatus: 'unassigned',
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

export async function transitionAssignmentExecution(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<'assignments'>;
    status: ExecutionStatus;
    fleetVehicleId?: Id<'fleetVehicles'>;
    vehiclePlateOverride?: string;
    driverName?: string;
    driverPhone?: string;
    notExecutedReason?: string;
  },
): Promise<void> {
  const { assignment, principal } = await requireAssignmentAccess(ctx, args.assignmentId, 'writeExecution');
  const { service, project } = await loadAssignmentService(ctx, assignment);
  // Closing out an Assignment's record is always possible; starting new
  // operational activity on a closed Service is not. Both terminals therefore
  // answer only to the Project freeze:
  //   - `notExecuted` on a CANCELLED Service is the 03:00 cancellation, whose
  //     fee is unrecordable if this is frozen;
  //   - `completed` on a COMPLETED Service is the ordinary happy path, and
  //     freezing it stranded every dispatched Assignment under a closed-out
  //     Service in `dispatched` with "it did not happen" as its only reachable
  //     terminal — the exact inversion of what occurred.
  if (args.status === 'notExecuted' || args.status === 'completed') {
    assertProjectAcceptsServiceWrites(project);
  } else {
    assertServiceWritable(service, project);
  }

  if (args.fleetVehicleId !== undefined) {
    await assertAssignableFleetVehicle(ctx, args.fleetVehicleId, assignment.organizationId, assignment.providerId);
  }
  const vehiclePlateOverride = args.vehiclePlateOverride === undefined
    ? assignment.vehiclePlateOverride
    : validateBoundedExecutionText(args.vehiclePlateOverride, maxVehiclePlateOverrideLength, 'assignmentVehiclePlateOverrideInvalid');
  const driverName = args.driverName === undefined
    ? assignment.driverName
    : validateBoundedExecutionText(args.driverName, maxDriverNameLength, 'assignmentExecutionDriverRequired');
  const driverPhone = args.driverPhone === undefined
    ? assignment.driverPhone
    : validateBoundedExecutionText(args.driverPhone, maxDriverPhoneLength, 'assignmentExecutionDriverPhoneInvalid');
  // Bounded beside the other three caller-supplied texts rather than only
  // inside the pure gate's `notExecuted` branch: without this, any principal
  // holding `writeExecution` — a granted Provider included — could write an
  // unbounded string onto the coordinator's row through any OTHER transition,
  // where the gate never looks at it. It is also only meaningful on the status
  // it names, so every other transition clears it.
  const notExecutedReason = args.status !== 'notExecuted'
    ? undefined
    : args.notExecutedReason === undefined
      ? assignment.notExecutedReason
      : validateBoundedExecutionText(args.notExecutedReason, maxNotExecutedReasonLength, 'assignmentNotExecutedReasonInvalid');
  const now = Date.now();
  const resolved = transitionExecution(assignment.executionStatus, args.status, {
    serviceStatus: service.status,
    fleetVehicleId: args.fleetVehicleId ?? assignment.fleetVehicleId,
    vehiclePlateOverride,
    driverName,
    driverPhone,
    dispatchedAt: args.status === 'dispatched' ? now : assignment.dispatchedAt,
    completedAt: args.status === 'completed' ? now : assignment.completedAt,
    notExecutedReason,
  });

  await ctx.db.patch(assignment._id, {
    executionStatus: args.status,
    fleetVehicleId: resolved.fleetVehicleId,
    vehiclePlateOverride: resolved.vehiclePlateOverride,
    driverName: resolved.driverName,
    driverPhone: resolved.driverPhone,
    dispatchedAt: resolved.dispatchedAt,
    completedAt: resolved.completedAt,
    notExecutedReason: resolved.notExecutedReason,
  });
  await recordAuditEvent(ctx, {
    organizationId: assignment.organizationId,
    ...auditActorFor(principal),
    action: executionAuditAction(args.status),
    entityType: 'assignment',
    entityId: assignment._id,
    metadata: {
      previousStatus: assignment.executionStatus,
      status: args.status,
      providerId: assignment.providerId,
      position: assignment.position,
    },
  });
}

export async function recordAssignmentAdjustments(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<'assignments'>;
    notExecutedAmount?: number;
    additionalCharges?: number;
    additionalDetail?: string;
  },
): Promise<void> {
  const { assignment, principal } = await requireAssignmentAccess(ctx, args.assignmentId, 'writeAssignmentTerms');
  const { project } = await loadAssignmentService(ctx, assignment);
  // Deliberately NOT `assertServiceWritable`: what a cancelled movement cost is
  // exactly the question this mutation exists to answer, and the seed's own
  // model records `notExecutedAmount` only against cancelled Services. Only the
  // Project freeze applies.
  assertProjectAcceptsServiceWrites(project);
  if (assignment.currentRevisionId === undefined) {
    return invalidInput('assignmentAcceptedRevisionRequired', 'Adjustments require accepted Assignment terms');
  }
  const revision = await ctx.db.get(assignment.currentRevisionId);
  if (
    revision === null ||
    revision.assignmentId !== assignment._id ||
    revision.organizationId !== assignment.organizationId ||
    revision.status !== 'accepted'
  ) return notFoundOrInaccessible();

  if (args.notExecutedAmount !== undefined) assertMinorUnits(args.notExecutedAmount);
  if (args.additionalCharges !== undefined) assertMinorUnits(args.additionalCharges);
  assignmentNet({
    lineTotal: revision.lineTotal,
    ...((args.notExecutedAmount ?? assignment.notExecutedAmount) === undefined
      ? {}
      : { notExecutedAmount: args.notExecutedAmount ?? assignment.notExecutedAmount }),
    ...((args.additionalCharges ?? assignment.additionalCharges) === undefined
      ? {}
      : { additionalCharges: args.additionalCharges ?? assignment.additionalCharges }),
  });
  const additionalDetail = args.additionalDetail === undefined
    ? undefined
    : validateAdditionalDetail(args.additionalDetail);
  const update = {
    ...(args.notExecutedAmount === undefined ? {} : { notExecutedAmount: args.notExecutedAmount }),
    ...(args.additionalCharges === undefined ? {} : { additionalCharges: args.additionalCharges }),
    ...(additionalDetail === undefined ? {} : { additionalDetail }),
  };
  const changedFields = Object.keys(update).filter((field) => {
    const current: unknown = assignment[field as keyof typeof assignment];
    return current !== update[field as keyof typeof update];
  });
  if (changedFields.length === 0) return;
  await ctx.db.patch(assignment._id, update);
  // The accepted Revision is immutable (I10), but the NET payable derived from
  // it is not: `assignmentNet` reads these columns, so a planner moving them
  // after the fact changes what the coordinator owes. Every other money-touching
  // operation in this domain records who did it; without this one the change is
  // exactly the untraceable retroactive adjustment I10 exists to prevent. The
  // amounts themselves stay off the log — the audit answers who and when, and
  // the row answers how much.
  await recordAuditEvent(ctx, {
    organizationId: assignment.organizationId,
    ...auditActorFor(principal),
    action: 'assignment.adjustmentsRecorded',
    entityType: 'assignment',
    entityId: assignment._id,
    metadata: {
      changedFields: changedFields.join(', '),
      providerId: assignment.providerId,
      position: assignment.position,
    },
  });
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

  // Adjustments were validated against the PREVIOUS agreed amount, so cheaper
  // replacement terms can strand the Assignment in a state no read can price:
  // `assignmentNet` would throw on every subsequent read and the only way out
  // would be another adjustment. Re-prove the stored pair against the terms
  // about to become current, and refuse rather than persist that state.
  assignmentNet({
    lineTotal: revision.lineTotal,
    ...(assignment.notExecutedAmount === undefined ? {} : { notExecutedAmount: assignment.notExecutedAmount }),
    ...(assignment.additionalCharges === undefined ? {} : { additionalCharges: assignment.additionalCharges }),
  });

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
type ProviderAssignmentView = Omit<
  Doc<'assignments'>,
  'costCentreId' | 'notExecutedAmount' | 'additionalCharges' | 'additionalDetail'
>;

function providerAssignmentView(assignment: Doc<'assignments'>): ProviderAssignmentView {
  return {
    _id: assignment._id,
    _creationTime: assignment._creationTime,
    organizationId: assignment.organizationId,
    serviceId: assignment.serviceId,
    projectId: assignment.projectId,
    providerId: assignment.providerId,
    position: assignment.position,
    executionStatus: assignment.executionStatus,
    ...(assignment.notes === undefined ? {} : { notes: assignment.notes }),
    ...(assignment.currentRevisionId === undefined
      ? {}
      : { currentRevisionId: assignment.currentRevisionId }),
    ...(assignment.fleetVehicleId === undefined ? {} : { fleetVehicleId: assignment.fleetVehicleId }),
    ...(assignment.vehiclePlateOverride === undefined ? {} : { vehiclePlateOverride: assignment.vehiclePlateOverride }),
    ...(assignment.driverName === undefined ? {} : { driverName: assignment.driverName }),
    ...(assignment.driverPhone === undefined ? {} : { driverPhone: assignment.driverPhone }),
    ...(assignment.dispatchedAt === undefined ? {} : { dispatchedAt: assignment.dispatchedAt }),
    ...(assignment.completedAt === undefined ? {} : { completedAt: assignment.completedAt }),
    ...(assignment.notExecutedReason === undefined ? {} : { notExecutedReason: assignment.notExecutedReason }),
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

type DispatchResume = { position: number; creationTime: number };
type DispatchCursorState = Record<ExecutionStatus, { resume: DispatchResume | undefined; done: boolean }>;

/**
 * Merges one-row pages from the requested indexed status ranges. Keeping a
 * cursor per range preserves global position order without scanning unrelated
 * statuses or materializing an unbounded Project list.
 */
/**
 * The dispatch queue merges one indexed range per requested status, because
 * Convex allows a single `.paginate()` per function execution and this read
 * spans several. Two consequences the caller has to know:
 *
 * - It is driven by a MANUAL cursor loop, not `usePaginatedQuery`: the hook
 *   relies on `endCursor`/`splitCursor`/`pageStatus` to keep loaded pages
 *   stable, and a hand-merged cursor cannot honour them. A dispatch queue is
 *   exactly the list whose rows move between the merged ranges continuously,
 *   so a hook that silently re-stitched pages would be worse than one that
 *   never ran.
 * - Rows are ordered by `position`, never by departure time. Assignments carry
 *   no time column and denormalizing the Service's `startsAt` onto them was
 *   deliberately rejected (see docs/rates.md and #69).
 */
export async function assignmentsAwaitingDispatch(
  ctx: QueryCtx,
  args: {
    projectId: Id<'projects'>;
    statuses: ExecutionStatus[];
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<Doc<'assignments'> | ProviderAssignmentView>> {
  const principal = await requirePrincipalForProject(ctx, args.projectId, 'readAssignment');
  // Native `.paginate()` bounds a page for you; this loop merges several index
  // ranges by hand, so it has to bound itself. `numItems` arrives as a bare
  // float64, and `Infinity` would otherwise walk every requested range to
  // exhaustion and return the Project's whole Assignment set as one page — an
  // unrestricted tenant read reached through the pagination API (I6).
  if (!Number.isInteger(args.paginationOpts.numItems) || args.paginationOpts.numItems <= 0) {
    return invalidInput('paginationNumItemsInvalid', 'numItems must be a positive integer');
  }
  const numItems = Math.min(args.paginationOpts.numItems, maxDispatchPageSize);
  // The element type is closed, so the deduplicated set is at most six; only the
  // ARRAY's length is caller-controlled, and a quadratic dedup over it would
  // burn the query's whole deadline before the first read.
  if (args.statuses.length > executionStatuses.length) {
    return invalidInput('paginationNumItemsInvalid', 'Too many execution statuses requested');
  }
  const statuses = [...new Set(args.statuses)];
  const state = decodeDispatchCursor(args.paginationOpts.cursor, statuses);
  const page: Doc<'assignments'>[] = [];

  while (page.length < numItems) {
    const candidates: { row: Doc<'assignments'>; status: ExecutionStatus }[] = [];
    for (const status of statuses) {
      const rangeState = state[status];
      if (rangeState.done) continue;
      const row = await firstDispatchRow(ctx, args.projectId, status, rangeState.resume, principal);
      if (row === null) state[status] = { resume: rangeState.resume, done: true };
      else candidates.push({ row, status });
    }
    if (candidates.length === 0) {
      if (statuses.every((status) => state[status].done)) break;
      continue;
    }
    candidates.sort(compareDispatchCandidates);
    const selected = candidates[0];
    if (selected === undefined) break;
    page.push(selected.row);
    // `position` is unique per SERVICE, so two rows in one Project routinely
    // share it — which is why the resume is the PAIR. That pair is a unique key
    // within a (projectId, executionStatus) range because Convex orders every
    // index by [...fields, _creationTime, _id] and `_creationTime` is strictly
    // increasing per insert, so `.gt('_creationTime')` skips exactly the row
    // just emitted and never a second one sharing its position.
    state[selected.status] = {
      resume: { position: selected.row.position, creationTime: selected.row._creationTime },
      done: false,
    };
  }

  const isDone = statuses.every((status) => state[status].done);
  return {
    page: principal.kind === 'provider' ? page.map(providerAssignmentView) : page,
    isDone,
    continueCursor: encodeDispatchCursor(statuses, state),
  };
}

async function firstDispatchRow(
  ctx: QueryCtx,
  projectId: Id<'projects'>,
  status: ExecutionStatus,
  resume: DispatchResume | undefined,
  principal: Principal,
): Promise<Doc<'assignments'> | null> {
  // A single-firm Provider is keyed straight into its own rows, exactly as
  // `listProjectAssignments` does; only a dual-firm caller falls back to the
  // post-read filter, where the scanned range is at least its own union.
  const soleProviderId = principal.kind === 'provider' && principal.accessibleProviderIds.size === 1
    ? principal.providerId
    : undefined;
  if (resume !== undefined) {
    const samePosition = soleProviderId === undefined
      ? ctx.db.query('assignments').withIndex('by_project_execution_position', (q) =>
          q.eq('projectId', projectId).eq('executionStatus', status)
            .eq('position', resume.position).gt('_creationTime', resume.creationTime))
      : ctx.db.query('assignments').withIndex('by_project_provider_execution_position', (q) =>
          q.eq('projectId', projectId).eq('providerId', soleProviderId).eq('executionStatus', status)
            .eq('position', resume.position).gt('_creationTime', resume.creationTime));
    const samePositionRow = (await narrowToUnion(samePosition).take(1))[0];
    if (samePositionRow !== undefined) return samePositionRow;
  }

  const later = soleProviderId === undefined
    ? ctx.db.query('assignments').withIndex('by_project_execution_position', (q) => {
        const statusRange = q.eq('projectId', projectId).eq('executionStatus', status);
        return resume === undefined ? statusRange : statusRange.gt('position', resume.position);
      })
    : ctx.db.query('assignments').withIndex('by_project_provider_execution_position', (q) => {
        const statusRange = q.eq('projectId', projectId).eq('providerId', soleProviderId).eq('executionStatus', status);
        return resume === undefined ? statusRange : statusRange.gt('position', resume.position);
      });
  return (await narrowToUnion(later).take(1))[0] ?? null;

  /**
   * Only a dual-firm caller needs this: with one Provider the index key above
   * has already done the narrowing, and Convex applies `.filter()` after
   * reading documents off the index.
   */
  function narrowToUnion(
    query: Query<DataModel['assignments']>,
  ): Query<DataModel['assignments']> {
    if (principal.kind !== 'provider' || soleProviderId !== undefined) return query;
    return query.filter((q) => q.or(
      ...[...principal.accessibleProviderIds].map((providerId) =>
        q.eq(q.field('providerId'), providerId),
      ),
    ));
  }
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

function compareDispatchCandidates(
  left: { row: Doc<'assignments'> },
  right: { row: Doc<'assignments'> },
): number {
  return left.row.position - right.row.position
    || left.row._creationTime - right.row._creationTime
    || String(left.row._id).localeCompare(String(right.row._id));
}

function initialDispatchCursor(): DispatchCursorState {
  return {
    unassigned: { resume: undefined, done: false },
    assigned: { resume: undefined, done: false },
    confirmed: { resume: undefined, done: false },
    dispatched: { resume: undefined, done: false },
    completed: { resume: undefined, done: false },
    notExecuted: { resume: undefined, done: false },
  };
}

function decodeDispatchCursor(cursor: string | null, statuses: readonly ExecutionStatus[]): DispatchCursorState {
  if (cursor === null) return initialDispatchCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return conflict();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.statuses) || !isRecord(parsed.state)) return conflict();
  if (
    parsed.statuses.length !== statuses.length ||
    parsed.statuses.some((status, index) => status !== statuses[index])
  ) return conflict();
  const state = initialDispatchCursor();
  for (const status of statuses) {
    const value = parsed.state[status];
    if (
      !isRecord(value) ||
      typeof value.done !== 'boolean'
    ) return conflict();
    if (value.resume === undefined) {
      state[status] = { resume: undefined, done: value.done };
      continue;
    }
    if (
      !isRecord(value.resume) ||
      typeof value.resume.position !== 'number' ||
      typeof value.resume.creationTime !== 'number'
    ) return conflict();
    state[status] = {
      resume: { position: value.resume.position, creationTime: value.resume.creationTime },
      done: value.done,
    };
  }
  return state;
}

function encodeDispatchCursor(statuses: readonly ExecutionStatus[], state: DispatchCursorState): string {
  return JSON.stringify({ statuses, state });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBoundedExecutionText(
  value: string,
  maximumLength: number,
  code:
    | 'assignmentVehiclePlateOverrideInvalid'
    | 'assignmentExecutionDriverRequired'
    | 'assignmentExecutionDriverPhoneInvalid'
    | 'assignmentNotExecutedReasonInvalid',
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximumLength) {
    return invalidInput(code, `Execution text must contain at most ${maximumLength} characters`);
  }
  return trimmed;
}

function validateAdditionalDetail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length > maxAdditionalDetailLength) {
    return invalidInput('assignmentNotesTooLong', `Additional detail must not exceed ${maxAdditionalDetailLength} characters`);
  }
  return trimmed;
}

function executionAuditAction(status: ExecutionStatus):
  | 'assignment.dispatchStatusChanged'
  | 'assignment.vehicleAssigned'
  | 'assignment.driverAssigned'
  | 'assignment.notExecuted' {
  if (status === 'assigned') return 'assignment.vehicleAssigned';
  if (status === 'confirmed') return 'assignment.driverAssigned';
  if (status === 'notExecuted') return 'assignment.notExecuted';
  return 'assignment.dispatchStatusChanged';
}
