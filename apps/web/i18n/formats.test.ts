import { expect, test } from 'bun:test';

import {
  formatDate,
  formatDateTime,
  formatTime,
  isValidDateInput,
  parseDateForStorage,
  parseTimeForStorage,
} from './formats';

process.env.TZ = 'America/Bogota';

test('formats a calendar date without shifting it in a negative UTC offset', () => {
  expect(formatDate('es-CO', '2026-03-01')).toContain('1');
  expect(formatDate('es-CO', '2026-03-01')).toContain('03');
  expect(formatDate('es-CO', '2026-03-01')).toContain('2026');
  expect(formatDate('en-US', '2026-03-01')).toContain('1');
  expect(formatDate('en-US', '2026-03-01')).toContain('2026');
});

test('keeps a validated wall-clock time in strict storage format', () => {
  expect(parseTimeForStorage('09:05')).toBe('09:05');
  expect(formatTime('es-CO', '09:05')).toContain('09:05');
  expect(formatTime('en-US', '09:05')).toContain('9:05');
});

test('formats absolute datetimes for each locale', () => {
  const value = Date.UTC(2026, 2, 1, 15, 30);
  expect(formatDateTime('es-CO', value)).not.toBe(formatDateTime('en-US', value));
  expect(formatDateTime('en-US', value, 'America/Bogota')).toContain('GMT');
});

test('accepts a calendar date skipped by Pacific/Apia', () => {
  const originalTimeZone = process.env.TZ;
  process.env.TZ = 'Pacific/Apia';
  try {
    expect(isValidDateInput('2011-12-30')).toBe(true);
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
});

test('rejects invalid strict date and time values', () => {
  expect(parseDateForStorage('2026-02-29')).toBeUndefined();
  expect(parseDateForStorage('03/01/2026')).toBeUndefined();
  expect(parseTimeForStorage('24:00')).toBeUndefined();
  expect(parseTimeForStorage('9:05')).toBeUndefined();
});
