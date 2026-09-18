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

  test('does not treat a service as existing unless both name and start match', () => {
    const withExisting: WorkbookCatalogues = {
      ...catalogues,
      existingServices: [{
        id: 'existing-1',
        name: 'Morning transfer',
        startsAt: new Date(2026, 8, 12, 10, 20).getTime(),
      }],
    };
    const later = goodRow(2, 'Morning transfer');
    const laterCells = [...later.cells];
    laterCells[2] = 0.5;
    const plan = buildWorkbookPlan({
      rows: [{ ...later, cells: laterCells }, goodRow(3, 'Afternoon transfer')],
      mapping,
      versionFields: fields,
      catalogues: withExisting,
    });
    expect(plan.rows[0]?.existingServiceId).toBeUndefined();
    expect(plan.rows[0]?.defaultAction).toBe('create');
    expect(plan.rows[1]?.existingServiceId).toBeUndefined();
    expect(plan.rows[1]?.defaultAction).toBe('create');
    expect(plan.summary).toMatchObject({ willCreate: 2, alreadyExists: 0, blockedByErrors: 0 });
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
      cardUnitMinorUnits: 81_000_000,
      cardLineMinorUnits: 81_000_000,
      quantity: 1,
      currency: 'COP',
      differs: true,
    });
  });

  test('compares a multi-quantity row against the line total the server will commit', () => {
    const source = goodRow(2);
    // Quantity 4 at the card's 810,000.00 COP unit rate commits 3,240,000.00 COP.
    const row = { ...source, cells: [...source.cells.slice(0, 7), 4, 3_240_000, ...source.cells.slice(9)] };
    const plan = buildWorkbookPlan({ rows: [row], mapping, versionFields: fields, catalogues });
    expect(plan.rows[0]?.amountComparison).toEqual({
      workbookMinorUnits: 324_000_000,
      cardUnitMinorUnits: 81_000_000,
      cardLineMinorUnits: 324_000_000,
      quantity: 4,
      currency: 'COP',
      matches: 'line',
      differs: false,
    });
    expect(plan.summary.rateDiffers).toBe(0);
    expect(plan.summary.currencies).toEqual([
      { currency: 'COP', workbookMinorUnits: 324_000_000, cardMinorUnits: 324_000_000 },
    ]);
  });

  test('accepts a unit rate in the amount column without calling it a difference', () => {
    const source = goodRow(2);
    const row = { ...source, cells: [...source.cells.slice(0, 7), 4, 810_000, ...source.cells.slice(9)] };
    const plan = buildWorkbookPlan({ rows: [row], mapping, versionFields: fields, catalogues });
    expect(plan.rows[0]?.amountComparison?.matches).toBe('unit');
    expect(plan.rows[0]?.amountComparison?.differs).toBe(false);
    // The committed figure is still the line total, whatever the column meant.
    expect(plan.summary.currencies).toEqual([
      { currency: 'COP', workbookMinorUnits: 81_000_000, cardMinorUnits: 324_000_000 },
    ]);
  });

  test('flags a row that matches neither the unit rate nor the line total', () => {
    const source = goodRow(2);
    const row = { ...source, cells: [...source.cells.slice(0, 7), 4, 990_000, ...source.cells.slice(9)] };
    const plan = buildWorkbookPlan({ rows: [row], mapping, versionFields: fields, catalogues });
    expect(plan.rows[0]?.amountComparison?.matches).toBeUndefined();
    expect(plan.rows[0]?.amountComparison?.differs).toBe(true);
    expect(plan.summary.rateDiffers).toBe(1);
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

  test('rejects provider names that normalize to more than one catalogue entry', () => {
    const colliding: WorkbookCatalogues = {
      ...catalogues,
      providers: [
        { id: 'provider-1', name: 'Transportes Uno' },
        { id: 'provider-2', name: 'transportes uno ' },
      ],
    };
    const plan = buildWorkbookPlan({
      rows: [goodRow(2, 'Service 2', 'Transportes Uno')],
      mapping,
      versionFields: fields,
      catalogues: colliding,
    });
    expect(plan.rows[0]?.problems).toContainEqual({
      kind: 'assignment', target: 'provider', problem: 'unresolvedReference',
    });
    expect(plan.rows[0]?.defaultAction).toBe('skip');
    expect(plan.unresolvedReferences).toEqual([{ kind: 'provider', name: 'Transportes Uno', rows: [2] }]);
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

  test('does not price a disposition row from a transfer rate', () => {
    const row = goodRow(2);
    const plan = buildWorkbookPlan({
      rows: [{ ...row, cells: [...row.cells.slice(0, 6), 'disposition', ...row.cells.slice(7)] }],
      mapping,
      versionFields: fields,
      catalogues,
    });
    expect(plan.rows[0]?.problems).toEqual([]);
    expect(plan.rows[0]?.assignment).toEqual({
      create: { providerId: 'provider-1', position: 0 },
      unpricedReason: 'noRate',
    });
    expect(plan.summary.willBeUnpriced).toBe(1);
  });

  test('puts a resolved cost centre on the assignment create payload', () => {
    const mappingWithCostCentre: WorkbookMapping = [...mapping, { kind: 'costCentre' }];
    const withCostCentres: WorkbookCatalogues = {
      ...catalogues,
      costCentres: [{ id: 'cc-1', name: 'Operations' }],
    };
    const row = goodRow(2);
    const plan = buildWorkbookPlan({
      rows: [{ ...row, cells: [...row.cells, 'Operations'] }],
      mapping: mappingWithCostCentre,
      versionFields: fields,
      catalogues: withCostCentres,
    });
    expect(plan.rows[0]?.problems).toEqual([]);
    expect(plan.rows[0]?.assignment?.create).toEqual({
      providerId: 'provider-1',
      costCentreId: 'cc-1',
      position: 0,
    });
  });

  test('reports an unresolved cost centre as a row problem and an unresolved reference', () => {
    const mappingWithCostCentre: WorkbookMapping = [...mapping, { kind: 'costCentre' }];
    const row = goodRow(2);
    const plan = buildWorkbookPlan({
      rows: [{ ...row, cells: [...row.cells, 'Unknown Centre'] }],
      mapping: mappingWithCostCentre,
      versionFields: fields,
      catalogues,
    });
    expect(plan.rows[0]?.problems).toContainEqual({
      kind: 'assignment', target: 'costCentre', problem: 'unresolvedReference',
    });
    expect(plan.rows[0]?.defaultAction).toBe('skip');
    expect(plan.unresolvedReferences).toEqual([{ kind: 'costCentre', name: 'Unknown Centre', rows: [2] }]);
  });

  test('sets the service end from a valid date and time pair', () => {
    const mappingWithEnd: WorkbookMapping = [...mapping, { kind: 'endsAtDate' }, { kind: 'endsAtTime' }];
    const row = goodRow(2);
    const plan = buildWorkbookPlan({
      rows: [{ ...row, cells: [...row.cells, 46277, 0.5] }],
      mapping: mappingWithEnd,
      versionFields: fields,
      catalogues,
    });
    expect(plan.rows[0]?.problems).toEqual([]);
    expect(plan.rows[0]?.service?.endsAt).toBe(new Date(2026, 8, 12, 12, 0).getTime());
  });

  test('blocks a row whose end is before its start', () => {
    const mappingWithEnd: WorkbookMapping = [...mapping, { kind: 'endsAtDate' }, { kind: 'endsAtTime' }];
    const row = goodRow(2);
    const plan = buildWorkbookPlan({
      rows: [{ ...row, cells: [...row.cells, 46277, 0.25] }],
      mapping: mappingWithEnd,
      versionFields: fields,
      catalogues,
    });
    expect(plan.rows[0]?.problems).toContainEqual({ kind: 'endsBeforeStart' });
    expect(plan.rows[0]?.defaultAction).toBe('skip');
  });

  test('treats an empty end window as absent, not an error', () => {
    const mappingWithEnd: WorkbookMapping = [...mapping, { kind: 'endsAtDate' }, { kind: 'endsAtTime' }];
    const row = goodRow(2);
    const plan = buildWorkbookPlan({
      rows: [{ ...row, cells: [...row.cells, '', ''] }],
      mapping: mappingWithEnd,
      versionFields: fields,
      catalogues,
    });
    expect(plan.rows[0]?.problems).toEqual([]);
    expect(plan.rows[0]?.service?.endsAt).toBeUndefined();
    expect(plan.rows[0]?.defaultAction).toBe('create');
  });

  test('blocks quantity cells that are not a positive integer', () => {
    const quantities = [0, 2.5, '3 buses'] as const;
    const rows = quantities.map((quantity, index) => {
      const row = goodRow(index + 2);
      return { ...row, cells: [...row.cells.slice(0, 7), quantity, ...row.cells.slice(8)] };
    });
    const plan = buildWorkbookPlan({ rows, mapping, versionFields: fields, catalogues });
    for (const row of plan.rows) {
      expect(row.problems).toContainEqual({
        kind: 'assignment', target: 'quantity', problem: 'notPositiveInteger',
      });
      expect(row.defaultAction).toBe('skip');
    }
  });

  /*
   * `assignmentOmission` decides which absence the screen reports. A workbook with no
   * assignment columns is complete as it stands; one whose Provider cell could not be
   * matched is a repairable configuration gap. Collapsing the two tells an operator
   * their Provider column is not mapped when it is.
   */
  test('separates an assignment the workbook never mapped from one its cells blocked', () => {
    const unresolvable = { ...goodRow(2), cells: [...goodRow(2).cells] };
    unresolvable.cells[4] = 'Transportes Que No Existe';
    const blocked = buildWorkbookPlan({
      rows: [unresolvable], mapping, versionFields: fields, catalogues,
    }).rows[0];
    expect(blocked?.assignment).toBeUndefined();
    expect(blocked?.assignmentOmission).toBe('blocked');
    expect(blocked?.problems).toContainEqual({
      kind: 'assignment', target: 'provider', problem: 'unresolvedReference',
    });

    const serviceOnlyMapping: WorkbookMapping = [
      { kind: 'serviceName' },
      { kind: 'startsAtDate' },
      { kind: 'startsAtTime' },
      { kind: 'field', fieldDefinitionId: 'passengers' },
    ];
    const notMapped = buildWorkbookPlan({
      rows: [{ rowNumber: 2, cells: ['Servicio', 46277, 0.4305555555555556, 12] }],
      mapping: serviceOnlyMapping,
      versionFields: fields,
      catalogues,
    }).rows[0];
    expect(notMapped?.problems).toEqual([]);
    expect(notMapped?.assignment).toBeUndefined();
    expect(notMapped?.assignmentOmission).toBe('notMapped');
  });

  test('marks every row of an invalid mapping with the mapping problem itself', () => {
    const duplicated: WorkbookMapping = [
      { kind: 'serviceName' },
      { kind: 'serviceName' },
      { kind: 'startsAtDate' },
      { kind: 'startsAtTime' },
      { kind: 'field', fieldDefinitionId: 'passengers' },
    ];
    const plan = buildWorkbookPlan({
      rows: [{ rowNumber: 2, cells: ['Servicio', 'Servicio', 46277, 0.4305555555555556, 12] }],
      mapping: duplicated,
      versionFields: fields,
      catalogues,
    });
    expect(plan.mappingProblems).toEqual([
      { kind: 'duplicateTarget', target: 'serviceName', columns: [0, 1] },
    ]);
    // The row is otherwise clean, so this is the mapping problem and nothing else.
    expect(plan.rows[0]?.problems).toEqual([{ kind: 'mappingInvalid' }]);
    expect(plan.rows[0]?.defaultAction).toBe('skip');
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

  test('operator skips drop those rows from selected, rate, unpriced and currency figures', () => {
    const withUnpricedProvider: WorkbookCatalogues = {
      ...catalogues,
      providers: [...catalogues.providers, { id: 'provider-3', name: 'Sin Tarifa' }],
    };
    const usd = goodRow(4, 'USD service', 'Transportes Dos');
    const usdCells = [...usd.cells];
    usdCells[8] = '250';
    const blocked = goodRow(5);
    const plan = buildWorkbookPlan({
      rows: [
        goodRow(2),
        goodRow(3, 'Unpriced service', 'Sin Tarifa'),
        { ...usd, cells: usdCells },
        { ...blocked, cells: ['', ...blocked.cells.slice(1)] },
      ],
      mapping,
      versionFields: fields,
      catalogues: withUnpricedProvider,
    });
    const summary = summarizePlan(plan.rows, (row) => (
      row.rowNumber === 2 || row.rowNumber === 3 ? 'skip' : row.defaultAction
    ));
    expect(summary.selectedForCreation).toBe(1);
    expect(summary.rateDiffers).toBe(0);
    expect(summary.willBeUnpriced).toBe(0);
    expect(summary.currencies).toEqual([
      { currency: 'USD', workbookMinorUnits: 25_000, cardMinorUnits: 25_000 },
    ]);
  });
});
