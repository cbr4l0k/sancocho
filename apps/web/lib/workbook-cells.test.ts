import { describe, expect, test } from 'bun:test';

import type { FieldConfig } from './workbook-cells';
import {
  cellToFieldValue,
  composeInstant,
  excelFractionToTimeString,
  excelSerialToDateString,
} from './workbook-cells';

describe('Excel serial conversion', () => {
  test('converts the known workbook date serial literally', () => {
    expect(excelSerialToDateString(46277)).toBe('2026-09-12');
  });

  test('rejects serials through the fictitious 1900 leap day', () => {
    for (const serial of [0, 1, 59, 60]) expect(excelSerialToDateString(serial)).toBeUndefined();
    for (const serial of [-1, 61.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(excelSerialToDateString(serial)).toBeUndefined();
    }
    expect(excelSerialToDateString(61)).toBe('1900-03-01');
  });

  test('converts the known workbook time fraction literally', () => {
    expect(excelFractionToTimeString(0.4305555555555556)).toBe('10:20');
  });

  test('rounds to a minute without wrapping into the next day', () => {
    expect(excelFractionToTimeString(0.5)).toBe('12:00');
    expect(excelFractionToTimeString(0.999)).toBe('23:59');
    expect(excelFractionToTimeString(0.9999)).toBeUndefined();
    expect(excelFractionToTimeString(-0.1)).toBeUndefined();
    expect(excelFractionToTimeString(1)).toBeUndefined();
  });
});

/*
 * These tests run under TZ=America/Bogota, pinned in apps/web/package.json.
 * It is not cosmetic: `dateStringFromCell` and `timeStringFromCell` read a parser
 * `Date` with the UTC getters on purpose, and under a UTC runner swapping them for
 * the local getters passes every test here. Only a non-zero offset can tell the two
 * apart, and es-CO is the product's default locale, so Bogota is the honest zone to
 * test in — a date shifted a day back is exactly the bug a Colombian operator hits.
 */
describe('target-directed cell conversion', () => {
  test('keeps date and time values as wall-clock strings', () => {
    expect(cellToFieldValue(46277, { kind: 'date' })).toEqual({
      ok: true,
      value: { kind: 'date', value: '2026-09-12' },
    });
    expect(cellToFieldValue(0.4305555555555556, { kind: 'time' })).toEqual({
      ok: true,
      value: { kind: 'time', value: '10:20' },
    });
  });

  test('refuses decimal-clock guesses for 14.45 and 14.5', () => {
    expect(cellToFieldValue(14.45, { kind: 'time' })).toEqual({ ok: false, problem: 'notATime' });
    expect(cellToFieldValue(14.5, { kind: 'time' })).toEqual({ ok: false, problem: 'notATime' });
  });

  test('refuses ambiguous localized date strings', () => {
    expect(cellToFieldValue('12/09/2026', { kind: 'date' })).toEqual({
      ok: false,
      problem: 'ambiguousDate',
    });
    expect(cellToFieldValue('2026-09-12', { kind: 'date' })).toEqual({
      ok: true,
      value: { kind: 'date', value: '2026-09-12' },
    });
    expect(cellToFieldValue('2026-13-12', { kind: 'date' })).toEqual({ ok: false, problem: 'notADate' });
  });

  test('does not coerce localized numeric strings', () => {
    expect(cellToFieldValue('810.000', { kind: 'number' })).toEqual({ ok: false, problem: 'notANumber' });
    expect(cellToFieldValue('810000', { kind: 'number' })).toEqual({
      ok: true,
      value: { kind: 'number', value: '810000' },
    });
  });

  test('matches select labels only after exact normalization', () => {
    const config: FieldConfig = {
      kind: 'select',
      options: [{ id: 'sprinter', label: 'Sprinter  18 PAX' }],
    };
    expect(cellToFieldValue('  sprinter 18 pax ', config)).toEqual({
      ok: true,
      value: { kind: 'select', optionId: 'sprinter' },
    });
    expect(cellToFieldValue('Sprinter 18', config)).toEqual({ ok: false, problem: 'unknownOption' });
  });

  test('rejects select labels that normalize to more than one option', () => {
    const config: FieldConfig = {
      kind: 'select',
      options: [{ id: 'one', label: 'Bus' }, { id: 'two', label: ' bus ' }],
    };
    expect(cellToFieldValue('BUS', config)).toEqual({ ok: false, problem: 'unknownOption' });
  });

  test('rejects location names that normalize to more than one catalogue entry', () => {
    const locations = [
      { id: Object.assign('loc-1', { __tableName: 'locations' as const }), name: 'Depot' },
      { id: Object.assign('loc-2', { __tableName: 'locations' as const }), name: ' depot ' },
    ];
    expect(cellToFieldValue('DEPOT', { kind: 'location' }, { locations })).toEqual({
      ok: false,
      problem: 'unresolvedLocation',
    });
  });

  test('converts ISO datetime strings and rejects an impossible calendar date', () => {
    expect(cellToFieldValue('2026-09-12T10:20', { kind: 'datetime' })).toEqual({
      ok: true,
      value: { kind: 'datetime', date: '2026-09-12', time: '10:20' },
    });
    expect(cellToFieldValue('2026-09-12 10:20', { kind: 'datetime' })).toEqual({
      ok: true,
      value: { kind: 'datetime', date: '2026-09-12', time: '10:20' },
    });
    expect(cellToFieldValue('2026-13-45T10:20', { kind: 'datetime' })).toEqual({
      ok: false,
      problem: 'notADate',
    });
  });

  test('pre-converted Dates agree with their date, time and datetime serial forms', () => {
    const date = new Date(Date.UTC(2026, 8, 12, 10, 20));
    expect(cellToFieldValue(new Date(Date.UTC(2026, 8, 12)), { kind: 'date' })).toEqual(
      cellToFieldValue(46277, { kind: 'date' }),
    );
    expect(cellToFieldValue(date, { kind: 'time' })).toEqual(
      cellToFieldValue(0.4305555555555556, { kind: 'time' }),
    );
    expect(cellToFieldValue(date, { kind: 'datetime' })).toEqual(
      cellToFieldValue(46277.430555555555, { kind: 'datetime' }),
    );
  });

  test('routes range and integer rules through the existing field validator mirror', () => {
    expect(cellToFieldValue(9, { kind: 'number', min: 10 })).toEqual({ ok: false, problem: 'notANumber' });
    expect(cellToFieldValue(1.5, { kind: 'number', integer: true })).toEqual({
      ok: false,
      problem: 'notAnInteger',
    });
  });

  test('makes every typed cell problem reachable', () => {
    expect(cellToFieldValue(null, { kind: 'text' })).toEqual({ ok: false, problem: 'empty' });
    expect(cellToFieldValue(1, { kind: 'text' })).toEqual({ ok: false, problem: 'notText' });
    expect(cellToFieldValue('abc', { kind: 'number' })).toEqual({ ok: false, problem: 'notANumber' });
    expect(cellToFieldValue(1.2, { kind: 'number', integer: true })).toEqual({ ok: false, problem: 'notAnInteger' });
    expect(cellToFieldValue('yesterday', { kind: 'date' })).toEqual({ ok: false, problem: 'notADate' });
    expect(cellToFieldValue('noon', { kind: 'time' })).toEqual({ ok: false, problem: 'notATime' });
    expect(cellToFieldValue('09/12/2026', { kind: 'date' })).toEqual({ ok: false, problem: 'ambiguousDate' });
    expect(cellToFieldValue('coach', { kind: 'select', options: [] })).toEqual({ ok: false, problem: 'unknownOption' });
    expect(cellToFieldValue('Depot', { kind: 'location' })).toEqual({ ok: false, problem: 'unresolvedLocation' });
    expect(cellToFieldValue('yes', { kind: 'boolean' })).toEqual({ ok: false, problem: 'notBoolean' });
  });
});

test('composeInstant uses the local wall clock pair', () => {
  expect(composeInstant(46277, 0.4305555555555556)).toBe(new Date(2026, 8, 12, 10, 20).getTime());
  expect(composeInstant('12/09/2026', '10:20')).toBe('ambiguousDate');
});

/*
 * Which problem a blocked cell reports is not cosmetic: `ambiguousDate` tells the
 * operator to widen the column or format it as a real date, `notADate` tells them the
 * cell is junk, and `empty` tells them the pair is simply incomplete. The row is
 * blocked either way, so only these assertions keep the message honest.
 */
test('composeInstant reports an incomplete pair as empty, not as an unreadable date', () => {
  expect(composeInstant(null, '10:20')).toBe('empty');
  expect(composeInstant('', '10:20')).toBe('empty');
  expect(composeInstant('   ', '10:20')).toBe('empty');
  expect(composeInstant('2026-09-12', null)).toBe('empty');
  expect(composeInstant('2026-09-12', '  ')).toBe('empty');
  expect(composeInstant(null, null)).toBe('empty');
});

test('routes a date cell inside the 1900 leap-day window to ambiguousDate', () => {
  expect(cellToFieldValue(60, { kind: 'date' })).toEqual({ ok: false, problem: 'ambiguousDate' });
  expect(cellToFieldValue(0, { kind: 'date' })).toEqual({ ok: false, problem: 'ambiguousDate' });
  expect(cellToFieldValue(61, { kind: 'date' })).toEqual({
    ok: true,
    value: { kind: 'date', value: '1900-03-01' },
  });
});

test('routes a datetime cell inside the 1900 leap-day window to ambiguousDate', () => {
  expect(cellToFieldValue(60, { kind: 'datetime' })).toEqual({ ok: false, problem: 'ambiguousDate' });
  expect(cellToFieldValue(0, { kind: 'datetime' })).toEqual({ ok: false, problem: 'ambiguousDate' });
  expect(cellToFieldValue(46277.430555555555, { kind: 'datetime' })).toEqual({
    ok: true,
    value: { kind: 'datetime', date: '2026-09-12', time: '10:20' },
  });
});

test('keeps a serial outside that window unreadable rather than ambiguous', () => {
  expect(cellToFieldValue(-1, { kind: 'date' })).toEqual({ ok: false, problem: 'notADate' });
  expect(cellToFieldValue(30.5, { kind: 'date' })).toEqual({ ok: false, problem: 'notADate' });
  expect(cellToFieldValue(-1, { kind: 'datetime' })).toEqual({ ok: false, problem: 'notADate' });
  expect(cellToFieldValue(30.5, { kind: 'datetime' })).toEqual({ ok: false, problem: 'notADate' });
});
