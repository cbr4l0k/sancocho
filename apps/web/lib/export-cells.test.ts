import { describe, expect, test } from 'bun:test';

import {
  dateCell,
  dateFormat,
  datetimeFormat,
  fieldValueCell,
  instantCell,
  moneyCell,
  moneyFormats,
  timeCell,
  timeFormat,
  toSheetCell,
} from './export-cells';
import { composeInstant, excelFractionToTimeString, excelSerialToDateString } from './workbook-cells';

/*
 * These tests run under TZ=America/Bogota (UTC-5), pinned in apps/web/test-setup.ts and
 * preloaded from bunfig.toml. It is the whole point of the date tests below rather than a
 * detail: `write-excel-file` converts a Date to a serial as `getTime() / 86400000 + 25569`
 * with no zone adjustment, so under a UTC runner building the Date at local midnight and
 * at UTC midnight produce identical cells and every assertion here passes either way.
 * Only a non-zero offset can tell the two apart — and a date shifted a day back is exactly
 * the bug a Colombian operator would find in their file.
 */

/** The serial `write-excel-file` will compute for a cell, so the assertions are about the file. */
function serialOf(value: Date): number {
  return value.getTime() / 86_400_000 + 25_569;
}

describe('date and time cells', () => {
  test('writes a calendar date at UTC midnight, giving the workbook serial 46277', () => {
    const cell = dateCell('2026-09-12');
    expect(cell).toEqual({ kind: 'date', value: new Date(Date.UTC(2026, 8, 12)), format: 'yyyy-mm-dd' });
    expect(cell.kind === 'date' ? serialOf(cell.value) : undefined).toBe(46277);
    expect(dateFormat).toBe('yyyy-mm-dd');
  });

  test('round-trips the import: the serial it writes is the serial the import reads back', () => {
    // One shared anchor, so the export and the import cannot drift apart while each stays
    // internally consistent. 46277 is `workbook-cells.test.ts`'s literal too.
    expect(excelSerialToDateString(46277)).toBe('2026-09-12');
  });

  test('refuses a date it cannot represent rather than guessing', () => {
    expect(dateCell('2026-13-45')).toEqual({ kind: 'empty' });
    expect(dateCell('2026-02-30')).toEqual({ kind: 'empty' });
    expect(dateCell('12/09/2026')).toEqual({ kind: 'empty' });
    expect(dateCell('')).toEqual({ kind: 'empty' });
  });

  test('writes an instant as the local wall clock the console displays', () => {
    const instant = new Date(2026, 8, 12, 10, 20).getTime();
    const cell = instantCell(instant);
    // 10:20 in Bogota is 15:20 UTC. Without the offset shift the cell would read 15:20,
    // and the operator would find every departure five hours late.
    expect(cell).toEqual({
      kind: 'date',
      value: new Date(Date.UTC(2026, 8, 12, 10, 20)),
      format: 'yyyy-mm-dd hh:mm',
    });
    expect(datetimeFormat).toBe('yyyy-mm-dd hh:mm');
  });

  test('agrees with the instant the import composes from the same pair', () => {
    // The import composes a serial and a fraction into this instant; the export writes
    // that instant back out as the same wall clock. Anchoring both on one literal is what
    // stops the two directions drifting apart while each stays internally consistent.
    expect(composeInstant(46277, 0.4305555555555556)).toBe(new Date(2026, 8, 12, 10, 20).getTime());
  });

  test('refuses an instant that is not a finite timestamp', () => {
    expect(instantCell(Number.NaN)).toEqual({ kind: 'empty' });
    expect(instantCell(Number.POSITIVE_INFINITY)).toEqual({ kind: 'empty' });
  });

  test('writes a wall-clock time as a fraction of a day', () => {
    expect(timeCell('10:20')).toEqual({ kind: 'number', value: 0.4305555555555556, format: 'hh:mm' });
    expect(timeCell('00:00')).toEqual({ kind: 'number', value: 0, format: 'hh:mm' });
    expect(timeCell('23:59')).toEqual({ kind: 'number', value: 0.9993055555555556, format: 'hh:mm' });
    expect(timeFormat).toBe('hh:mm');
  });

  test('round-trips the import: the fraction it writes is the fraction the import reads back', () => {
    expect(excelFractionToTimeString(0.4305555555555556)).toBe('10:20');
  });

  test('refuses a time outside the day or written loosely', () => {
    expect(timeCell('24:00')).toEqual({ kind: 'empty' });
    expect(timeCell('7:05')).toEqual({ kind: 'empty' });
    expect(timeCell('10:60')).toEqual({ kind: 'empty' });
    expect(timeCell('mediodía')).toEqual({ kind: 'empty' });
  });
});

describe('money cells', () => {
  test('writes integer minor units as a major-unit number', () => {
    expect(moneyCell(81_000_000, 'COP')).toEqual({ kind: 'number', value: 810000, format: '"COP" #,##0.00' });
    expect(moneyCell(123_456, 'USD')).toEqual({ kind: 'number', value: 1234.56, format: '"USD" #,##0.00' });
    expect(moneyCell(0, 'EUR')).toEqual({ kind: 'number', value: 0, format: '"EUR" #,##0.00' });
  });

  test('gives each currency its own format so two never blend in one sheet', () => {
    expect(moneyFormats.COP).toBe('"COP" #,##0.00');
    expect(moneyFormats.USD).toBe('"USD" #,##0.00');
    expect(moneyFormats.EUR).toBe('"EUR" #,##0.00');
    expect(moneyFormats.MXN).toBe('"MXN" #,##0.00');
    expect(new Set(Object.values(moneyFormats)).size).toBe(4);
  });

  test('refuses an amount that is not non-negative integer minor units', () => {
    expect(moneyCell(-1, 'COP')).toEqual({ kind: 'empty' });
    expect(moneyCell(1.5, 'COP')).toEqual({ kind: 'empty' });
    expect(moneyCell(Number.NaN, 'COP')).toEqual({ kind: 'empty' });
  });
});

