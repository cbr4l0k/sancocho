import { describe, expect, test } from 'bun:test';

import { projectWindowDateBounds, projectWindowProblem } from './project-window';

const start = new Date(2026, 7, 15, 16, 0).getTime();
const end = new Date(2026, 7, 19, 16, 0).getTime();
const window = { startsAt: start, endsAt: end };

describe('projectWindowProblem', () => {
  test('accepts a service inside the window', () => {
    expect(projectWindowProblem(window, start + 3_600_000, end - 3_600_000)).toBeUndefined();
  });

  test('accepts a service touching either boundary exactly', () => {
    expect(projectWindowProblem(window, start, end)).toBeUndefined();
  });

  test('rejects a start before the window', () => {
    expect(projectWindowProblem(window, start - 1, undefined)).toBe('before');
  });

  test('rejects an end after the window', () => {
    expect(projectWindowProblem(window, start, end + 1)).toBe('after');
  });

  test('checks an open-ended service by its start', () => {
    expect(projectWindowProblem(window, end + 1, undefined)).toBe('after');
    expect(projectWindowProblem(window, end - 1, undefined)).toBeUndefined();
  });

  test('reports the earlier violation first when both ends are outside', () => {
    expect(projectWindowProblem(window, start - 1, end + 1)).toBe('before');
  });

  test('constrains nothing when the project declares no dates', () => {
    expect(projectWindowProblem({}, 0, Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  test('constrains only the end the project declares', () => {
    expect(projectWindowProblem({ startsAt: start }, start - 1, undefined)).toBe('before');
    expect(projectWindowProblem({ startsAt: start }, end + 1, undefined)).toBeUndefined();
    expect(projectWindowProblem({ endsAt: end }, start - 1, undefined)).toBeUndefined();
    expect(projectWindowProblem({ endsAt: end }, end + 1, undefined)).toBe('after');
  });
});

describe('projectWindowDateBounds', () => {
  test('bounds the picker to the window’s local calendar days', () => {
    expect(projectWindowDateBounds(window)).toEqual({ min: '2026-08-15', max: '2026-08-19' });
  });

  test('omits a bound the project does not declare', () => {
    expect(projectWindowDateBounds({ endsAt: end })).toEqual({ max: '2026-08-19' });
    expect(projectWindowDateBounds({})).toEqual({});
  });

  test('keeps the boundary days selectable even though part of each is outside', () => {
    // 15 Aug 09:00 is before the 16:00 start but shares its calendar day, so
    // the picker must allow it and `projectWindowProblem` must be what refuses.
    const bounds = projectWindowDateBounds(window);
    expect(bounds.min).toBe('2026-08-15');
    expect(projectWindowProblem(window, new Date(2026, 7, 15, 9, 0).getTime(), undefined)).toBe('before');
  });
});
