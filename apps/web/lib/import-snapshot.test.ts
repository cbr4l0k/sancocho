import { describe, expect, test } from 'bun:test';

import type { ImportRowAction } from './import-run';
import { importSnapshot, rateResultForWrite, rowRateResult } from './import-snapshot';
import type { RateLookupResult } from './rate-lookup-result';
import type { WorkbookMapping } from './workbook-mapping';
import { buildWorkbookPlan, type PlannedRow, type WorkbookCatalogues, type WorkbookRow } from './workbook-plan';

const mapping: WorkbookMapping = [
  { kind: 'serviceName' },
  { kind: 'startsAtDate' },
  { kind: 'startsAtTime' },
];

const catalogues: WorkbookCatalogues = {
  locations: [],
  providers: [],
  vehicleClasses: [],
  costCentres: [],
  existingServices: [],
  rates: [],
};

/*
 * These tests run under TZ=America/Bogota, pinned in apps/web/package.json, so the
 * instant a `46277` / `0.4305555555555556` pair composes to is the local one below.
 */
const startsAt = new Date(2026, 8, 12, 10, 20).getTime();

function row(rowNumber: number, name: string): WorkbookRow {
  return { rowNumber, cells: [name, 46277, 0.4305555555555556] };
}

function tableId<TableName extends string>(id: string, table: TableName): string & { __tableName: TableName } {
  return Object.assign(id, { __tableName: table });
}

const resolved: RateLookupResult = {
  kind: 'resolved',
  rateCardId: tableId('card-1', 'rateCards'),
  rateCardName: 'Tarifa 2026',
  rateCardVersionId: tableId('version-1', 'rateCardVersions'),
  rateLineId: tableId('line-1', 'rateLines'),
  unitAmount: 810_000,
  currency: 'COP',
};

const noRateLine: RateLookupResult = { kind: 'unpriceable', reason: 'noRateLine' };
const limitExceeded: RateLookupResult = { kind: 'unpriceable', reason: 'rateCardLimitExceeded' };

describe('import snapshot', () => {
  test('materializes every row rate and action once, not on each read', () => {
    const plan = buildWorkbookPlan({ rows: [row(2, 'Servicio 1')], mapping, versionFields: [], catalogues });
    const rates: Record<number, RateLookupResult | Error | undefined> = { 2: noRateLine };
    const chosen: Record<number, ImportRowAction> = { 2: 'create' };
    const snapshot = importSnapshot(
      plan,
      (planned) => rates[planned.rowNumber],
      (planned) => chosen[planned.rowNumber] ?? 'skip',
    );

    rates[2] = limitExceeded;
    chosen[2] = 'skip';

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.rateResult).toEqual({ kind: 'unpriceable', reason: 'noRateLine' });
    expect(snapshot.items[0]?.action).toBe('create');
    expect(snapshot.items[0]?.row.rowNumber).toBe(2);
  });

  test('pairs every row with its own rate and its own action, in order', () => {
    const rows = [row(2, 'Servicio 1'), row(3, 'Servicio 2'), row(4, 'Servicio 3')];
    const plan = buildWorkbookPlan({ rows, mapping, versionFields: [], catalogues });
    // Three rows made deliberately distinguishable. A snapshot that reads row 2's rate
    // for every row would write one provider's agreed amount onto another row's
    // revision (I10), and one that reads row 2's action would discard the operator's
    // per-row skips — both silently, with every row still present and in order.
    const rates: Record<number, RateLookupResult | Error | undefined> = {
      2: resolved,
      3: noRateLine,
      4: undefined,
    };
    const chosen: Record<number, ImportRowAction> = { 2: 'create', 3: 'skip', 4: 'create' };

    const snapshot = importSnapshot(
      plan,
      (planned) => rates[planned.rowNumber],
      (planned) => chosen[planned.rowNumber] ?? 'skip',
    );

    expect(snapshot.items.map((item) => [item.row.rowNumber, item.action, item.rateResult])).toEqual([
      [2, 'create', resolved],
      [3, 'skip', noRateLine],
      [4, 'create', undefined],
    ]);
  });

  test('holds the plan it was handed, never one re-derived from a live catalogue', () => {
    const rows = [row(2, 'Servicio 1'), row(3, 'Servicio 2'), row(4, 'Servicio 3')];
    const before = buildWorkbookPlan({ rows, mapping, versionFields: [], catalogues });
    const snapshot = importSnapshot(before, () => undefined, (planned) => planned.defaultAction);

    // The same workbook re-planned against an Event that now holds the Services the
    // run just created — the drift the freeze exists to stop. `importSnapshot` cannot
    // itself drift, since it returns the plan by identity; whether the confirm path
    // actually pins it is wiring in `workbook-import-surface.tsx` and is not tested
    // here. This pins the contract the wiring depends on.
    const after = buildWorkbookPlan({
      rows,
      mapping,
      versionFields: [],
      catalogues: {
        ...catalogues,
        existingServices: [
          { id: 'service-1', name: 'Servicio 1', startsAt },
          { id: 'service-2', name: 'Servicio 2', startsAt },
          { id: 'service-3', name: 'Servicio 3', startsAt },
        ],
      },
    });
    expect(after.summary.willCreate).toBe(0);
    expect(after.summary.alreadyExists).toBe(3);

    expect(snapshot.plan).toBe(before);
    expect(snapshot.plan.summary.willCreate).toBe(3);
    expect(snapshot.plan.rows.map((planned) => planned.existingServiceId)).toEqual([undefined, undefined, undefined]);
  });

  test('rateResultForWrite drops an errored lookup and only an errored lookup', () => {
    const failure = new Error('lookup failed');
    expect(rateResultForWrite(failure)).toBeUndefined();
    expect(rateResultForWrite(resolved)).toBe(resolved);
    expect(rateResultForWrite(noRateLine)).toBe(noRateLine);
    expect(rateResultForWrite(undefined)).toBeUndefined();
  });

  test('rowRateResult keeps an errored lookup distinct from a missing one', () => {
    const rateLookup: NonNullable<PlannedRow['rateLookup']> = {
      providerId: 'provider-1',
      vehicleClassId: 'class-1',
      modality: 'transfer',
      quantity: 1,
    };
    const key = '["provider-1","class-1","transfer"]';
    const failure = new Error('boom');

    // Not knowing a row's rate is not the same as knowing it has none: the Error
    // must survive, because `importRowIsBlocked` reads it as blocking.
    // A plain payload, not the branded `resolved` fixture: `tableId` boxes its string
    // through `Object.assign`, so `typeof id === 'string'` is false and
    // `isRateLookupResult` rejects it. `results` is `Record<string, unknown>` anyway.
    const resolvedPayload = {
      kind: 'resolved',
      rateCardId: 'card-1',
      rateCardName: 'Tarifa 2026',
      rateCardVersionId: 'version-1',
      rateLineId: 'line-1',
      unitAmount: 810_000,
      currency: 'COP',
    };
    // The accept path. Without it every priced row loses its rate and is written
    // unpriced, and the rejection assertions below would still all pass.
    expect(rowRateResult({ rateLookup }, { [key]: resolvedPayload })).not.toBeUndefined();
    expect(rowRateResult({ rateLookup }, { [key]: resolvedPayload })).toEqual<unknown>(resolvedPayload);
    expect(rowRateResult({ rateLookup }, { [key]: failure })).toBe(failure);
    expect(rowRateResult({ rateLookup }, { [key]: { kind: 'resolved' } })).toBeUndefined();
    expect(rowRateResult({ rateLookup }, {})).toBeUndefined();
    expect(rowRateResult({}, { [key]: failure })).toBeUndefined();
  });
});
