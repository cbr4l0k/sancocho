import type { FunctionArgs, FunctionReturnType } from 'convex/server';

import { api } from '@priamo/convex/api';

import { multiplyMinorUnits } from './money';
import { rateModalities, type RateModality } from './rate-grid';

export type AssignmentRateResolution = FunctionReturnType<
  typeof api.assignments.queries.resolveAssignmentRate
>;
export type ResolvedAssignmentRate = Extract<AssignmentRateResolution, { kind: 'resolved' }>;
type UnpriceableAssignmentRate = Extract<AssignmentRateResolution, { kind: 'unpriceable' }>;

export type AssignmentRateState =
  | { kind: 'waiting' }
  | { kind: 'resolved'; rate: ResolvedAssignmentRate; lineTotal: number }
  | { kind: 'configurationGap'; reason: UnpriceableAssignmentRate['reason'] }
  | { kind: 'ambiguous'; candidates: Extract<AssignmentRateResolution, { kind: 'ambiguous' }>['candidates'] };

export function assignmentRateState(
  resolution: AssignmentRateResolution | undefined,
  quantity: number | undefined,
): AssignmentRateState {
  if (resolution === undefined || quantity === undefined) return { kind: 'waiting' };
  if (resolution.kind === 'resolved') {
    return { kind: 'resolved', rate: resolution, lineTotal: multiplyMinorUnits(resolution.unitAmount, quantity) };
  }
  if (resolution.kind === 'ambiguous') return { kind: 'ambiguous', candidates: resolution.candidates };
  return { kind: 'configurationGap', reason: resolution.reason };
}

export function parseQuantity(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function readModality(value: string): RateModality | undefined {
  return rateModalities.find((item) => item === value);
}

export function readExecutionStatus<T extends string>(allowed: readonly T[], value: string): T | undefined {
  return allowed.find((item) => item === value);
}

export function nextAssignmentPosition(rows: readonly { assignment: { position: number } }[]): number {
  return rows.reduce((maximum, row) => Math.max(maximum, row.assignment.position), -1) + 1;
}

type CreateRevisionArgs = FunctionArgs<typeof api.assignments.mutations.createAssignmentRevision>;
type CreateRevisionResult = FunctionReturnType<typeof api.assignments.mutations.createAssignmentRevision>;

export function resolvedRevisionArgs(
  assignmentId: CreateRevisionArgs['assignmentId'],
  vehicleClassId: CreateRevisionArgs['vehicleClassId'],
  modality: CreateRevisionArgs['modality'],
  quantity: number,
  rate: ResolvedAssignmentRate,
): CreateRevisionArgs {
  return {
    assignmentId,
    vehicleClassId,
    modality,
    quantity,
    rateCardVersionId: rate.rateCardVersionId,
    rateLineId: rate.rateLineId,
  };
}

export async function repriceAssignment(input: {
  assignmentId: CreateRevisionArgs['assignmentId'];
  vehicleClassId: CreateRevisionArgs['vehicleClassId'];
  modality: CreateRevisionArgs['modality'];
  quantity: number;
  rate: ResolvedAssignmentRate;
  createRevision: (args: CreateRevisionArgs) => Promise<CreateRevisionResult>;
}): Promise<void> {
  await input.createRevision(resolvedRevisionArgs(
    input.assignmentId,
    input.vehicleClassId,
    input.modality,
    input.quantity,
    input.rate,
  ));
}
