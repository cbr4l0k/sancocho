import { describe, expect, test } from 'bun:test';

import { projectDateRangeFromParts, projectTimestampFromParts } from './project-timestamps';

describe('project timestamps', () => {
  test('constructs an absolute timestamp from explicit date and time parts', () => {
    expect(projectTimestampFromParts({ date: '2026-08-15', time: '09:30' })).toBe(
      new Date(2026, 7, 15, 9, 30).getTime(),
    );
  });

  test('accepts a same-day range when the end time follows the start time', () => {
    expect(
      projectDateRangeFromParts({ date: '2026-08-15', time: '09:00' }, { date: '2026-08-15', time: '17:00' }),
    ).toEqual({
      startsAt: new Date(2026, 7, 15, 9, 0).getTime(),
      endsAt: new Date(2026, 7, 15, 17, 0).getTime(),
    });
  });

  test('rejects an end timestamp before its start timestamp', () => {
    expect(
      projectDateRangeFromParts({ date: '2026-08-15', time: '17:00' }, { date: '2026-08-15', time: '09:00' }),
    ).toBeUndefined();
  });
});
