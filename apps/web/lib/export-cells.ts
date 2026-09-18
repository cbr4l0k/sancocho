import type { currencyValidator, fieldConfigValidator, serviceFieldValueValidator } from '@priamo/convex/validators';
import type { Cell } from 'write-excel-file/browser';

import { isValidDateInput, isValidTimeInput } from '@/i18n/formats';

import { MONEY_EXPONENT } from './money';

type Currency = typeof currencyValidator.type;
type FieldConfig = typeof fieldConfigValidator.type;
type ServiceFieldValue = typeof serviceFieldValueValidator.type;

/**
 * The export's own cell vocabulary, deliberately narrower than the xlsx library's.
 *
 * `write-excel-file` accepts `{ type, value }` with no relationship enforced between the
 * two, so a `Date` handed a `Number` type compiles. Everything the export decides is
 * expressed in this union instead, and `toSheetCell` is the single place it becomes the
 * library's loose shape — which also keeps every rule below testable without generating
 * a file.
 */
export type ExportCell =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number; readonly format?: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'date'; readonly value: Date; readonly format: string };

const empty: ExportCell = { kind: 'empty' };

export const dateFormat = 'yyyy-mm-dd';
export const datetimeFormat = 'yyyy-mm-dd hh:mm';
export const timeFormat = 'hh:mm';

const minutesPerDay = 24 * 60;
const millisecondsPerMinute = 60_000;

/**
 * One format per currency, so a sheet holding two of them shows two visibly different
 * columns of numbers rather than one ambiguous one. Exhaustive over the backend union:
 * a new currency is a `tsc` failure here, not an unformatted amount in a file.
 *
 * The code is a literal inside the format rather than a locale currency symbol —
 * `docs/rates.md` has no conversion and no symbol table, and `$` means four different
 * things across the four currencies.
 */
export const moneyFormats = {
  COP: '"COP" #,##0.00',
  USD: '"USD" #,##0.00',
  EUR: '"EUR" #,##0.00',
  MXN: '"MXN" #,##0.00',
} as const satisfies Record<Currency, string>;

/**
 * A calendar date becomes a `Date` at UTC midnight.
 *
 * `write-excel-file` converts a Date to an Excel serial as
 * `date.getTime() / 86400000 + 25569`, with no local-zone adjustment at all. A Date built
 * at LOCAL midnight therefore lands on a fractional serial offset by the zone, and west of
 * UTC that displays as the previous day. This is the exact mirror of the import's
 * `excelSerialToDateString`, which reads a serial back with the UTC getters.
 */
export function dateCell(value: string): ExportCell {
  if (!isValidDateInput(value)) return empty;
  const utc = Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return { kind: 'date', value: new Date(utc), format: dateFormat };
}

/**
 * An absolute instant becomes the LOCAL wall clock the console displays.
 *
 * A spreadsheet cell carries no zone, so there is no way to write "15:20 UTC" and have it
 * mean anything to the operator; what they recognise is the 10:20 the screen showed them.
 * Since the library's conversion is UTC, the offset has to come off the instant before it,
 * which makes this the inverse of the import's `composeInstant`.
 */
export function instantCell(milliseconds: number): ExportCell {
  if (!Number.isFinite(milliseconds)) return empty;
  const offset = new Date(milliseconds).getTimezoneOffset() * millisecondsPerMinute;
  return { kind: 'date', value: new Date(milliseconds - offset), format: datetimeFormat };
}

/** A wall-clock `HH:mm` becomes a real Excel time: the fraction of a day, formatted as one. */
export function timeCell(value: string): ExportCell {
  if (!isValidTimeInput(value)) return empty;
  const minutes = Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  return { kind: 'number', value: minutes / minutesPerDay, format: timeFormat };
}

/**
 * Integer minor units become a major-unit NUMBER, never pre-formatted text. The format
 * string controls what is displayed; the stored value stays exact.
 */
export function moneyCell(minorUnits: number, currency: Currency): ExportCell {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) return empty;
  return { kind: 'number', value: minorUnits / 10 ** MONEY_EXPONENT, format: moneyFormats[currency] };
}

/**
 * Resolves an option id against the version's IMMUTABLE config snapshot, not the live
 * field definition, so renaming an option today cannot rewrite what a past Service says
 * (I3). An id the snapshot does not know yields nothing rather than the raw id.
 */
function optionLabel(config: FieldConfig, optionId: string): string | undefined {
  if (config.kind !== 'select' && config.kind !== 'multiSelect') return undefined;
  return config.options.find((option) => option.id === optionId)?.label;
}

/** One stored Service field value as a typed cell, exhaustively over the stored union. */
export function fieldValueCell(
  value: ServiceFieldValue,
  config: FieldConfig,
  locationName?: string,
): ExportCell {
  switch (value.kind) {
    case 'text':
    case 'longText':
      return { kind: 'text', value: value.value };
    case 'number':
      return { kind: 'number', value: value.value };
    case 'boolean':
      return { kind: 'boolean', value: value.value };
    case 'date':
      return dateCell(value.value);
    case 'datetime':
      return instantCell(value.value);
    case 'time':
      return timeCell(value.value);
    case 'select': {
      const label = optionLabel(config, value.optionId);
      return label === undefined ? empty : { kind: 'text', value: label };
    }
    case 'multiSelect': {
      // One cell, because a column cannot vary in width per row. Stored order is kept:
      // it is the order the operator chose, and re-sorting it here would invent meaning.
      const labels = value.optionIds
        .map((optionId) => optionLabel(config, optionId))
        .filter((label) => label !== undefined);
      return labels.length === 0 ? empty : { kind: 'text', value: labels.join('; ') };
    }
    case 'location':
      // The caller resolves the name from the Locations it already walked; an id it could
      // not resolve is an empty cell, never a Convex id in a spreadsheet.
      return locationName === undefined ? empty : { kind: 'text', value: locationName };
  }
}

/** The one adapter into the xlsx library's shape. An empty cell is a blank, not `''`. */
export function toSheetCell(cell: ExportCell): Cell {
  switch (cell.kind) {
    case 'empty':
      return null;
    case 'text':
      return { type: String, value: cell.value };
    case 'boolean':
      return { type: Boolean, value: cell.value };
    case 'number':
      return cell.format === undefined
        ? { type: Number, value: cell.value }
        : { type: Number, value: cell.value, format: cell.format };
    case 'date':
      return { type: Date, value: cell.value, format: cell.format };
  }
}
