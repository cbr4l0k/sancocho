import { describe, expect, test } from 'bun:test';

import type { VersionField, WorkbookMapping } from './workbook-mapping';
import {
  buildWorkbookPlan,
  summarizePlan,
  type PlannedRow,
  type RateModality,
  type WorkbookCatalogues,
  type WorkbookRow,
} from './workbook-plan';

const backendRateModalities = {
  transfer: true,
  disposition: true,
  route: true,
  fixed: true,
} as const satisfies Record<RateModality, true>;

const mapping: WorkbookMapping = [
  { kind: 'serviceName' },
  { kind: 'startsAtDate' },
  { kind: 'startsAtTime' },
  { kind: 'field', fieldDefinitionId: 'passengers' },
  { kind: 'provider' },
  { kind: 'vehicleClass' },
  { kind: 'modality' },
  { kind: 'quantity' },
  { kind: 'workbookAmount' },
];

const fields: readonly VersionField[] = [
  { fieldDefinitionId: 'passengers', required: true, config: { kind: 'number', min: 1, integer: true } },
];

const catalogues: WorkbookCatalogues = {
  locations: [],
  providers: [{ id: 'provider-1', name: 'Transportes Uno' }, { id: 'provider-2', name: 'Transportes Dos' }],
  vehicleClasses: [{ id: 'class-1', name: 'Sprinter' }],
  costCentres: [],
  existingServices: [],
  rates: [
    {
      providerId: 'provider-1', vehicleClassId: 'class-1', modality: 'transfer',
      rateCardVersionId: 'card-cop', rateLineId: 'line-cop', unitAmount: 81_000_000, currency: 'COP',
    },
    {
      providerId: 'provider-2', vehicleClassId: 'class-1', modality: 'transfer',
      rateCardVersionId: 'card-usd', rateLineId: 'line-usd', unitAmount: 25_000, currency: 'USD',
    },
  ],
};

function goodRow(rowNumber: number, name = `Service ${rowNumber}`, provider = 'Transportes Uno'): WorkbookRow {
  return {
    rowNumber,
    cells: [name, 46277, 0.4305555555555556, 12, provider, 'Sprinter', 'transfer', 1, '750000'],
  };
}

