import type { ImportRowAction } from './import-run';
import { isRateLookupResult, rateLookupKey, type RateLookupResult } from './rate-lookup-result';
import type { PlannedRow, WorkbookPlan } from './workbook-plan';

export type ImportSnapshotItem = {
  readonly row: PlannedRow;
  readonly action: ImportRowAction;
  readonly rateResult: RateLookupResult | Error | undefined;
};

export type ImportSnapshot = {
  readonly plan: WorkbookPlan;
  readonly items: readonly ImportSnapshotItem[];
};

/**
 * Materializes every row's action and rate ONCE, so a run reads the workbook as it
 * was when the operator confirmed it. Callers may pass live lookups: `rateFor` and
 * `actionFor` are called here and never again.
 *
 * Both halves matter. `existingServices` is a live query over the very Event being
 * written into, so an unpinned plan drifts from "Will create: 100" to
 * "Already exists: 100" beside a report reading "Created: 100". The rates are the
 * same hazard one layer down: pinning only the rows leaves `rateResult` live, and a
 * lookup that resolves mid-run can flip a row from blocked to creatable after the
 * run decided to skip it.
 */
export function importSnapshot(
  plan: WorkbookPlan,
  rateFor: (row: PlannedRow) => RateLookupResult | Error | undefined,
  actionFor: (row: PlannedRow) => ImportRowAction,
): ImportSnapshot {
  return {
    plan,
    items: plan.rows.map((row) => ({ row, action: actionFor(row), rateResult: rateFor(row) })),
  };
}

/**
 * An errored lookup is never handed to a write: the row was blocked and skipped.
 * Narrowing rather than asserting keeps that true by construction instead of by
 * comment, and an `unpriceable` or `ambiguous` result still travels through.
 */
export function rateResultForWrite(
  value: RateLookupResult | Error | undefined,
): RateLookupResult | undefined {
  return value instanceof Error ? undefined : value;
}

/**
 * An errored lookup is returned as the Error itself rather than collapsed to
 * `undefined`: `importRowIsBlocked` treats it as blocking, because not knowing a
 * row's rate is not the same as knowing it has none.
 */
export function rowRateResult(
  row: Pick<PlannedRow, 'rateLookup'>,
  results: Readonly<Record<string, unknown>>,
): RateLookupResult | Error | undefined {
  if (row.rateLookup === undefined) return undefined;
  const value = results[rateLookupKey(row.rateLookup)];
  if (value instanceof Error) return value;
  return isRateLookupResult(value) ? value : undefined;
}