describe('field value cells', () => {
  const text = { kind: 'text' } as const;
  const options = [
    { id: 'exec', label: 'Ejecutivo' },
    { id: 'turista', label: 'Turista' },
  ];

  test('writes each scalar value as its own type, never as a string', () => {
    expect(fieldValueCell({ kind: 'text', value: 'Vuelo AV8020' }, text)).toEqual({
      kind: 'text',
      value: 'Vuelo AV8020',
    });
    expect(fieldValueCell({ kind: 'longText', value: 'Nota' }, { kind: 'longText' })).toEqual({
      kind: 'text',
      value: 'Nota',
    });
    expect(fieldValueCell({ kind: 'number', value: 18 }, { kind: 'number' })).toEqual({
      kind: 'number',
      value: 18,
    });
    expect(fieldValueCell({ kind: 'boolean', value: true }, { kind: 'boolean' })).toEqual({
      kind: 'boolean',
      value: true,
    });
    expect(fieldValueCell({ kind: 'boolean', value: false }, { kind: 'boolean' })).toEqual({
      kind: 'boolean',
      value: false,
    });
  });

  test('routes temporal values through the zone rules rather than stringifying them', () => {
    expect(fieldValueCell({ kind: 'date', value: '2026-09-12' }, { kind: 'date' })).toEqual({
      kind: 'date',
      value: new Date(Date.UTC(2026, 8, 12)),
      format: 'yyyy-mm-dd',
    });
    expect(
      fieldValueCell({ kind: 'datetime', value: new Date(2026, 8, 12, 10, 20).getTime() }, { kind: 'datetime' }),
    ).toEqual({ kind: 'date', value: new Date(Date.UTC(2026, 8, 12, 10, 20)), format: 'yyyy-mm-dd hh:mm' });
    expect(fieldValueCell({ kind: 'time', value: '10:20' }, { kind: 'time' })).toEqual({
      kind: 'number',
      value: 0.4305555555555556,
      format: 'hh:mm',
    });
  });

  test('writes an option label from the version snapshot, never the stored id', () => {
    expect(fieldValueCell({ kind: 'select', optionId: 'exec' }, { kind: 'select', options })).toEqual({
      kind: 'text',
      value: 'Ejecutivo',
    });
    // An id the snapshot no longer knows is a blank cell. A raw Convex id in a spreadsheet
    // is worse than nothing: it is meaningless outside the deployment and it looks like data.
    expect(fieldValueCell({ kind: 'select', optionId: 'vip' }, { kind: 'select', options })).toEqual({
      kind: 'empty',
    });
  });

  test('joins multiSelect labels and keeps only the ids the snapshot knows', () => {
    expect(
      fieldValueCell({ kind: 'multiSelect', optionIds: ['exec', 'turista'] }, { kind: 'multiSelect', options }),
    ).toEqual({ kind: 'text', value: 'Ejecutivo; Turista' });
    expect(
      fieldValueCell({ kind: 'multiSelect', optionIds: ['vip', 'turista'] }, { kind: 'multiSelect', options }),
    ).toEqual({ kind: 'text', value: 'Turista' });
    expect(
      fieldValueCell({ kind: 'multiSelect', optionIds: ['vip'] }, { kind: 'multiSelect', options }),
    ).toEqual({ kind: 'empty' });
  });

  test('writes the resolved location name, and nothing when it could not be resolved', () => {
    // Branded the way `workbook-cells.test.ts` brands one; the id is only carried here,
    // never read, so the boxing `Object.assign` does to a string is harmless.
    const locationId = Object.assign('loc-1', { __tableName: 'locations' as const });
    expect(
      fieldValueCell({ kind: 'location', locationId }, { kind: 'location' }, 'Aeropuerto El Dorado'),
    ).toEqual({ kind: 'text', value: 'Aeropuerto El Dorado' });
    // The Locations walk did not resolve it — a blank cell, never the Convex id.
    expect(fieldValueCell({ kind: 'location', locationId }, { kind: 'location' })).toEqual({ kind: 'empty' });
  });
});

describe('the adapter into the xlsx library', () => {
  test('writes a blank cell rather than an empty string', () => {
    expect(toSheetCell({ kind: 'empty' })).toBeNull();
  });

  test('carries the type and the format the rules decided', () => {
    expect(toSheetCell({ kind: 'text', value: 'Servicio' })).toEqual({ type: String, value: 'Servicio' });
    expect(toSheetCell({ kind: 'boolean', value: true })).toEqual({ type: Boolean, value: true });
    expect(toSheetCell({ kind: 'number', value: 18 })).toEqual({ type: Number, value: 18 });
    expect(toSheetCell({ kind: 'number', value: 810000, format: '"COP" #,##0.00' })).toEqual({
      type: Number,
      value: 810000,
      format: '"COP" #,##0.00',
    });
    expect(toSheetCell({ kind: 'date', value: new Date(Date.UTC(2026, 8, 12)), format: 'yyyy-mm-dd' })).toEqual({
      type: Date,
      value: new Date(Date.UTC(2026, 8, 12)),
      format: 'yyyy-mm-dd',
    });
  });
});