describe('workbook plan rows', () => {
  test('builds a clean file where every row can be created', () => {
    const plan = buildWorkbookPlan({ rows: [goodRow(2), goodRow(3)], mapping, versionFields: fields, catalogues });
    expect(plan.mappingProblems).toEqual([]);
    expect(plan.rows.map((row) => row.problems)).toEqual([[], []]);
    expect(plan.summary).toMatchObject({ willCreate: 2, alreadyExists: 0, blockedByErrors: 0 });
  });

  test('carries validated pricing inputs for one distinct-triple lookup pass', () => {
    const source = goodRow(2);
    const row = { ...source, cells: [...source.cells.slice(0, 7), 4, ...source.cells.slice(8)] };
    const plan = buildWorkbookPlan({ rows: [row], mapping, versionFields: fields, catalogues });
    expect(plan.rows[0]?.rateLookup).toEqual({
      providerId: 'provider-1',
      vehicleClassId: 'class-1',
      modality: 'transfer',
      quantity: 4,
    });
  });

  test('keeps one bad cell local to its row', () => {
    const bad = { ...goodRow(3), cells: [...goodRow(3).cells.slice(0, 3), 'twelve', ...goodRow(3).cells.slice(4)] };
    const plan = buildWorkbookPlan({
      rows: [goodRow(2), bad, goodRow(4)], mapping, versionFields: fields, catalogues,
    });
    expect(plan.rows[0]?.problems).toEqual([]);
    expect(plan.rows[1]?.problems).toEqual([
      { kind: 'field', fieldDefinitionId: 'passengers', problem: 'notANumber' },
    ]);
    expect(plan.rows[1]?.defaultAction).toBe('skip');
    expect(plan.rows[2]?.problems).toEqual([]);
    expect(plan.summary).toMatchObject({ willCreate: 2, blockedByErrors: 1 });
  });

  test('reports a file where every row is blocked', () => {
    const rows: readonly WorkbookRow[] = [
      { ...goodRow(2), cells: ['', ...goodRow(2).cells.slice(1)] },
      { ...goodRow(3), cells: [goodRow(3).cells[0] ?? '', '12/09/2026', ...goodRow(3).cells.slice(2)] },
    ];
    const plan = buildWorkbookPlan({ rows, mapping, versionFields: fields, catalogues });
    expect(plan.rows.every((row) => row.defaultAction === 'skip')).toBe(true);
    expect(plan.summary).toMatchObject({ willCreate: 0, alreadyExists: 0, blockedByErrors: 2 });
  });

  test('marks a name and start match as an existing service and defaults it to skip', () => {
    const withExisting: WorkbookCatalogues = {
      ...catalogues,
      existingServices: [{
        id: 'existing-1',
        name: 'Morning transfer',
        startsAt: new Date(2026, 8, 12, 10, 20).getTime(),
      }],
    };
    const plan = buildWorkbookPlan({
      rows: [goodRow(2, 'Morning transfer')], mapping, versionFields: fields, catalogues: withExisting,
    });
    expect(plan.rows[0]).toMatchObject({ existingServiceId: 'existing-1', defaultAction: 'skip', problems: [] });
    expect(plan.summary).toMatchObject({ willCreate: 0, alreadyExists: 1, blockedByErrors: 0 });
  });

  test('keeps workbook amount solely in its comparison, outside assignment mutation data', () => {
    const plan = buildWorkbookPlan({ rows: [goodRow(2)], mapping, versionFields: fields, catalogues });
    expect(plan.rows[0]?.assignment).toEqual({
      create: { providerId: 'provider-1', position: 0 },
      revision: {
        vehicleClassId: 'class-1',
        modality: 'transfer',
        quantity: 1,
        rateCardVersionId: 'card-cop',
        rateLineId: 'line-cop',
      },
    });
    expect(plan.rows[0]?.amountComparison).toEqual({
      workbookMinorUnits: 75_000_000,
      cardMinorUnits: 81_000_000,
      currency: 'COP',
      differs: true,
    });
  });

  test('lists unresolved catalogues and frozen select options separately with row numbers', () => {
    const optionMapping: WorkbookMapping = [
      ...mapping,
      { kind: 'field', fieldDefinitionId: 'stage' },
    ];
    const optionFields: readonly VersionField[] = [
      ...fields,
      { fieldDefinitionId: 'stage', required: true, config: { kind: 'select', options: [{ id: 'main', label: 'Main' }] } },
    ];
    const row = goodRow(7);
    const plan = buildWorkbookPlan({
      rows: [{ ...row, cells: [...row.cells.slice(0, 4), 'Missing Provider', ...row.cells.slice(5), 'Side'] }],
      mapping: optionMapping,
      versionFields: optionFields,
      catalogues,
    });
    expect(plan.unresolvedReferences).toEqual([{ kind: 'provider', name: 'Missing Provider', rows: [7] }]);
    expect(plan.unresolvedOptions).toEqual([{ fieldDefinitionId: 'stage', label: 'Side', rows: [7] }]);
  });

  test('accepts every backend modality', () => {
    const rows = Object.keys(backendRateModalities).map((modality, index) => {
      const row = goodRow(index + 2);
      return { ...row, cells: [...row.cells.slice(0, 6), modality, ...row.cells.slice(7)] };
    });
    const plan = buildWorkbookPlan({ rows, mapping, versionFields: fields, catalogues });
    expect(plan.rows.map((row) => row.rateLookup?.modality)).toEqual([
      'transfer',
      'disposition',
      'route',
      'fixed',
    ]);
    expect(plan.rows.flatMap((row) => row.problems)).not.toContainEqual({
      kind: 'assignment', target: 'modality', problem: 'unknownModality',
    });
  });

  test('rejects unknown and non-string modalities instead of creating one', () => {
    const invalidModalities = ['hourly', null, 42, new Date(0)];
    const rows = invalidModalities.map((modality, index) => {
      const row = goodRow(index + 2);
      return { ...row, cells: [...row.cells.slice(0, 6), modality, ...row.cells.slice(7)] };
    });
    const plan = buildWorkbookPlan({
      rows,
      mapping,
      versionFields: fields,
      catalogues,
    });
    for (const row of plan.rows) {
      expect(row.problems).toContainEqual({
        kind: 'assignment', target: 'modality', problem: 'unknownModality',
      });
      expect(row.assignment).toBeUndefined();
    }
  });

  test('carries an unpriced assignment without turning the pricing gap into a row error', () => {
    const withoutRates: WorkbookCatalogues = { ...catalogues, rates: [] };
    const plan = buildWorkbookPlan({ rows: [goodRow(2)], mapping, versionFields: fields, catalogues: withoutRates });
    expect(plan.rows[0]?.problems).toEqual([]);
    expect(plan.rows[0]?.assignment).toEqual({
      create: { providerId: 'provider-1', position: 0 },
      unpricedReason: 'noRate',
    });
    expect(plan.summary.willBeUnpriced).toBe(1);
  });
});

describe('plan summary', () => {
  test('partitions each row into exactly one confirmation outcome', () => {
    const create = buildWorkbookPlan({ rows: [goodRow(2)], mapping, versionFields: fields, catalogues }).rows[0];
    const existing = { ...create, existingServiceId: 'existing', defaultAction: 'skip' as const };
    const blocked = {
      ...create,
      problems: [{ kind: 'missingServiceName' as const }],
      defaultAction: 'skip' as const,
    };
    const rows = [create, existing, blocked].filter((row): row is PlannedRow => row !== undefined);
    const summary = summarizePlan(rows);
    expect(summary).toMatchObject({ willCreate: 1, alreadyExists: 1, blockedByErrors: 1 });
    expect(summary.willCreate + summary.alreadyExists + summary.blockedByErrors).toBe(rows.length);
  });

  test('keeps two currencies as separate figures', () => {
    const usd = goodRow(3, 'USD service', 'Transportes Dos');
    const usdCells = [...usd.cells];
    usdCells[8] = '250';
    const plan = buildWorkbookPlan({
      rows: [goodRow(2), { ...usd, cells: usdCells }],
      mapping,
      versionFields: fields,
      catalogues,
    });
    expect(plan.summary.currencies).toEqual([
      { currency: 'COP', workbookMinorUnits: 75_000_000, cardMinorUnits: 81_000_000 },
      { currency: 'USD', workbookMinorUnits: 25_000, cardMinorUnits: 25_000 },
    ]);
    expect(plan.summary.rateDiffers).toBe(1);
  });
});
