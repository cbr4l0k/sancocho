import type { ExecutionStatus } from '@priamo/convex/assignments/execution';

export type ExecutionSubmitProblem =
  | { kind: 'vehicle' }
  | { kind: 'driver' }
  | { kind: 'notExecutedReason' };

type ExecutionSubmitFields = {
  status: ExecutionStatus;
  fleetVehicleId?: string | undefined;
  vehiclePlateOverride?: string | undefined;
  driverName?: string | undefined;
  notExecutedReason?: string | undefined;
};

/** Mirrors the backend's resulting-row preconditions before enabling submit. */
export function executionSubmitProblem(fields: ExecutionSubmitFields): ExecutionSubmitProblem | undefined {
  if (fields.status !== 'unassigned' && fields.status !== 'notExecuted') {
    const hasFleetVehicle = fields.fleetVehicleId !== undefined;
    const hasPlateOverride = fields.vehiclePlateOverride !== undefined &&
      fields.vehiclePlateOverride.trim() !== '';
    if (hasFleetVehicle === hasPlateOverride) return { kind: 'vehicle' };
  }
  if (
    fields.status === 'confirmed' &&
    (fields.driverName === undefined || fields.driverName.trim() === '')
  ) return { kind: 'driver' };
  if (fields.status === 'notExecuted') {
    const reason = fields.notExecutedReason?.trim();
    if (reason === undefined || reason.length === 0 || reason.length > 1000) {
      return { kind: 'notExecutedReason' };
    }
  }
  return undefined;
}
