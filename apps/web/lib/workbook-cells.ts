import type { fieldConfigValidator } from '@priamo/convex/validators';

import { isValidDateInput, isValidTimeInput } from '@/i18n/formats';
import { serviceFieldProblem } from '@/lib/service-form-checks';
import { timestampFromParts } from '@/lib/timestamps';

import { toServiceFieldValue, type FieldValueFormState } from './field-value-form';

export type WorkbookCell = string | number | boolean | Date | null;
export type FieldConfig = typeof fieldConfigValidator.type;

export type CellProblem =
  | 'empty'
  | 'notText'
  | 'notANumber'
  | 'notAnInteger'
  | 'notADate'
  | 'notATime'
  | 'ambiguousDate'
  | 'unknownOption'
  | 'unresolvedLocation'
  | 'notBoolean';

type LocationId = Extract<
  ReturnType<typeof toServiceFieldValue>,
  { kind: 'location' }
>['locationId'];

export type NamedCatalogueItem<Id extends string = string> = { id: Id; name: string };
export type LocationCatalogueItem = NamedCatalogueItem<LocationId>;
export type CellConversionContext = {
  locations?: readonly LocationCatalogueItem[];
  required?: boolean;
  hasDefault?: boolean;
};

export type CellValueResult =
  | { ok: true; value: FieldValueFormState }
  | { ok: false; problem: CellProblem };

const millisecondsPerDay = 86_400_000;

