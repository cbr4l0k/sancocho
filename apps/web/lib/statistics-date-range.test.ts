import { describe, expect, test } from 'bun:test';

import { endOfLocalDay, resolveDateRangeFilter, resolveUpcomingWindow, startOfLocalDay } from './statistics-date-range';

describe('startOfLocalDay / endOfLocalDay', () => {
  test('resolve to local midnight and local end-of-day for a valid date', () => {
    const start = startOfLocalDay('2026-03-15');
    const end = endOfLocalDay('2026-03-15');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const startDate = new Date(start as number);
    const endDate = new Date(end as number);
    expect(startDate.getFullYear()).toBe(2026);
    expect(startDate.getMonth()).toBe(2);
    expect(startDate.getDate()).toBe(15);
    expect(startDate.getHours()).toBe(0);
    expect(startDate.getMinutes()).toBe(0);
    expect(endDate.getDate()).toBe(15);
    expect(endDate.getHours()).toBe(23);
    expect(endDate.getMinutes()).toBe(59);
    expect((end as number) - (start as number)).toBe(24 * 60 * 60 * 1000 - 1);
  });

  test('reject malformed or out-of-range input', () => {
    expect(startOfLocalDay('not-a-date')).toBeUndefined();
    expect(startOfLocalDay('2026-13-01')).toBeUndefined();
    expect(endOfLocalDay('2026-02-30')).toBeUndefined();
  });
});

describe('resolveDateRangeFilter', () => {
  test('a blank side resolves to undefined, leaving that bound open', () => {
    const result = resolveDateRangeFilter({ from: '2026-03-01', to: '' });
    expect(result).not.toBe('invalid');
    if (result === 'invalid') return;
    expect(result.startsAt).toBeDefined();
    expect(result.endsAt).toBeUndefined();
  });

  test('both blank resolves to a fully open filter', () => {
    const result = resolveDateRangeFilter({ from: '', to: '' });
    expect(result).toEqual({ startsAt: undefined, endsAt: undefined });
  });

  test('an ordered range resolves both bounds', () => {
    const result = resolveDateRangeFilter({ from: '2026-03-01', to: '2026-03-10' });
    expect(result).not.toBe('invalid');
    if (result === 'invalid') return;
    expect(result.startsAt).toBeLessThan(result.endsAt as number);
  });

  test('an inverted range (to before from) is reported invalid, never silently swapped', () => {
    const result = resolveDateRangeFilter({ from: '2026-03-10', to: '2026-03-01' });
    expect(result).toBe('invalid');
  });

  test('an equal single-day range is valid, not invalid', () => {
    const result = resolveDateRangeFilter({ from: '2026-03-05', to: '2026-03-05' });
    expect(result).not.toBe('invalid');
  });
});

describe('resolveUpcomingWindow', () => {
  const now = Date.UTC(2026, 0, 1);

  test('a normal day count produces a window of that many days', () => {
    const { startsAt, endsAt } = resolveUpcomingWindow(7, now);
    expect(startsAt).toBe(now);
    expect(endsAt - startsAt).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('clamps a day count above the server maximum down to 31 days', () => {
    const { startsAt, endsAt } = resolveUpcomingWindow(9999, now);
    expect(endsAt - startsAt).toBe(31 * 24 * 60 * 60 * 1000);
  });

  test('clamps a non-positive or fractional day count up to at least one whole day', () => {
    const zero = resolveUpcomingWindow(0, now);
    expect(zero.endsAt - zero.startsAt).toBe(24 * 60 * 60 * 1000);
    const negative = resolveUpcomingWindow(-5, now);
    expect(negative.endsAt - negative.startsAt).toBe(24 * 60 * 60 * 1000);
  });
});
