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
  type ProviderPrincipal,
  type ProjectIntent,
} from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { assertMinorUnits } from '../lib/money';
import {
  providerServiceProjection,
} from '../lib/providerProjection';
import { assertUsableProvider } from '../providers/model';
import { resolveRateForAssignment } from '../rateCards/model';
import { assertProjectAcceptsServiceWrites, assertServiceWritable } from '../services/model';
import type { assignmentCheckpointKindValidator, rateModalityValidator } from '../validators';
import { assertUsableVehicleClass } from '../vehicles/classes';
import { assertAssignableFleetVehicle } from '../vehicles/fleet';
import { assignmentNet, lineTotal } from './costing';
import { executionStatuses, transitionExecution, type ExecutionStatus } from './execution';

type RateModality = typeof rateModalityValidator.type;
type AssignmentCheckpointKind = typeof assignmentCheckpointKindValidator.type;

/** The enforced ceiling that makes a Service's complete child read bounded. */
export const maxAssignmentsPerService = 200;
/** The bounded Service prefix used by the non-paginated readiness summary. */
export const maxDispatchReadinessServices = 500;
/** The bounded Assignment prefix used by the non-paginated readiness summary. */
export const maxDispatchReadinessAssignments = 5000;
const maxDispatchWindowMilliseconds = 31 * 24 * 60 * 60 * 1000;
const maxAssignmentNotesLength = 2000;
const maxDeclinedReasonLength = 1000;
const maxVehiclePlateOverrideLength = 32;
const maxDriverNameLength = 200;
const maxNotExecutedReasonLength = 1000;
/** The ceiling one dispatch-queue call may emit, and so the ceiling on its reads. */
const maxDispatchPageSize = 200;
const maxDriverPhoneLength = 64;
const maxAdditionalDetailLength = 2000;
const maxCheckpointNoteLength = 2000;
/**
 * Ceilings on the two tables an EXTERNAL principal can append to.
 *
 * `maxAssignmentsPerService` already establishes the pattern for a coordinator's
 * own writes; these matter more, because a granted firm writing into the
 * coordinator's tenant is the one writer the coordinator does not control. They
 * also make the checkpoint reference guard bounded by construction, and they are
 * what lets `docs/provider-access.md` keep calling the checkpoint capability
 * "bounded".
 */
