import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  browserDispatchDay,
  dispatchDayFor,
  dispatchDayFromKey,
  dispatchDayNavigation,
  shiftDispatchDay,
} from './dispatch-day';

const originalTimeZone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = 'America/New_York';
});

afterAll(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

describe('dispatch day arithmetic', () => {
  test('uses exact local-midnight half-open bounds', () => {
    const day = dispatchDayFor(new Date(2026, 0, 15, 18, 42));
    expect(day).toEqual({
      from: new Date(2026, 0, 15).getTime(),
      to: new Date(2026, 0, 16).getTime(),
      key: '2026-01-15',
    });
    expect(new Date(day.from).getHours()).toBe(0);
    expect(new Date(day.to).getHours()).toBe(0);
  });

  test('moves to the preceding and following calendar dates', () => {
    const day = dispatchDayFromKey('2026-03-01');
    expect(shiftDispatchDay(day, -1).key).toBe('2026-02-28');
    expect(shiftDispatchDay(day, 1).key).toBe('2026-03-02');
  });

  test('does not assume a local day is 86,400,000 ms across DST', () => {
    const springForward = dispatchDayFromKey('2026-03-08');
    const fallBack = dispatchDayFromKey('2026-11-01');
    expect(springForward.to - springForward.from).toBe(23 * 60 * 60 * 1000);
    expect(fallBack.to - fallBack.from).toBe(25 * 60 * 60 * 1000);
  });

  test('shifts both directions across spring-forward and fall-back boundaries', () => {
    const springForward = dispatchDayFromKey('2026-03-08');
    const afterSpringForward = shiftDispatchDay(springForward, 1);
    expect(afterSpringForward.key).toBe('2026-03-09');
    expect(shiftDispatchDay(afterSpringForward, -1).key).toBe('2026-03-08');

    const fallBack = dispatchDayFromKey('2026-11-01');
    const afterFallBack = shiftDispatchDay(fallBack, 1);
    expect(afterFallBack.key).toBe('2026-11-02');
    expect(shiftDispatchDay(afterFallBack, -1).key).toBe('2026-11-01');
  });

  test('uses local date parts and round-trips the window east of Greenwich', () => {
    process.env.TZ = 'Asia/Kolkata';
    try {
      const day = dispatchDayFor(new Date(2026, 8, 16, 23, 30));
      expect(day.key).toBe('2026-09-16');
      expect(dispatchDayFromKey(day.key).from).toBe(day.from);
    } finally {
      process.env.TZ = 'America/New_York';
    }
  });

  test('round-trips strict URL keys and rejects normalized dates', () => {
    for (const key of ['2024-02-29', '2026-12-31']) {
      expect(dispatchDayFromKey(key).key).toBe(key);
    }
    expect(() => dispatchDayFromKey('2026-02-30')).toThrow(RangeError);
    expect(() => dispatchDayFromKey('2026-3-8')).toThrow(RangeError);
    expect(() => dispatchDayFromKey('03/08/2026')).toThrow(RangeError);
  });

  test('rejects invalid Date inputs and non-integer shifts', () => {
    expect(() => dispatchDayFor(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => shiftDispatchDay(dispatchDayFromKey('2026-03-08'), 0.5)).toThrow(RangeError);
  });

  test('resolves valid shared day keys and falls back from malformed keys to today', () => {
    const now = new Date(2026, 6, 14, 18, 30);
    expect(browserDispatchDay('2026-11-01', now).key).toBe('2026-11-01');
    expect(browserDispatchDay('not-a-day', now).key).toBe('2026-07-14');
    expect(browserDispatchDay(undefined, now).key).toBe('2026-07-14');
  });

  test('builds Previous and Next links in their respective calendar directions', () => {
    const navigation = dispatchDayNavigation(dispatchDayFromKey('2026-03-08'), '/dispatch');
    expect(navigation.previous).toEqual({
      day: dispatchDayFromKey('2026-03-07'),
      href: '/dispatch?day=2026-03-07',
    });
    expect(navigation.next).toEqual({
      day: dispatchDayFromKey('2026-03-09'),
      href: '/dispatch?day=2026-03-09',
    });
  });
});
