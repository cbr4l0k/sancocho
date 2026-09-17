import type { currencyValidator, rateModalityValidator } from '@priamo/convex/validators';

import { addMinorUnits, parseMoneyInput } from './money';
import { serviceFieldProblem } from './service-form-checks';
import {
  cellToFieldValue,
  composeInstant,
  normalizeWorkbookLabel,
  type CellProblem,
  type LocationCatalogueItem,
  type NamedCatalogueItem,
  type WorkbookCell,
} from './workbook-cells';
import {
  mappingProblems,
  type ColumnTarget,
  type MappingProblem,
  type VersionField,
  type WorkbookMapping,
} from './workbook-mapping';
import { toServiceFieldValue, type ServiceFieldValue } from './field-value-form';

export type RateModality = typeof rateModalityValidator.type;
export type Currency = typeof currencyValidator.type;

const rateModalityMembers = {
  transfer: true,
  disposition: true,
  route: true,
  fixed: true,
} as const satisfies Record<RateModality, true>;

export type WorkbookRow = { rowNumber: number; cells: readonly WorkbookCell[] };
export type ExistingService = { id: string; name: string; startsAt: number };
export type ResolvedRate = {
  providerId: string;
  vehicleClassId: string;
  modality: RateModality;
  rateCardVersionId: string;
  rateLineId: string;
  unitAmount: number;
  currency: Currency;
};

export type WorkbookCatalogues = {
  locations: readonly LocationCatalogueItem[];
  providers: readonly NamedCatalogueItem[];
  vehicleClasses: readonly NamedCatalogueItem[];
  costCentres: readonly NamedCatalogueItem[];
  existingServices: readonly ExistingService[];
  rates: readonly ResolvedRate[];
};

export type PlannedService = {
  name: string;
  startsAt: number;
  endsAt?: number;
  values: readonly { fieldDefinitionId: string; value: ServiceFieldValue }[];
};

export type PlannedAssignment = {
  create: { providerId: string; costCentreId?: string; position: number };
  revision?: {
    vehicleClassId: string;
    modality: RateModality;
    quantity: number;
    rateCardVersionId: string;
    rateLineId: string;
  };
  unpricedReason?: 'noRate';
};

export type AmountComparison = {
  workbookMinorUnits: number;
  cardMinorUnits?: number;
  currency?: Currency;
  differs: boolean;
};

export type ReferenceKind = 'location' | 'provider' | 'vehicleClass' | 'costCentre';
export type RowUnresolvedReference = { kind: ReferenceKind; name: string };
export type RowUnresolvedOption = { fieldDefinitionId: string; label: string };
export type UnresolvedReference = RowUnresolvedReference & { rows: readonly number[] };
export type UnresolvedOption = RowUnresolvedOption & { rows: readonly number[] };

export type RowProblem =
  | { kind: 'mappingInvalid' }
  | { kind: 'missingServiceName' }
  | { kind: 'startsAt'; problem: CellProblem }
  | { kind: 'endsAt'; problem: CellProblem }
  | { kind: 'endsBeforeStart' }
  | { kind: 'field'; fieldDefinitionId: string; problem: CellProblem }
  | { kind: 'unknownField'; fieldDefinitionId: string }
  | { kind: 'assignment'; target: 'provider' | 'vehicleClass' | 'modality' | 'quantity' | 'costCentre'; problem: string }
  | { kind: 'workbookAmount'; problem: string };

export type PlannedRow = {
  rowNumber: number;
  service?: PlannedService;
  assignment?: PlannedAssignment;
  assignmentOmission?: 'notMapped' | 'blocked';
  problems: readonly RowProblem[];
  unresolvedReferences: readonly RowUnresolvedReference[];
  unresolvedOptions: readonly RowUnresolvedOption[];
  existingServiceId?: string;
  defaultAction: 'create' | 'skip';
  amountComparison?: AmountComparison;
  rateLookup?: Pick<ResolvedRate, 'providerId' | 'vehicleClassId' | 'modality'> & { quantity: number };
};

export type CurrencyPlanFigure = {
  currency: Currency;
  workbookMinorUnits: number;
  cardMinorUnits: number;
};

export type PlanSummary = {
  willCreate: number;
  alreadyExists: number;
  blockedByErrors: number;
  rateDiffers: number;
  willBeUnpriced: number;
  currencies: readonly CurrencyPlanFigure[];
};

export type WorkbookPlan = {
  rows: readonly PlannedRow[];
  mappingProblems: readonly MappingProblem[];
  unresolvedReferences: readonly UnresolvedReference[];
  unresolvedOptions: readonly UnresolvedOption[];
  summary: PlanSummary;
};

