import type { ConvexErrorMessageKey } from './convex-errors';
import type { RateLookupResult } from './rate-lookup-result';
import type { PlannedRow } from './workbook-plan';

export type ImportRowAction = 'create' | 'skip';
export type ImportSkipReason = 'blocked' | 'existingService' | 'selected';

export type ImportRowOutcome =
  | { kind: 'created'; rowNumber: number; assignment: 'none' | 'unpriced' | 'priced' }
  | { kind: 'skipped'; rowNumber: number; reason: ImportSkipReason }
  | { kind: 'failedService'; rowNumber: number; errorKey: ConvexErrorMessageKey }
  | { kind: 'failedAssignment'; rowNumber: number; errorKey: ConvexErrorMessageKey }
  | {
      kind: 'failedRevision';
      rowNumber: number;
      step: 'revision' | 'acceptance';
      errorKey: ConvexErrorMessageKey;
    };

export type ImportRunState = {
  totalRows: number;
  outcomes: readonly ImportRowOutcome[];
  stopped: boolean;
};

export type ImportRunSummary = {
  totalRows: number;
  processedRows: number;
  untouched: number;
  created: number;
  skipped: number;
  failedService: number;
  failedAssignment: number;
  failedRevision: number;
  halfImported: number;
};

export function importRowIsBlocked(row: Pick<PlannedRow, 'problems'>, rateResult: RateLookupResult | undefined): boolean {
  return row.problems.length > 0 || rateResult?.kind === 'ambiguous';
}

export function initialImportRowAction(
  row: Pick<PlannedRow, 'defaultAction' | 'problems'>,
  rateResult: RateLookupResult | undefined,
): ImportRowAction {
  return row.defaultAction === 'create' && !importRowIsBlocked(row, rateResult) ? 'create' : 'skip';
}

export function canSetImportRowAction(
  row: Pick<PlannedRow, 'problems'>,
  rateResult: RateLookupResult | undefined,
  action: ImportRowAction,
): boolean {
  return action === 'skip' || !importRowIsBlocked(row, rateResult);
}

export function importRowSkipReason(
  row: Pick<PlannedRow, 'problems' | 'existingServiceId'>,
  rateResult: RateLookupResult | undefined,
): ImportSkipReason {
  if (importRowIsBlocked(row, rateResult)) return 'blocked';
  return row.existingServiceId === undefined ? 'selected' : 'existingService';
}

export function importSelectionCounts(
  rows: readonly {
    row: Pick<PlannedRow, 'assignment'>;
    action: ImportRowAction;
  }[],
): { services: number; assignments: number } {
  let services = 0;
  let assignments = 0;
  for (const item of rows) {
    if (item.action !== 'create') continue;
    services += 1;
    if (item.row.assignment !== undefined) assignments += 1;
  }
  return { services, assignments };
}

export function startImportRun(totalRows: number): ImportRunState {
  return { totalRows, outcomes: [], stopped: false };
}

export function recordImportRowOutcome(state: ImportRunState, outcome: ImportRowOutcome): ImportRunState {
  if (state.stopped || state.outcomes.length >= state.totalRows) return state;
  return { ...state, outcomes: [...state.outcomes, outcome] };
}

export function stopImportRun(state: ImportRunState): ImportRunState {
  return state.outcomes.length >= state.totalRows ? state : { ...state, stopped: true };
}

export function nextImportRowIndex(state: ImportRunState): number | undefined {
  return state.stopped || state.outcomes.length >= state.totalRows ? undefined : state.outcomes.length;
}

export function runSummary(state: ImportRunState): ImportRunSummary {
  let created = 0;
  let skipped = 0;
  let failedService = 0;
  let failedAssignment = 0;
  let failedRevision = 0;
  for (const outcome of state.outcomes) {
    switch (outcome.kind) {
      case 'created': created += 1; break;
      case 'skipped': skipped += 1; break;
      case 'failedService': failedService += 1; break;
      case 'failedAssignment': failedAssignment += 1; break;
      case 'failedRevision': failedRevision += 1; break;
    }
  }
  return {
    totalRows: state.totalRows,
    processedRows: state.outcomes.length,
    untouched: state.totalRows - state.outcomes.length,
    created,
    skipped,
    failedService,
    failedAssignment,
    failedRevision,
    halfImported: failedAssignment + failedRevision,
  };
}
