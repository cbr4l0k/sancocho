import type { fieldConfigValidator, serviceFieldValueValidator } from '@priamo/convex/validators';

import { fieldValueCell, type ExportCell } from './export-cells';
import type { ServiceFieldColumn } from './service-columns';

type FieldConfig = typeof fieldConfigValidator.type;
type ServiceFieldValue = typeof serviceFieldValueValidator.type;

/**
 * One row's field entries, as `listOrganizationServices` returns them: the version's
 * immutable `config` snapshot, the value when the Service holds one, and the location
 * name the query already joined.
 */
export type ServiceFieldSource = {
  readonly key: string;
  readonly config: FieldConfig;
  readonly value?: ServiceFieldValue;
  readonly locationName?: string;
};

/**
 * Headers for the union columns `service-columns.ts` builds.
 *
 * Normally the field's label, which is what the screen shows. When two columns carry the
 * SAME label — two different Field Definitions whose tenant-authored labels happen to
 * collide — both get their key appended, so neither header pretends to identify a column
 * on its own. The table can leave the duplicates alone because a reader sees the data
 * under them; a spreadsheet column is sorted, filtered and referenced by its header.
 *
 * Both are disambiguated, not just the second: marking only the later one would make the
 * first look like the canonical column and the other like a variant of it.
 */
export function exportFieldHeaders(columns: readonly ServiceFieldColumn[]): string[] {
  const counts = new Map<string, number>();
  for (const column of columns) counts.set(column.label, (counts.get(column.label) ?? 0) + 1);
  return columns.map((column) =>
    (counts.get(column.label) ?? 0) > 1 ? `${column.label} (${column.key})` : column.label,
  );
}

/**
 * One cell per union column, in column order.
 *
 * A column this row's Service Kind Version does not compose and a field it composes but
 * holds no value for both produce an empty cell. The distinction is real but a flat sheet
 * cannot carry it, and inventing a sentinel for one of them would corrupt the column's
 * type for every other row.
 */
export function serviceFieldCells(
  fields: readonly ServiceFieldSource[],
  columns: readonly ServiceFieldColumn[],
): ExportCell[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return columns.map((column) => {
    const field = byKey.get(column.key);
    if (field === undefined || field.value === undefined) return { kind: 'empty' };
    return fieldValueCell(field.value, field.config, field.locationName);
  });
}
