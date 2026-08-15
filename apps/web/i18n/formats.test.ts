import { formatDate, formatDateTime, formatTime, parseDateForStorage, parseTimeForStorage } from './formats';

declare function test(name: string, body: () => void): void;

function expectEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
}

function expectContains(actual: string, expected: string): void {
  if (!actual.includes(expected)) throw new Error(`Expected ${actual} to contain ${expected}`);
}

process.env.TZ = 'America/Bogota';

test('formats a calendar date without shifting it in a negative UTC offset', () => {
  expectContains(formatDate('es-CO', '2026-03-01'), '1');
  expectContains(formatDate('es-CO', '2026-03-01'), '03');
  expectContains(formatDate('es-CO', '2026-03-01'), '2026');
  expectContains(formatDate('en-US', '2026-03-01'), '1');
  expectContains(formatDate('en-US', '2026-03-01'), '2026');
});

test('keeps a validated wall-clock time in strict storage format', () => {
  expectEqual(parseTimeForStorage('09:05'), '09:05');
  expectContains(formatTime('es-CO', '09:05'), '09:05');
  expectContains(formatTime('en-US', '09:05'), '9:05');
});

test('formats absolute datetimes for each locale', () => {
  const value = Date.UTC(2026, 2, 1, 15, 30);
  if (formatDateTime('es-CO', value) === formatDateTime('en-US', value)) throw new Error('Expected locale-specific datetime output');
});

test('rejects invalid strict date and time values', () => {
  expectEqual(parseDateForStorage('2026-02-29'), undefined);
  expectEqual(parseDateForStorage('03/01/2026'), undefined);
  expectEqual(parseTimeForStorage('24:00'), undefined);
  expectEqual(parseTimeForStorage('9:05'), undefined);
});
