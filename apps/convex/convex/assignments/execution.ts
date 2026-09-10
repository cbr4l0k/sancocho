import { invalidInput } from '../lib/errors';
import type { executionStatusValidator, serviceStatusValidator } from '../validators';

export type ExecutionStatus = typeof executionStatusValidator.type;
type ServiceStatus = typeof serviceStatusValidator.type;

const transitions = (...statuses: ExecutionStatus[]): readonly ExecutionStatus[] => Object.freeze(statuses);

export const executionStatuses = Object.freeze([
  'unassigned',
  'assigned',
  'confirmed',
  'dispatched',
  'completed',
  'notExecuted',
] as const satisfies readonly ExecutionStatus[]);

/** The single lifecycle definition consumed by both production code and the exhaustive matrix test. */
export const executionStatusTransitions: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = Object.freeze({
  unassigned: transitions('assigned', 'notExecuted'),
  assigned: transitions('confirmed', 'unassigned', 'notExecuted'),
  confirmed: transitions('dispatched', 'assigned', 'notExecuted'),
  dispatched: transitions('completed', 'notExecuted'),
  completed: transitions(),
  notExecuted: transitions(),
});

export type ResultingExecutionFields<VehicleId extends string = string> = {
  serviceStatus: ServiceStatus;
  fleetVehicleId?: VehicleId | undefined;
  vehiclePlateOverride?: string | undefined;
  driverName?: string | undefined;
  driverPhone?: string | undefined;
  dispatchedAt?: number | undefined;
  completedAt?: number | undefined;
  notExecutedReason?: string | undefined;
};

/**
 * Resolves lifecycle-dependent clearing and validates the complete resulting
 * execution row. Database access and server time stay outside this pure gate.
 */
export function transitionExecution<VehicleId extends string>(
  current: ExecutionStatus,
  next: ExecutionStatus,
  resultingFields: ResultingExecutionFields<VehicleId>,
): ResultingExecutionFields<VehicleId> {
  if (executionStatusTransitions[current].length === 0) {
    return invalidInput('assignmentExecutionTerminal', 'Completed and not-executed Assignments are terminal');
  }
  if (!executionStatusTransitions[current].includes(next)) {
    return invalidInput('assignmentExecutionStatusTransitionInvalid', 'Assignment execution status transition is not permitted');
  }

  const resolved = { ...resultingFields };
  if (next === 'unassigned') {
    resolved.fleetVehicleId = undefined;
    resolved.vehiclePlateOverride = undefined;
    resolved.driverName = undefined;
    resolved.driverPhone = undefined;
  } else if (current === 'confirmed' && next === 'assigned') {
    resolved.driverName = undefined;
    resolved.driverPhone = undefined;
  }

  // Checked on every state that names a vehicle, not only on the transition
  // that first attaches one. Scoping it to `assigned` let a second call add a
  // Fleet Vehicle on top of a surviving plate override — `assigned` with a
  // plate, then `confirmed` with a fleetVehicleId — leaving the row naming two
  // different vehicles with no way to tell which one actually went.
  if (next !== 'unassigned' && next !== 'notExecuted') {
    const hasFleetVehicle = resolved.fleetVehicleId !== undefined;
    const hasPlateOverride = resolved.vehiclePlateOverride !== undefined;
    if (hasFleetVehicle === hasPlateOverride) {
      return invalidInput('assignmentExecutionVehicleInvalid', 'Execution requires exactly one vehicle source');
    }
  }
  if (next === 'confirmed' && resolved.driverName === undefined) {
    return invalidInput('assignmentExecutionDriverRequired', 'Confirmed execution requires a driver name');
  }
  if (next === 'dispatched' && !serviceIsAtLeastConfirmed(resolved.serviceStatus)) {
    return invalidInput('assignmentExecutionServiceNotConfirmed', 'Dispatch requires a confirmed Service');
  }
  if (next === 'notExecuted') {
    const reason = resolved.notExecutedReason?.trim();
    if (reason === undefined || reason.length === 0 || reason.length > 1000) {
      return invalidInput('assignmentNotExecutedReasonInvalid', 'A not-executed reason must contain at most 1000 characters');
    }
    resolved.notExecutedReason = reason;
  }
  return resolved;
}

function serviceIsAtLeastConfirmed(status: ServiceStatus): boolean {
  return status === 'confirmed' || status === 'active' || status === 'completed';
}
