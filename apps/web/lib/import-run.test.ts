import { describe, expect, test } from 'bun:test';

import {
  canSetImportRowAction,
  importSelectionCounts,
  initialImportRowAction,
  importRowSkipReason,
  nextImportRowIndex,
  recordImportRowOutcome,
  runSummary,
  startImportRun,
  stopImportRun,
  type ImportRowOutcome,
} from './import-run';
import type { PlannedRow } from './workbook-plan';

const mixedOutcomes: readonly ImportRowOutcome[] = [
  { kind: 'created', rowNumber: 2, assignment: 'priced' },
  { kind: 'skipped', rowNumber: 3, reason: 'selected' },
  { kind: 'failedService', rowNumber: 4, errorKey: 'errors.serviceDatesInvalid' },
  { kind: 'failedAssignment', rowNumber: 5, errorKey: 'errors.assignmentLimitExceeded' },
  { kind: 'failedRevision', rowNumber: 6, step: 'revision', errorKey: 'errors.assignmentRevisionQuantityInvalid' },
];

function stateWith(outcomes: readonly ImportRowOutcome[]) {
  return outcomes.reduce(recordImportRowOutcome, startImportRun(outcomes.length));
}

describe('import run outcomes', () => {
  test('a mixed run partitions every row exactly once across all three failure steps', () => {
    const summary = runSummary(stateWith(mixedOutcomes));
    expect(summary).toEqual({
      totalRows: 5,
      processedRows: 5,
      untouched: 0,
      created: 1,
      skipped: 1,
      failedService: 1,
      failedAssignment: 1,
      failedRevision: 1,
      halfImported: 2,
    });
    expect(summary.created + summary.skipped + summary.failedService + summary.halfImported + summary.untouched).toBe(5);
  });

  test('a half-imported row is neither a clean success nor a clean failure', () => {
    const summary = runSummary(stateWith([
      { kind: 'failedAssignment', rowNumber: 8, errorKey: 'errors.assignmentLimitExceeded' },
    ]));
    expect(summary).toMatchObject({ created: 0, failedService: 0, halfImported: 1 });
  });

  test('a row failure does not abandon the remaining rows', () => {
    const afterFailure = recordImportRowOutcome(startImportRun(3), {
      kind: 'failedService', rowNumber: 2, errorKey: 'errors.serviceDatesInvalid',
    });
    expect(nextImportRowIndex(afterFailure)).toBe(1);
    const afterNextRow = recordImportRowOutcome(afterFailure, { kind: 'created', rowNumber: 3, assignment: 'none' });
    expect(afterNextRow.outcomes).toHaveLength(2);
  });

  test('stopping between rows leaves the remainder untouched', () => {
    const afterFirst = recordImportRowOutcome(startImportRun(4), { kind: 'created', rowNumber: 2, assignment: 'none' });
    const stopped = stopImportRun(afterFirst);
    const summary = runSummary(stopped);
    expect(summary).toMatchObject({ processedRows: 1, created: 1, skipped: 0, failedService: 0, halfImported: 0, untouched: 3 });
    expect(nextImportRowIndex(stopped)).toBeUndefined();
  });
});

describe('import row decisions', () => {
  test('a blocked row cannot be un-skipped', () => {
    const blocked: Pick<PlannedRow, 'defaultAction' | 'problems'> = {
      defaultAction: 'skip', problems: [{ kind: 'missingServiceName' }],
    };
    expect(canSetImportRowAction(blocked, undefined, 'create')).toBe(false);
    expect(canSetImportRowAction(blocked, undefined, 'skip')).toBe(true);
  });

  test('an ambiguous rate blocks creation but an unpriceable rate does not', () => {
    const clean: Pick<PlannedRow, 'defaultAction' | 'problems'> = { defaultAction: 'create', problems: [] };
    expect(initialImportRowAction(clean, { kind: 'ambiguous', candidates: [] })).toBe('skip');
    expect(initialImportRowAction(clean, { kind: 'unpriceable', reason: 'noRateLine' })).toBe('create');
  });

  test('skipped rows retain a reason suitable for the final report', () => {
    expect(importRowSkipReason({ problems: [{ kind: 'missingServiceName' }] }, undefined)).toBe('blocked');
    expect(importRowSkipReason({ problems: [], existingServiceId: 'service-1' }, undefined)).toBe('existingService');
    expect(importRowSkipReason({ problems: [] }, undefined)).toBe('selected');
  });

  test('confirmation counts only selected Services and their requested Assignments', () => {
    const rows: Parameters<typeof importSelectionCounts>[0] = [
      { row: { assignment: { create: { providerId: 'provider-1', position: 0 } } }, action: 'create' },
      { row: {}, action: 'create' },
      { row: { assignment: { create: { providerId: 'provider-2', position: 0 } } }, action: 'skip' },
    ];
    expect(importSelectionCounts(rows)).toEqual({ services: 2, assignments: 1 });
  });

  test('a safe re-run whose rows all match existing Services creates nothing', () => {
    const rows: Parameters<typeof importSelectionCounts>[0] = [
      { row: { assignment: { create: { providerId: 'provider-1', position: 0 }, unpricedReason: 'noRate' } }, action: initialImportRowAction({ defaultAction: 'skip', problems: [] }, undefined) },
      { row: {}, action: initialImportRowAction({ defaultAction: 'skip', problems: [] }, undefined) },
    ];
    expect(importSelectionCounts(rows)).toEqual({ services: 0, assignments: 0 });
  });
});