export function excelSerialToDateString(serial: number): string | undefined {
  // Excel's fictitious 1900-02-29 makes every serial through 60 ambiguous.
  if (!Number.isFinite(serial) || !Number.isInteger(serial) || serial <= 60) return undefined;
  const milliseconds = Date.UTC(1899, 11, 31) + (serial - 1) * millisecondsPerDay;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return undefined;
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function excelFractionToTimeString(fraction: number): string | undefined {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) return undefined;
  const minutes = Math.round(fraction * 24 * 60);
  if (minutes >= 24 * 60) return undefined;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The only label normalization used by workbook imports; it is deliberately not fuzzy. */
export function normalizeWorkbookLabel(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function isEmpty(cell: WorkbookCell): boolean {
  return cell === null || (typeof cell === 'string' && cell.trim() === '');
}

function dateStringFromCell(cell: WorkbookCell): string | CellProblem {
  if (cell instanceof Date) {
    if (!Number.isFinite(cell.getTime())) return 'notADate';
    return `${String(cell.getUTCFullYear()).padStart(4, '0')}-${String(cell.getUTCMonth() + 1).padStart(2, '0')}-${String(cell.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof cell === 'number') {
    if (cell <= 60 && Number.isInteger(cell) && cell >= 0) return 'ambiguousDate';
    return excelSerialToDateString(cell) ?? 'notADate';
  }
  if (typeof cell !== 'string') return 'notADate';
  const value = cell.trim();
  if (isValidDateInput(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return 'notADate';
  if (/^\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}$/u.test(value)) return 'ambiguousDate';
  return 'notADate';
}

function timeStringFromCell(cell: WorkbookCell): string | CellProblem {
  if (cell instanceof Date) {
    if (!Number.isFinite(cell.getTime())) return 'notATime';
    const fraction =
      (cell.getUTCHours() * 60 + cell.getUTCMinutes() + cell.getUTCSeconds() / 60 + cell.getUTCMilliseconds() / 60_000) /
      (24 * 60);
    return excelFractionToTimeString(fraction) ?? 'notATime';
  }
  if (typeof cell === 'number') return excelFractionToTimeString(cell) ?? 'notATime';
  if (typeof cell !== 'string') return 'notATime';
  const value = cell.trim();
  return isValidTimeInput(value) ? value : 'notATime';
}

function datetimeState(cell: WorkbookCell): FieldValueFormState | CellProblem {
  if (cell instanceof Date) {
    const date = dateStringFromCell(cell);
    if (typeof date !== 'string' || date === 'notADate' || date === 'ambiguousDate') return date;
    const time = timeStringFromCell(cell);
    if (typeof time !== 'string' || time === 'notATime') return time;
    return { kind: 'datetime', date, time };
  }
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell) || cell <= 60) return Number.isInteger(cell) && cell >= 0 ? 'ambiguousDate' : 'notADate';
    const day = Math.floor(cell);
    const date = excelSerialToDateString(day);
    if (date === undefined) return 'notADate';
    const time = excelFractionToTimeString(cell - day);
    return time === undefined ? 'notATime' : { kind: 'datetime', date, time };
  }
  if (typeof cell !== 'string') return 'notADate';
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/u.exec(cell.trim());
  if (match === null) {
    return /^\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}/u.test(cell.trim()) ? 'ambiguousDate' : 'notADate';
  }
  const date = match[1];
  const time = match[2];
  if (date === undefined || !isValidDateInput(date)) return 'notADate';
  if (time === undefined || !isValidTimeInput(time)) return 'notATime';
  return { kind: 'datetime', date, time };
}

function exactOptionId(
  label: string,
  options: readonly { id: string; label: string }[],
): string | undefined {
  const normalized = normalizeWorkbookLabel(label);
  const matches = options.filter((option) => normalizeWorkbookLabel(option.label) === normalized);
  return matches.length === 1 ? matches[0]?.id : undefined;
}

function unambiguousNumber(cell: WorkbookCell): number | undefined {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  if (typeof cell !== 'string') return undefined;
  const value = cell.trim();
  // Three trailing digits after a dot are indistinguishable from locale grouping (810.000).
  if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value) || /^[-+]?\d{1,3}\.\d{3}$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rawState(
  cell: WorkbookCell,
  config: FieldConfig,
  context: CellConversionContext,
): FieldValueFormState | CellProblem {
  switch (config.kind) {
    case 'text':
    case 'longText':
      return typeof cell === 'string' ? { kind: config.kind, value: cell.trim() } : 'notText';
    case 'number': {
      const value = unambiguousNumber(cell);
      if (value === undefined) return 'notANumber';
      if (config.integer === true && !Number.isInteger(value)) return 'notAnInteger';
      return { kind: 'number', value: String(value) };
    }
    case 'boolean':
      return typeof cell === 'boolean' ? { kind: 'boolean', value: cell } : 'notBoolean';
    case 'date': {
      const value = dateStringFromCell(cell);
      return value === 'notADate' || value === 'ambiguousDate' ? value : { kind: 'date', value };
    }
    case 'time': {
      const value = timeStringFromCell(cell);
      return value === 'notATime' ? value : { kind: 'time', value };
    }
    case 'datetime':
      return datetimeState(cell);
    case 'select': {
      if (typeof cell !== 'string') return 'unknownOption';
      const optionId = exactOptionId(cell, config.options);
      return optionId === undefined ? 'unknownOption' : { kind: 'select', optionId };
    }
    case 'multiSelect': {
      if (typeof cell !== 'string') return 'unknownOption';
      const optionId = exactOptionId(cell, config.options);
      return optionId === undefined ? 'unknownOption' : { kind: 'multiSelect', optionIds: [optionId] };
    }
    case 'location': {
      if (typeof cell !== 'string') return 'unresolvedLocation';
      const normalized = normalizeWorkbookLabel(cell);
      const matches = (context.locations ?? []).filter((location) => normalizeWorkbookLabel(location.name) === normalized);
      const match = matches.length === 1 ? matches[0] : undefined;
      return match === undefined ? 'unresolvedLocation' : { kind: 'location', locationId: match.id };
    }
  }
}

function problemForKind(config: FieldConfig): CellProblem {
  switch (config.kind) {
    case 'text':
    case 'longText':
      return 'notText';
    case 'number':
      return config.integer === true ? 'notAnInteger' : 'notANumber';
    case 'boolean':
      return 'notBoolean';
    case 'date':
    case 'datetime':
      return 'notADate';
    case 'time':
      return 'notATime';
    case 'select':
    case 'multiSelect':
      return 'unknownOption';
    case 'location':
      return 'unresolvedLocation';
  }
}

export function cellToFieldValue(
  cell: WorkbookCell,
  config: FieldConfig,
  context: CellConversionContext = {},
): CellValueResult {
  if (isEmpty(cell)) return { ok: false, problem: 'empty' };
  const state = rawState(cell, config, context);
  if (typeof state === 'string') return { ok: false, problem: state };
  const persisted = toServiceFieldValue(state);
  const problem = serviceFieldProblem(config, persisted, context.required ?? false, context.hasDefault ?? false);
  return problem === undefined ? { ok: true, value: state } : { ok: false, problem: problemForKind(config) };
}

/**
 * Composes in the browser's local zone, matching every other console write path.
 * The preview screen must show the resulting instant with its zone label so that
 * this environment assumption is visible to the operator rather than silent.
 */
export function composeInstant(dateCell: WorkbookCell, timeCell: WorkbookCell): number | CellProblem {
  if (isEmpty(dateCell) || isEmpty(timeCell)) return 'empty';
  const date = dateStringFromCell(dateCell);
  if (date === 'notADate' || date === 'ambiguousDate') return date;
  const time = timeStringFromCell(timeCell);
  if (time === 'notATime') return time;
  return timestampFromParts({ date, time }) ?? 'notATime';
}