const maxRevisionsPerAssignment = 200;
const maxCheckpointsPerAssignment = 500;

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
  // Checkpoints are the SECOND child table (#88) and the guard has to see them
  // too. `by_assignment_occurredAt` is their only index and every read goes
  // through `requireAssignmentAccess`, so a checkpoint left behind by a deleted
  // Assignment is unreadable and undeletable forever. Same generic code as the
  // revision case, so the refusal discloses nothing about which table held it.
  const checkpoint = await ctx.db
    .query('assignmentCheckpoints')
    .withIndex('by_assignment_occurredAt', (q) => q.eq('assignmentId', assignment._id))
    .first();
  if (checkpoint !== null) {
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
  await assertRevisionCapacity(ctx, assignment._id);
  const revisionNumber = await nextAssignmentRevisionNumber(ctx, assignment._id);
  const author = auditActorFor(principal);
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
    proposedByUserId: author.actorUserId,
    ...(author.onBehalfOfProviderId === undefined
      ? {}
      : { proposedOnBehalfOfProviderId: author.onBehalfOfProviderId }),
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


/**
 * Appends a Provider-authored alternative without mutating the offer it answers.
 * Keeping the countered draft open is deliberate: the Provider can still accept
 * the coordinator's original offer, and concurrent counters can both append
 * distinct alternatives. A counter never becomes current by itself; only the
 * existing acceptance transaction can install one.
 *
 * `vehicleClassId` is derived from the answered revision because Providers
 * cannot browse that catalogue and therefore have no class id they may choose.
 */
export async function counterAssignmentRevision(
  ctx: MutationCtx,
  args: {
    revisionId: Id<'assignmentRevisions'>;
    quantity: number;
    modality: RateModality;
  },
): Promise<Id<'assignmentRevisions'>> {
  const { revision, assignment, principal } = await requireRevisionAccess(
    ctx,
    args.revisionId,
    'respondToTerms',
  );
  if (principal.kind !== 'provider') return notFoundOrInaccessible();
  if (revision.status !== 'draft') {
    return invalidInput('assignmentRevisionNotDraft', 'Only draft Assignment Revisions can be countered');
  }
  assertQuantity(args.quantity);
  const { service, project } = await loadAssignmentService(ctx, assignment);
  assertServiceWritable(service, project);

  // The same usability gates the coordinator's proposal path applies. The class
  // is inherited rather than chosen, but an archived class must not be re-priced
  // through the back door simply because it was live when first offered.
  await assertUsableProvider(ctx, assignment.providerId, assignment.organizationId);
  await assertUsableVehicleClass(ctx, revision.vehicleClassId, assignment.organizationId);
  // The card and class come from the revision being answered (I4). The caller
  // cannot name either the coordinator's card or its grid cell.
  const rate = await resolveRateForAssignment(ctx, {
    rateCardVersionId: revision.rateCardVersionId,
    providerId: assignment.providerId,
    vehicleClassId: revision.vehicleClassId,
    modality: args.modality,
  });
  assertMinorUnits(rate.unitAmount);
  await assertRevisionCapacity(ctx, assignment._id);
  const revisionNumber = await nextAssignmentRevisionNumber(ctx, assignment._id);
  const author = auditActorFor(principal);
  const counterId = await ctx.db.insert('assignmentRevisions', {
    organizationId: assignment.organizationId,
    assignmentId: assignment._id,
    revisionNumber,
    status: 'draft',
    vehicleClassId: revision.vehicleClassId,
    modality: args.modality,
    quantity: args.quantity,
    rateCardVersionId: revision.rateCardVersionId,
    rateLineId: rate.rateLineId,
    unitAmount: rate.unitAmount,
    currency: rate.currency,
    lineTotal: lineTotal(rate.unitAmount, args.quantity),
    proposedByUserId: author.actorUserId,
    proposedOnBehalfOfProviderId: principal.providerId,
  });
  await recordAuditEvent(ctx, {
    organizationId: assignment.organizationId,
    ...author,
    action: 'assignmentRevision.countered',
    entityType: 'assignmentRevision',
    entityId: counterId,
    metadata: { assignmentId: assignment._id, versionNumber: revisionNumber },
  });
  return counterId;
}

export async function acceptAssignmentRevision(
  ctx: MutationCtx,
  revisionId: Id<'assignmentRevisions'>,
): Promise<void> {
  const { revision, assignment, principal } = await requireRevisionAccess(
    ctx,
    revisionId,
    'respondToTerms',
  );
  const { service, project } = await loadAssignmentService(ctx, assignment);
  assertServiceWritable(service, project);
  if (revision.status !== 'draft') {
    return invalidInput('assignmentRevisionNotDraft', 'Only draft Assignment Revisions can be accepted');
  }
  // Security boundary: a Provider may answer a coordinator-authored offer but
  // may never ratify terms proposed by a Provider principal (including itself).
  // Legacy rows without an author predate Provider writes and are therefore
  // coordinator-authored by construction.
  if (principal.kind === 'provider' && revision.proposedOnBehalfOfProviderId !== undefined) {
    return invalidInput(
      'assignmentRevisionProviderAcceptanceForbidden',
      'A Provider cannot accept a Provider-authored Assignment Revision',
    );
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
  // Several drafts may be open at once, deliberately: a coordinator offering
  // "two vans, or one coach" is one Assignment with two live alternatives, and
  // `declineAssignmentRevision` is how either side withdraws one. Retiring older
  // drafts automatically on each new proposal would have removed that, and two
  // existing tests depend on it.
  //
  // Negotiation only moves FORWARD. Without this, every superseded agreement
  // leaves its lower-numbered predecessors sitting in `draft` as live re-entry
  // points: the counterparty could accept an abandoned coordinator offer long
  // after a corrected one was agreed, walking `currentRevisionId` backwards and
  // re-pricing the Assignment at a figure the coordinator had already replaced.
  // No stored amount is mutated, so the letter of I10 survives while its
  // purpose — the coordinator decides what a movement costs — does not.
  if (accepted !== null && revision.revisionNumber < accepted.revisionNumber) {
    return invalidInput(
      'assignmentRevisionOutdated',
      'Assignment Revisions older than the current agreement cannot be accepted',
    );
  }
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
    'respondToTerms',
  );
  const { service, project } = await loadAssignmentService(ctx, assignment);
  assertServiceWritable(service, project);
  if (revision.status !== 'draft') {
    return invalidInput('assignmentRevisionNotDeclinable', 'Only draft Assignment Revisions can be declined');
  }
  const reason = validateDeclinedReason(args.reason);
  await ctx.db.patch(revision._id, {
    status: 'declined',
    declinedReason: reason,
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
 * Appends a timestamped execution milestone. Checkpoints intentionally do not
 * transition Assignment status: #69's execution state machine remains the one
 * source of truth, and this row is only an attributed note on that history.
 */
export async function recordAssignmentCheckpoint(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<'assignments'>;
    kind: AssignmentCheckpointKind;
    occurredAt: number;
    note?: string;
  },
): Promise<Id<'assignmentCheckpoints'>> {
  const { assignment, principal } = await requireAssignmentAccess(
    ctx,
    args.assignmentId,
    'writeExecution',
  );
  const { project } = await loadAssignmentService(ctx, assignment);
  // Only the Project freeze applies, exactly as `transitionAssignmentExecution`
  // decided for terminal transitions: a driver who arrives after the coordinator
  // closed out the Service still arrived, and refusing the record does not undo
  // the movement — it only loses it. Checkpoints are observations, never status.
  assertProjectAcceptsServiceWrites(project);
  if (!Number.isSafeInteger(args.occurredAt) || args.occurredAt < 0) {
    return invalidInput(
      'assignmentCheckpointOccurredAtInvalid',
      'Checkpoint occurredAt must be a non-negative integer timestamp',
    );
  }
  // `by_assignment_occurredAt` is the only ordering these rows have, so an
  // unbounded stamp lets one checkpoint sit at the top or bottom of every page
  // forever. A year either side of now is far wider than any real correction and
  // still keeps the ordering meaningful.
  const checkpointWindowMs = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (args.occurredAt < now - checkpointWindowMs || args.occurredAt > now + checkpointWindowMs) {
    return invalidInput(
      'assignmentCheckpointOccurredAtInvalid',
      'Checkpoint occurredAt must fall within a year of now',
    );
  }
  const note = validateCheckpointNote(args.note);
  // The granted firm is an external writer into the coordinator's tenant, and
  // this is the one table it can append to freely. Bounded before insert, in the
  // same mutation, so the promise `docs/provider-access.md` makes about
  // "bounded checkpoints" is enforced rather than described.
  const existing = await ctx.db
    .query('assignmentCheckpoints')
    .withIndex('by_assignment_occurredAt', (q) => q.eq('assignmentId', assignment._id))
    .take(maxCheckpointsPerAssignment);
  if (existing.length >= maxCheckpointsPerAssignment) {
    return invalidInput(
      'assignmentCheckpointLimitReached',
      `An Assignment may carry at most ${maxCheckpointsPerAssignment} checkpoints`,
    );
  }
  const actor = auditActorFor(principal);
  const checkpointId = await ctx.db.insert('assignmentCheckpoints', {
    assignmentId: assignment._id,
    organizationId: assignment.organizationId,
    kind: args.kind,
    occurredAt: args.occurredAt,
    ...(note === undefined ? {} : { note }),
    ...actor,
  });
  // Notes and driver phone numbers never enter audit metadata. The checkpoint
  // id plus code-owned kind is enough to find the attributed source row.
  await recordAuditEvent(ctx, {
    organizationId: assignment.organizationId,
    ...actor,
    action: 'assignmentCheckpoint.recorded',
    entityType: 'assignmentCheckpoint',
    entityId: checkpointId,
    metadata: { assignmentId: assignment._id, type: args.kind },
  });
  return checkpointId;
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
 * Both outcomes fail closed. The wider Service projection is composed with this
 * row only by `getAssignmentDetail` below.
 */
export type ProviderAssignmentView = Omit<
  Doc<'assignments'>,
  'costCentreId' | 'notExecutedAmount' | 'additionalCharges' | 'additionalDetail'
>;

export function providerAssignmentView(assignment: Doc<'assignments'>): ProviderAssignmentView {
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

type ProviderRevisionView = Omit<
  Doc<'assignmentRevisions'>,
  'rateCardVersionId' | 'rateLineId' | 'acceptedByUserId' | 'proposedByUserId'
>;

function providerRevisionView(revision: Doc<'assignmentRevisions'>): ProviderRevisionView {
  return {
    _id: revision._id,
    _creationTime: revision._creationTime,
    organizationId: revision.organizationId,
    assignmentId: revision.assignmentId,
    revisionNumber: revision.revisionNumber,
    status: revision.status,
    vehicleClassId: revision.vehicleClassId,
    modality: revision.modality,
    quantity: revision.quantity,
    unitAmount: revision.unitAmount,
    currency: revision.currency,
    lineTotal: revision.lineTotal,
    ...(revision.proposedOnBehalfOfProviderId === undefined
      ? {}
      : { proposedOnBehalfOfProviderId: revision.proposedOnBehalfOfProviderId }),
    ...(revision.acceptedAt === undefined ? {} : { acceptedAt: revision.acceptedAt }),
    ...(revision.declinedReason === undefined ? {} : { declinedReason: revision.declinedReason }),
  };
}

type ProviderCheckpointView = Omit<Doc<'assignmentCheckpoints'>, 'actorUserId'>;

function providerCheckpointView(
  checkpoint: Doc<'assignmentCheckpoints'>,
): ProviderCheckpointView {
  return {
    _id: checkpoint._id,
    _creationTime: checkpoint._creationTime,
    assignmentId: checkpoint.assignmentId,
    organizationId: checkpoint.organizationId,
    kind: checkpoint.kind,
    occurredAt: checkpoint.occurredAt,
    ...(checkpoint.note === undefined ? {} : { note: checkpoint.note }),
    ...(checkpoint.onBehalfOfProviderId === undefined
      ? {}
      : { onBehalfOfProviderId: checkpoint.onBehalfOfProviderId }),
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
): Promise<Doc<'assignmentRevisions'> | ProviderRevisionView> {
  const { revision, principal } = await requireRevisionAccess(ctx, revisionId, 'readAssignment');
  return principal.kind === 'provider' ? providerRevisionView(revision) : revision;
}

export async function listAssignmentRevisions(
  ctx: QueryCtx,
  args: { assignmentId: Id<'assignments'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'assignmentRevisions'> | ProviderRevisionView>> {
  const { assignment, principal } = await requireAssignmentAccess(ctx, args.assignmentId, 'readAssignment');
  const page = await ctx.db
    .query('assignmentRevisions')
    .withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id))
    // Every reader needs the live negotiation first; ascending order buried it behind the Assignment's whole history.
    .order('desc')
    .paginate(args.paginationOpts);
  return principal.kind === 'provider'
    ? { ...page, page: page.page.map(providerRevisionView) }
    : page;
}

export async function listAssignmentCheckpoints(
  ctx: QueryCtx,
  args: { assignmentId: Id<'assignments'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'assignmentCheckpoints'> | ProviderCheckpointView>> {
  const { assignment, principal } = await requireAssignmentAccess(ctx, args.assignmentId, 'readAssignment');
  const page = await ctx.db
    .query('assignmentCheckpoints')
    .withIndex('by_assignment_occurredAt', (q) => q.eq('assignmentId', assignment._id))
    .order('desc')
    .paginate(args.paginationOpts);
  return principal.kind === 'provider'
    ? { ...page, page: page.page.map(providerCheckpointView) }
    : page;
}

export async function getAssignmentDetail(
  ctx: QueryCtx,
  assignmentId: Id<'assignments'>,
): Promise<{
  assignment: Doc<'assignments'> | ProviderAssignmentView;
  serviceProjection: Awaited<ReturnType<typeof providerServiceProjection>>;
}> {
  // TWO capabilities, so two gate calls. The response carries two distinct
  // things — the Assignment row (`readAssignment`) and the linked Service's
  // projection (`readLinkedServiceProjection`) — and the closed Provider set is
  // total today, so either call alone would pass. It will not always be: the
  // gate's own comment keeps the closed-set check centralized "precisely so
  // that the day the two diverge — a narrower grant, a new intent providers
  // must not hold — the refusal is already centralized". On that day a query
  // that proved only one of the two would hand over the other.
  const { assignment, principal } = await requireAssignmentAccess(ctx, assignmentId, 'readAssignment');
  await requireAssignmentAccess(ctx, assignmentId, 'readLinkedServiceProjection');
  const { service } = await loadAssignmentService(ctx, assignment);
  return {
    assignment: principal.kind === 'provider' ? providerAssignmentView(assignment) : assignment,
    serviceProjection: await providerServiceProjection(ctx, service),
  };
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

export type ServiceAssignmentRow = {
  assignment: Doc<'assignments'>;
  currentRevision: Doc<'assignmentRevisions'> | null;
  latestRevision: Doc<'assignmentRevisions'> | null;
  provider: Pick<Doc<'providers'>, '_id' | 'name' | 'status'> | null;
  vehicleClass: Pick<Doc<'vehicleClasses'>, '_id' | 'name' | 'status'> | null;
  costCentre: Pick<Doc<'costCentres'>, '_id' | 'key' | 'name' | 'status'> | null;
};

type AssignmentRowFilters = {
  status?: ExecutionStatus;
  providerId?: Id<'providers'>;
  costCentreId?: Id<'costCentres'>;
};

/**
 * Member-only Assignment-panel projection. Provider principals are refused
 * because this joins Cost Centre data (provider may-not-see #7), coordinator
 * catalogue names, and every firm's rows on the Service (may-not-see #3).
 * Missing or foreign joined rows degrade to null, matching Event detail reads.
 */
export async function listServiceAssignmentRows(
  ctx: QueryCtx,
  serviceId: Id<'services'>,
): Promise<ServiceAssignmentRow[]> {
  await requireAuthenticatedUser(ctx);
  const service = await ctx.db.get(serviceId);
  if (service === null) return notFoundOrInaccessible();
  const principal = await requirePrincipalForProject(ctx, service.projectId, 'readAssignment');
  if (principal.kind === 'provider') {
    // The generic refusal preserves I9 while preventing provider enumeration of
    // other firms and coordinator-only catalogue/Cost Centre context.
    return notFoundOrInaccessible();
  }
  const project = await ctx.db.get(service.projectId);
  if (project === null || project.organizationId !== service.organizationId) {
    return notFoundOrInaccessible();
  }

  return buildServiceAssignmentRows(ctx, service);
}

/**
 * The one implementation of the coordinator Assignment row projection. Both
 * the Service panel and dispatch board use this helper so revision selection
 * and degrade-to-null catalogue joins cannot drift between the two screens.
 */
async function buildServiceAssignmentRows(
  ctx: QueryCtx,
  service: Doc<'services'>,
  filters: AssignmentRowFilters = {},
): Promise<ServiceAssignmentRow[]> {
  const assignments = await ctx.db
    .query('assignments')
    .withIndex('by_service_position', (q) => q.eq('serviceId', service._id))
    .take(maxAssignmentsPerService);
  const providers = new Map<Id<'providers'>, Doc<'providers'> | null>();
  const vehicleClasses = new Map<Id<'vehicleClasses'>, Doc<'vehicleClasses'> | null>();
  const costCentres = new Map<Id<'costCentres'>, Doc<'costCentres'> | null>();
  const rows: ServiceAssignmentRow[] = [];

  for (const assignment of assignments) {
    // The index key finds children, but these duplicated ownership columns are
    // not authority. Re-derive them from the already-proven Service before a
    // full Assignment document or any of its joins can cross the boundary.
    if (
      assignment.organizationId !== service.organizationId ||
      assignment.projectId !== service.projectId
    ) return notFoundOrInaccessible();
    // These in-memory filters narrow one Service's COMPLETE bounded child set;
    // they never decide which Services belong to a paginated page. That is the
    // documented I6 exemption, unlike filtering the Service range after paging.
    if (
      (filters.status !== undefined && assignment.executionStatus !== filters.status) ||
      (filters.providerId !== undefined && assignment.providerId !== filters.providerId) ||
      (filters.costCentreId !== undefined && assignment.costCentreId !== filters.costCentreId)
    ) continue;

    const pointedRevision = assignment.currentRevisionId === undefined
      ? null
      : await ctx.db.get(assignment.currentRevisionId);
    const currentRevision = pointedRevision !== null &&
        pointedRevision.assignmentId === assignment._id &&
        pointedRevision.organizationId === assignment.organizationId &&
        pointedRevision.status === 'accepted'
      ? pointedRevision
      : null;
    const latestRevisionRow = await ctx.db
      .query('assignmentRevisions')
      .withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignment._id))
      .order('desc')
      .first();
    // Only the tenant column is re-derived. `assignmentId` is not re-checked
    // because the index range above already pinned it, so a comparison against
    // it could never fail — and a guard no test can exercise reads as
    // protection while providing none.
    const latestRevision = latestRevisionRow !== null &&
        latestRevisionRow.organizationId === assignment.organizationId
      ? latestRevisionRow
      : null;

    if (!providers.has(assignment.providerId)) {
      providers.set(assignment.providerId, await ctx.db.get(assignment.providerId));
    }
    const providerRow = providers.get(assignment.providerId) ?? null;

    const vehicleClassId = (currentRevision ?? latestRevision)?.vehicleClassId;
    if (vehicleClassId !== undefined && !vehicleClasses.has(vehicleClassId)) {
      vehicleClasses.set(vehicleClassId, await ctx.db.get(vehicleClassId));
    }
    const vehicleClassRow = vehicleClassId === undefined
      ? null
      : vehicleClasses.get(vehicleClassId) ?? null;

    const costCentreId = assignment.costCentreId;
    if (costCentreId !== undefined && !costCentres.has(costCentreId)) {
      costCentres.set(costCentreId, await ctx.db.get(costCentreId));
    }
    const costCentreRow = costCentreId === undefined
      ? null
      : costCentres.get(costCentreId) ?? null;

    rows.push({
      assignment,
      currentRevision,
      latestRevision,
      provider: providerRow === null || providerRow.organizationId !== assignment.organizationId
        ? null
        : { _id: providerRow._id, name: providerRow.name, status: providerRow.status },
      vehicleClass: vehicleClassRow === null || vehicleClassRow.organizationId !== assignment.organizationId
        ? null
        : { _id: vehicleClassRow._id, name: vehicleClassRow.name, status: vehicleClassRow.status },
      costCentre: costCentreRow === null || costCentreRow.organizationId !== assignment.organizationId
        ? null
        : { _id: costCentreRow._id, key: costCentreRow.key, name: costCentreRow.name, status: costCentreRow.status },
    });
  }
  return rows;
}

export type DispatchServiceEntry = {
  service: Pick<Doc<'services'>, '_id' | 'name' | 'startsAt' | 'endsAt' | 'status' | 'eventId'>;
  rows: ServiceAssignmentRow[];
};

export async function listDispatchDay(
  ctx: QueryCtx,
  args: {
    projectId: Id<'projects'>;
    from: number;
    to: number;
    eventId?: Id<'events'>;
    status?: ExecutionStatus;
    providerId?: Id<'providers'>;
    costCentreId?: Id<'costCentres'>;
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<DispatchServiceEntry>> {
  await requireAuthenticatedUser(ctx);
  const principal = await requirePrincipalForProject(ctx, args.projectId, 'readAssignment');
  if (principal.kind === 'provider') return notFoundOrInaccessible();
  assertDispatchWindow(args.from, args.to);
  const paginationOpts = boundedDispatchPaginationOptions(args.paginationOpts);

  if (args.eventId !== undefined) {
    const event = await ctx.db.get(args.eventId);
    if (
      event === null ||
      event.projectId !== args.projectId ||
      event.organizationId !== principal.organization._id
    ) return notFoundOrInaccessible();
    const page = await ctx.db
      .query('services')
      .withIndex('by_event_startsAt', (q) =>
        q.eq('eventId', event._id).gte('startsAt', args.from).lt('startsAt', args.to),
      )
      .paginate(paginationOpts);
    // `by_event_startsAt` proves only the Event id. Re-derive the Project from
    // every returned Service before disclosing it: the sole writer currently
    // copies both columns from the same gated Event, but I4 does not let this
    // read trust that denormalized relationship forever.
    return mapDispatchServicePage(ctx, page, principal.organization._id, args.projectId, args);
  }

  const page = await ctx.db
    .query('services')
    .withIndex('by_project_startsAt', (q) =>
      q.eq('projectId', args.projectId).gte('startsAt', args.from).lt('startsAt', args.to),
    )
    .paginate(paginationOpts);
  return mapDispatchServicePage(ctx, page, principal.organization._id, args.projectId, args);
}

async function mapDispatchServicePage(
  ctx: QueryCtx,
  page: PaginationResult<Doc<'services'>>,
  organizationId: Id<'organizations'>,
  projectId: Id<'projects'>,
  filters: AssignmentRowFilters,
): Promise<PaginationResult<DispatchServiceEntry>> {
  const entries: DispatchServiceEntry[] = [];
  for (const service of page.page) {
    if (
      service.organizationId !== organizationId ||
      service.projectId !== projectId
    ) return notFoundOrInaccessible();
    entries.push({
      service: {
        _id: service._id,
        name: service.name,
        startsAt: service.startsAt,
        ...(service.endsAt === undefined ? {} : { endsAt: service.endsAt }),
        status: service.status,
        eventId: service.eventId,
      },
      rows: await buildServiceAssignmentRows(ctx, service, filters),
    });
  }
  return { ...page, page: entries };
}

export type ProviderDispatchAssignmentEntry = {
  assignment: ProviderAssignmentView;
  service: Pick<Doc<'services'>, '_id' | 'startsAt'>;
  serviceProjection: Awaited<ReturnType<typeof providerServiceProjection>>;
};

/**
 * Returns a flat Assignment page. A cursor boundary can fall inside a Service,
 * so a grouped page would lie that either half contained the Service's complete
 * work. The honest pagination unit is the indexed Assignment row; the console
 * may group only after it has loaded the desired pages.
 */
export async function listProviderDispatchDay(
  ctx: QueryCtx,
  args: {
    projectId: Id<'projects'>;
    from: number;
    to: number;
    status?: ExecutionStatus;
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<ProviderDispatchAssignmentEntry>> {
  await requireAuthenticatedUser(ctx);
  const principal = await requirePrincipalForProject(ctx, args.projectId, 'readAssignment');
  await requirePrincipalForProject(ctx, args.projectId, 'readLinkedServiceProjection');
  if (principal.kind !== 'provider') return notFoundOrInaccessible();
  assertDispatchWindow(args.from, args.to);

  // The anchor is deliberately inverted relative to the coordinator board:
  // its day is a set of Services, while a Provider's day is a set of its own
  // Assignments. Starting here prevents the Provider from enumerating Services
  // on which it has no work. The day window is consequently an in-memory filter
  // over this one bounded assignment page, never an unbounded read.
  const assignmentPage = await paginateProviderDispatchAssignments(ctx, args, principal);
  const serviceContexts = new Map<Id<'services'>, {
    service: Doc<'services'>;
    serviceProjection: Awaited<ReturnType<typeof providerServiceProjection>> | null;
  }>();
  const entries: ProviderDispatchAssignmentEntry[] = [];
  for (const assignment of assignmentPage.page) {
    let context = serviceContexts.get(assignment.serviceId);
    if (context === undefined) {
      const service = await ctx.db.get(assignment.serviceId);
      if (
        service === null ||
        service.projectId !== args.projectId ||
        service.organizationId !== assignment.organizationId
      ) return notFoundOrInaccessible();
      context = {
        service,
        serviceProjection: service.startsAt < args.from || service.startsAt >= args.to
          ? null
          : await providerServiceProjection(ctx, service),
      };
      serviceContexts.set(assignment.serviceId, context);
    }
    // The per-Provider index ranges make this unreachable by construction.
    // Keep the row-level proof because the duplicated ownership columns are not
    // authority, and because it fails closed if either the index or merge logic
    // is changed later without preserving that construction.
    if (
      assignment.serviceId !== context.service._id ||
      assignment.projectId !== context.service.projectId ||
      assignment.organizationId !== context.service.organizationId ||
      !principal.accessibleProviderIds.has(assignment.providerId)
    ) return notFoundOrInaccessible();
    if (context.serviceProjection === null) continue;
    entries.push({
      assignment: providerAssignmentView(assignment),
      // Provider MAY-see #6 in docs/provider-access.md explicitly includes
      // these two Service columns for a Service carrying the firm's Assignment.
      service: { _id: context.service._id, startsAt: context.service.startsAt },
      serviceProjection: context.serviceProjection,
    });
  }
  return { ...assignmentPage, page: entries };
}

async function paginateProviderDispatchAssignments(
  ctx: QueryCtx,
  args: {
    projectId: Id<'projects'>;
    status?: ExecutionStatus;
    paginationOpts: PaginationOptions;
  },
  principal: ProviderPrincipal,
): Promise<PaginationResult<Doc<'assignments'>>> {
  const { numItems } = boundedDispatchPaginationOptions(args.paginationOpts);
  const providerIds = [...principal.accessibleProviderIds]
    .sort((left, right) => String(left).localeCompare(String(right)));
  const state = decodeProviderDispatchCursor(args.paginationOpts.cursor, providerIds, args.status);
  const page: Doc<'assignments'>[] = [];
  let iterations = 0;

  while (page.length < numItems) {
    iterations += 1;
    // Every successful iteration must append exactly one row, so `numItems` is
    // also the hard query-work ceiling. Keep that invariant explicit: if this
    // loop is later changed to retry a range without emitting, fail closed
    // instead of allowing a cursor regression to spin until Convex times out.
    if (iterations > numItems) return conflict();
    const candidates: { row: Doc<'assignments'>; providerId: Id<'providers'> }[] = [];
    for (const providerId of providerIds) {
      const rangeState = state.get(providerId);
      if (rangeState === undefined || rangeState.done) continue;
      const row = await firstProviderDispatchRow(
        ctx,
        args.projectId,
        providerId,
        args.status,
        rangeState.resume,
      );
      if (row === null) state.set(providerId, { resume: rangeState.resume, done: true });
      else candidates.push({ row, providerId });
    }
    if (candidates.length === 0) break;
    candidates.sort(compareDispatchCandidates);
    const selected = candidates[0];
    if (selected === undefined) break;
    const priorResume = state.get(selected.providerId)?.resume;
    if (
      priorResume !== undefined &&
      (selected.row.position < priorResume.position ||
        (selected.row.position === priorResume.position &&
          selected.row._creationTime <= priorResume.creationTime))
    ) return conflict();
    page.push(selected.row);
    state.set(selected.providerId, {
      resume: { position: selected.row.position, creationTime: selected.row._creationTime },
      done: false,
    });
  }

  return {
    page,
    isDone: providerIds.every((providerId) => state.get(providerId)?.done === true),
    continueCursor: encodeProviderDispatchCursor(providerIds, args.status, state),
  };
}

export async function dispatchDayReadiness(
  ctx: QueryCtx,
  args: { projectId: Id<'projects'>; from: number; to: number; eventId?: Id<'events'> },
): Promise<{ unassigned: number; total: number; complete: boolean }> {
  await requireAuthenticatedUser(ctx);
  const principal = await requirePrincipalForProject(ctx, args.projectId, 'readAssignment');
  if (principal.kind === 'provider') return notFoundOrInaccessible();
  assertDispatchWindow(args.from, args.to);

  const services = args.eventId === undefined
    ? await ctx.db.query('services')
        .withIndex('by_project_startsAt', (q) =>
          q.eq('projectId', args.projectId).gte('startsAt', args.from).lt('startsAt', args.to),
        )
        .take(maxDispatchReadinessServices + 1)
    : await takeEventDispatchServices(ctx, args, principal.organization._id);
  let complete = services.length <= maxDispatchReadinessServices;
  let unassigned = 0;
  let total = 0;
  for (const service of services.slice(0, maxDispatchReadinessServices)) {
    // The Event index pins only `eventId`; re-derive the Project as well as the
    // tenant before counting a denormalized Service relationship (I4). This is
    // unreachable under today's sole writer, which copies both from one Event.
    if (
      service.organizationId !== principal.organization._id ||
      service.projectId !== args.projectId
    ) return notFoundOrInaccessible();
    const remaining = maxDispatchReadinessAssignments - total;
    const assignments = await ctx.db.query('assignments')
      .withIndex('by_service_position', (q) => q.eq('serviceId', service._id))
      .take(Math.min(maxAssignmentsPerService, remaining + 1));
    const includedAssignments = assignments.slice(0, remaining);
    for (const assignment of includedAssignments) {
      if (
        assignment.organizationId !== service.organizationId ||
        assignment.projectId !== service.projectId
      ) return notFoundOrInaccessible();
      total += 1;
      if (assignment.executionStatus === 'unassigned') unassigned += 1;
    }
    if (assignments.length > remaining) {
      complete = false;
      break;
    }
  }
  return { unassigned, total, complete };
}

function boundedDispatchPaginationOptions(
  paginationOpts: PaginationOptions,
): PaginationOptions {
  if (!Number.isInteger(paginationOpts.numItems) || paginationOpts.numItems <= 0) {
    return invalidInput('paginationNumItemsInvalid', 'numItems must be a positive integer');
  }
  return {
    ...paginationOpts,
    numItems: Math.min(paginationOpts.numItems, maxDispatchPageSize),
  };
}

async function takeEventDispatchServices(
  ctx: QueryCtx,
  args: { projectId: Id<'projects'>; from: number; to: number; eventId?: Id<'events'> },
  organizationId: Id<'organizations'>,
): Promise<Doc<'services'>[]> {
  if (args.eventId === undefined) return [];
  const event = await ctx.db.get(args.eventId);
  if (
    event === null ||
    event.projectId !== args.projectId ||
    event.organizationId !== organizationId
  ) return notFoundOrInaccessible();
  return ctx.db.query('services')
    .withIndex('by_event_startsAt', (q) =>
      q.eq('eventId', event._id).gte('startsAt', args.from).lt('startsAt', args.to),
    )
    .take(maxDispatchReadinessServices + 1);
}

function assertDispatchWindow(from: number, to: number): void {
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from >= to ||
    to - from > maxDispatchWindowMilliseconds
  ) {
    return invalidInput(
      'assignmentDispatchWindowInvalid',
      'Dispatch windows require finite integer bounds, increasing order, and a maximum span of 31 days',
    );
  }
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
type ProviderDispatchRangeState = { resume: DispatchResume | undefined; done: boolean };
type ProviderDispatchCursorState = Map<Id<'providers'>, ProviderDispatchRangeState>;
type DispatchCursorState = Record<ExecutionStatus, { resume: DispatchResume | undefined; done: boolean }>;

async function firstProviderDispatchRow(
  ctx: QueryCtx,
  projectId: Id<'projects'>,
  providerId: Id<'providers'>,
  status: ExecutionStatus | undefined,
  resume: DispatchResume | undefined,
): Promise<Doc<'assignments'> | null> {
  if (resume !== undefined) {
    const samePosition = status === undefined
      ? ctx.db.query('assignments').withIndex('by_project_provider_position', (q) => q
          .eq('projectId', projectId)
          .eq('providerId', providerId)
          .eq('position', resume.position)
          .gt('_creationTime', resume.creationTime))
      : ctx.db.query('assignments').withIndex('by_project_provider_execution_position', (q) => q
          .eq('projectId', projectId)
          .eq('providerId', providerId)
          .eq('executionStatus', status)
          .eq('position', resume.position)
          .gt('_creationTime', resume.creationTime));
    const row = (await samePosition.take(1))[0];
    if (row !== undefined) return row;
  }

  const later = status === undefined
    ? ctx.db.query('assignments').withIndex('by_project_provider_position', (q) => {
        const range = q.eq('projectId', projectId).eq('providerId', providerId);
        return resume === undefined ? range : range.gt('position', resume.position);
      })
    : ctx.db.query('assignments').withIndex('by_project_provider_execution_position', (q) => {
        const range = q
          .eq('projectId', projectId)
          .eq('providerId', providerId)
          .eq('executionStatus', status);
        return resume === undefined ? range : range.gt('position', resume.position);
      });
  return (await later.take(1))[0] ?? null;
}

function decodeProviderDispatchCursor(
  cursor: string | null,
  providerIds: readonly Id<'providers'>[],
  status: ExecutionStatus | undefined,
): ProviderDispatchCursorState {
  const initial: ProviderDispatchCursorState = new Map(providerIds.map((providerId) => [
    providerId,
    { resume: undefined, done: false },
  ]));
  if (cursor === null) return initial;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return conflict();
  }
  if (
    !isRecord(parsed) ||
    parsed.status !== status ||
    !Array.isArray(parsed.ranges) ||
    parsed.ranges.length !== providerIds.length
  ) return conflict();

  for (let index = 0; index < providerIds.length; index += 1) {
    const providerId = providerIds[index];
    const range = parsed.ranges[index];
    if (
      providerId === undefined ||
      !isRecord(range) ||
      range.providerId !== providerId ||
      typeof range.done !== 'boolean'
    ) return conflict();
    if (range.resume === undefined) {
      initial.set(providerId, { resume: undefined, done: range.done });
      continue;
    }
    if (
      !isRecord(range.resume) ||
      typeof range.resume.position !== 'number' ||
      typeof range.resume.creationTime !== 'number'
    ) return conflict();
    initial.set(providerId, {
      resume: {
        position: range.resume.position,
        creationTime: range.resume.creationTime,
      },
      done: range.done,
    });
  }
  return initial;
}

function encodeProviderDispatchCursor(
  providerIds: readonly Id<'providers'>[],
  status: ExecutionStatus | undefined,
  state: ProviderDispatchCursorState,
): string {
  return JSON.stringify({
    ...(status === undefined ? {} : { status }),
    ranges: providerIds.map((providerId) => ({
      providerId,
      ...state.get(providerId),
    })),
  });
}

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

/** One numbering implementation shared by coordinator proposals and counters. */
/**
 * Refuses once the Assignment's revision history reaches its ceiling. Read
 * before every insert, in the same mutation, so the bound holds under OCC.
 */
async function assertRevisionCapacity(
  ctx: MutationCtx,
  assignmentId: Id<'assignments'>,
): Promise<void> {
  const existing = await ctx.db
    .query('assignmentRevisions')
    .withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignmentId))
    .take(maxRevisionsPerAssignment);
  if (existing.length >= maxRevisionsPerAssignment) {
    return invalidInput(
      'assignmentRevisionLimitReached',
      `An Assignment may carry at most ${maxRevisionsPerAssignment} revisions`,
    );
  }
}

async function nextAssignmentRevisionNumber(
  ctx: MutationCtx,
  assignmentId: Id<'assignments'>,
): Promise<number> {
  const latest = await ctx.db
    .query('assignmentRevisions')
    .withIndex('by_assignment_revision', (q) => q.eq('assignmentId', assignmentId))
    .order('desc')
    .first();
  return (latest?.revisionNumber ?? 0) + 1;
}

function validateNotes(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined;
  const trimmed = notes.trim();
  if (trimmed.length > maxAssignmentNotesLength) {
    return invalidInput('assignmentNotesTooLong', `Assignment notes must not exceed ${maxAssignmentNotesLength} characters`);
  }
  return trimmed;
}

function validateDeclinedReason(reason: string | undefined): string {
  if (reason === undefined || reason.trim() === '') {
    return invalidInput('assignmentDeclinedReasonRequired', 'A declined revision requires a reason');
  }
  const trimmed = reason.trim();
  if (trimmed.length > maxDeclinedReasonLength) {
    return invalidInput('assignmentDeclinedReasonTooLong', `Declined reason must not exceed ${maxDeclinedReasonLength} characters`);
  }
  return trimmed;
}


function validateCheckpointNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = note.trim();
  if (trimmed.length > maxCheckpointNoteLength) {
    return invalidInput(
      'assignmentCheckpointNoteTooLong',
      `Checkpoint note must not exceed ${maxCheckpointNoteLength} characters`,
    );
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