function targetCell(row: WorkbookRow, mapping: WorkbookMapping, kind: ColumnTarget['kind']): WorkbookCell | undefined {
  const column = mapping.findIndex((target) => target.kind === kind);
  return column < 0 ? undefined : row.cells[column];
}

function fieldCell(row: WorkbookRow, mapping: WorkbookMapping, fieldDefinitionId: string): WorkbookCell | undefined {
  const column = mapping.findIndex(
    (target) => target.kind === 'field' && target.fieldDefinitionId === fieldDefinitionId,
  );
  return column < 0 ? undefined : row.cells[column];
}

function displayText(cell: WorkbookCell | undefined): string | undefined {
  return typeof cell === 'string' && cell.trim() !== '' ? cell.trim() : undefined;
}

function exactCatalogueMatch(cell: WorkbookCell | undefined, items: readonly NamedCatalogueItem[]): NamedCatalogueItem | undefined {
  const text = displayText(cell);
  if (text === undefined) return undefined;
  const normalized = normalizeWorkbookLabel(text);
  const matches = items.filter((item) => normalizeWorkbookLabel(item.name) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function isRateModality(value: string): value is RateModality {
  return Object.hasOwn(rateModalityMembers, value);
}

function readModality(cell: WorkbookCell | undefined): RateModality | undefined {
  if (typeof cell !== 'string') return undefined;
  const value = cell.trim();
  return isRateModality(value) ? value : undefined;
}

function readQuantity(cell: WorkbookCell | undefined): number | undefined {
  if (typeof cell === 'number') return Number.isSafeInteger(cell) && cell > 0 ? cell : undefined;
  if (typeof cell !== 'string' || !/^\d+$/u.test(cell.trim())) return undefined;
  const value = Number(cell.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function addUnresolved(
  rows: RowUnresolvedReference[],
  kind: ReferenceKind,
  cell: WorkbookCell | undefined,
): void {
  const name = displayText(cell);
  if (name !== undefined) rows.push({ kind, name });
}

function aggregateReferences(rows: readonly PlannedRow[]): readonly UnresolvedReference[] {
  const aggregated = new Map<string, { kind: ReferenceKind; name: string; rows: number[] }>();
  for (const row of rows) {
    for (const reference of row.unresolvedReferences) {
      const key = `${reference.kind}\u0000${normalizeWorkbookLabel(reference.name)}`;
      const item = aggregated.get(key) ?? { ...reference, rows: [] };
      item.rows.push(row.rowNumber);
      aggregated.set(key, item);
    }
  }
  return [...aggregated.values()];
}

function aggregateOptions(rows: readonly PlannedRow[]): readonly UnresolvedOption[] {
  const aggregated = new Map<string, { fieldDefinitionId: string; label: string; rows: number[] }>();
  for (const row of rows) {
    for (const option of row.unresolvedOptions) {
      const key = `${option.fieldDefinitionId}\u0000${normalizeWorkbookLabel(option.label)}`;
      const item = aggregated.get(key) ?? { ...option, rows: [] };
      item.rows.push(row.rowNumber);
      aggregated.set(key, item);
    }
  }
  return [...aggregated.values()];
}

function buildRow(
  row: WorkbookRow,
  mapping: WorkbookMapping,
  fields: readonly VersionField[],
  catalogues: WorkbookCatalogues,
  invalidMapping: boolean,
): PlannedRow {
  const problems: RowProblem[] = invalidMapping ? [{ kind: 'mappingInvalid' }] : [];
  const unresolvedReferences: RowUnresolvedReference[] = [];
  const unresolvedOptions: RowUnresolvedOption[] = [];
  const name = displayText(targetCell(row, mapping, 'serviceName'));
  if (name === undefined) problems.push({ kind: 'missingServiceName' });

  const startsAtResult = composeInstant(
    targetCell(row, mapping, 'startsAtDate') ?? null,
    targetCell(row, mapping, 'startsAtTime') ?? null,
  );
  if (typeof startsAtResult !== 'number') problems.push({ kind: 'startsAt', problem: startsAtResult });

  let endsAt: number | undefined;
  const endDate = targetCell(row, mapping, 'endsAtDate');
  const endTime = targetCell(row, mapping, 'endsAtTime');
  if (endDate !== undefined || endTime !== undefined) {
    const bothEmpty = (endDate === null || endDate === '' || endDate === undefined) &&
      (endTime === null || endTime === '' || endTime === undefined);
    if (!bothEmpty) {
      const result = composeInstant(endDate ?? null, endTime ?? null);
      if (typeof result === 'number') endsAt = result;
      else problems.push({ kind: 'endsAt', problem: result });
    }
  }
  if (typeof startsAtResult === 'number' && endsAt !== undefined && endsAt < startsAtResult) {
    problems.push({ kind: 'endsBeforeStart' });
  }

  const values: { fieldDefinitionId: string; value: ServiceFieldValue }[] = [];
  for (const target of mapping) {
    if (target.kind !== 'field') continue;
    const field = fields.find((candidate) => candidate.fieldDefinitionId === target.fieldDefinitionId);
    if (field === undefined) {
      problems.push({ kind: 'unknownField', fieldDefinitionId: target.fieldDefinitionId });
      continue;
    }
    const cell = fieldCell(row, mapping, field.fieldDefinitionId) ?? null;
    const result = cellToFieldValue(cell, field.config, {
      locations: catalogues.locations,
      required: field.required,
      hasDefault: field.defaultValue !== undefined || field.defaultLocationId !== undefined,
    });
    if (!result.ok) {
      if (result.problem === 'empty' && (!field.required || field.defaultValue !== undefined || field.defaultLocationId !== undefined)) {
        continue;
      }
      problems.push({ kind: 'field', fieldDefinitionId: field.fieldDefinitionId, problem: result.problem });
      if (result.problem === 'unknownOption') {
        unresolvedOptions.push({ fieldDefinitionId: field.fieldDefinitionId, label: displayText(cell) ?? '' });
      }
      if (result.problem === 'unresolvedLocation') addUnresolved(unresolvedReferences, 'location', cell);
      continue;
    }
    const value = toServiceFieldValue(result.value);
    if (value === undefined || serviceFieldProblem(field.config, value, field.required, false) !== undefined) {
      problems.push({ kind: 'field', fieldDefinitionId: field.fieldDefinitionId, problem: 'empty' });
      continue;
    }
    values.push({ fieldDefinitionId: field.fieldDefinitionId, value });
  }

  const hasAssignment = mapping.some((target) => target.kind === 'provider');
  let assignment: PlannedAssignment | undefined;
  let amountComparison: AmountComparison | undefined;
  let rateLookup: PlannedRow['rateLookup'];
  if (hasAssignment) {
    const providerCell = targetCell(row, mapping, 'provider');
    const classCell = targetCell(row, mapping, 'vehicleClass');
    const costCentreCell = targetCell(row, mapping, 'costCentre');
    const provider = exactCatalogueMatch(providerCell, catalogues.providers);
    const vehicleClass = exactCatalogueMatch(classCell, catalogues.vehicleClasses);
    const costCentre = costCentreCell === undefined || costCentreCell === null || costCentreCell === ''
      ? undefined
      : exactCatalogueMatch(costCentreCell, catalogues.costCentres);
    const modality = readModality(targetCell(row, mapping, 'modality'));
    const quantity = readQuantity(targetCell(row, mapping, 'quantity'));
    const amountCell = targetCell(row, mapping, 'workbookAmount');
    let workbookMinorUnits: number | undefined;
    if (amountCell !== undefined && amountCell !== null && amountCell !== '') {
      const text = typeof amountCell === 'number' && Number.isFinite(amountCell) ? String(amountCell) :
        typeof amountCell === 'string' ? amountCell : '';
      const parsed = parseMoneyInput(text);
      if (!parsed.ok) problems.push({ kind: 'workbookAmount', problem: parsed.problem });
      else workbookMinorUnits = parsed.minorUnits;
    }
    if (provider === undefined) {
      problems.push({ kind: 'assignment', target: 'provider', problem: 'unresolvedReference' });
      addUnresolved(unresolvedReferences, 'provider', providerCell);
    }
    if (vehicleClass === undefined) {
      problems.push({ kind: 'assignment', target: 'vehicleClass', problem: 'unresolvedReference' });
      addUnresolved(unresolvedReferences, 'vehicleClass', classCell);
    }
    if (costCentreCell !== undefined && costCentreCell !== null && costCentreCell !== '' && costCentre === undefined) {
      problems.push({ kind: 'assignment', target: 'costCentre', problem: 'unresolvedReference' });
      addUnresolved(unresolvedReferences, 'costCentre', costCentreCell);
    }
    if (modality === undefined) problems.push({ kind: 'assignment', target: 'modality', problem: 'unknownModality' });
    if (quantity === undefined) problems.push({ kind: 'assignment', target: 'quantity', problem: 'notPositiveInteger' });

    if (provider !== undefined && vehicleClass !== undefined && modality !== undefined && quantity !== undefined) {
      rateLookup = { providerId: provider.id, vehicleClassId: vehicleClass.id, modality, quantity };
      const rate = catalogues.rates.find(
        (candidate) => candidate.providerId === provider.id &&
          candidate.vehicleClassId === vehicleClass.id && candidate.modality === modality,
      );
      const create = costCentre === undefined
        ? { providerId: provider.id, position: 0 }
        : { providerId: provider.id, costCentreId: costCentre.id, position: 0 };
      assignment = rate === undefined
        ? { create, unpricedReason: 'noRate' }
        : {
            create,
            revision: {
              vehicleClassId: vehicleClass.id,
              modality,
              quantity,
              rateCardVersionId: rate.rateCardVersionId,
              rateLineId: rate.rateLineId,
            },
          };

      if (workbookMinorUnits !== undefined) {
        amountComparison = rate === undefined
          ? { workbookMinorUnits, differs: false }
          : {
              workbookMinorUnits,
              cardMinorUnits: rate.unitAmount,
              currency: rate.currency,
              differs: workbookMinorUnits !== rate.unitAmount,
            };
      }
    }
  }

  const service = name !== undefined && typeof startsAtResult === 'number'
    ? { name, startsAt: startsAtResult, ...(endsAt === undefined ? {} : { endsAt }), values }
    : undefined;
  const existing = service === undefined ? undefined : catalogues.existingServices.find(
    (candidate) => candidate.name === service.name && candidate.startsAt === service.startsAt,
  );
  const blocked = problems.length > 0;
  return {
    rowNumber: row.rowNumber,
    ...(service === undefined ? {} : { service }),
    ...(assignment === undefined ? { assignmentOmission: hasAssignment ? 'blocked' as const : 'notMapped' as const } : { assignment }),
    problems,
    unresolvedReferences,
    unresolvedOptions,
    ...(existing === undefined ? {} : { existingServiceId: existing.id }),
    defaultAction: blocked || existing !== undefined ? 'skip' : 'create',
    ...(amountComparison === undefined ? {} : { amountComparison }),
    ...(rateLookup === undefined ? {} : { rateLookup }),
  };
}

export function summarizePlan(rows: readonly PlannedRow[]): PlanSummary {
  let willCreate = 0;
  let alreadyExists = 0;
  let blockedByErrors = 0;
  let rateDiffers = 0;
  let willBeUnpriced = 0;
  const currencies = new Map<Currency, { workbookMinorUnits: number; cardMinorUnits: number }>();
  for (const row of rows) {
    if (row.problems.length > 0) blockedByErrors += 1;
    else if (row.existingServiceId !== undefined) alreadyExists += 1;
    else willCreate += 1;
    if (row.defaultAction === 'create' && row.amountComparison?.differs === true) rateDiffers += 1;
    if (row.defaultAction === 'create' && row.assignment?.unpricedReason !== undefined) willBeUnpriced += 1;
    const comparison = row.amountComparison;
    if (row.defaultAction !== 'create' || comparison?.currency === undefined || comparison.cardMinorUnits === undefined) continue;
    const previous = currencies.get(comparison.currency) ?? { workbookMinorUnits: 0, cardMinorUnits: 0 };
    currencies.set(comparison.currency, {
      workbookMinorUnits: addMinorUnits(previous.workbookMinorUnits, comparison.workbookMinorUnits),
      cardMinorUnits: addMinorUnits(previous.cardMinorUnits, comparison.cardMinorUnits),
    });
  }
  return {
    willCreate,
    alreadyExists,
    blockedByErrors,
    rateDiffers,
    willBeUnpriced,
    currencies: [...currencies].map(([currency, amounts]) => ({ currency, ...amounts })),
  };
}

export function buildWorkbookPlan(input: {
  rows: readonly WorkbookRow[];
  mapping: WorkbookMapping;
  versionFields: readonly VersionField[];
  catalogues: WorkbookCatalogues;
}): WorkbookPlan {
  const problems = mappingProblems(input.mapping, input.versionFields);
  const rows = input.rows.map((row) => buildRow(
    row,
    input.mapping,
    input.versionFields,
    input.catalogues,
    problems.length > 0,
  ));
  return {
    rows,
    mappingProblems: problems,
    unresolvedReferences: aggregateReferences(rows),
    unresolvedOptions: aggregateOptions(rows),
    summary: summarizePlan(rows),
  };
}
