import { describe, expect, test } from 'bun:test';

import { parseExportWindow, withinExportWindow } from './export-window';

/*
 * These tests run under TZ=America/Bogota (UTC-5), pinned in apps/web/package.json.
 * Local midnight is five hours after UTC midnight, so a window built at UTC
 * midnight would admit 23:59 on the previous local day.
 */

describe('parseExportWindow', () => {
  test('a same-day window is local midnight through the last millisecond', () => {
    expect(parseExportWindow('2026-09-12', '2026-09-12')).toEqual({
      from: new Date(2026, 8, 12, 0, 0, 0, 0).getTime(),
      to: new Date(2026, 8, 12, 23, 59, 59, 999).getTime(),
    });
  });

  test('a from-only window bounds the start and leaves the end open', () => {
    expect(parseExportWindow('2026-09-12', '')).toEqual({
      from: new Date(2026, 8, 12, 0, 0, 0, 0).getTime(),
    });
  });

  test('a to-only window bounds the end and leaves the start open', () => {
    expect(parseExportWindow('', '2026-09-12')).toEqual({
      to: new Date(2026, 8, 12, 23, 59, 59, 999).getTime(),
    });
  });

  test('an empty string contributes no bound', () => {
    expect(parseExportWindow('', '')).toEqual({});
  });

  test('an invalid date string contributes no bound', () => {
    expect(parseExportWindow('2026-13-45', '')).toEqual({});
    expect(parseExportWindow('', '12/09/2026')).toEqual({});
    expect(parseExportWindow('2026-13-45', '12/09/2026')).toEqual({});
  });
});

describe('withinExportWindow', () => {
  test('a same-day window admits 00:00 and 23:59 local and rejects the neighbouring days', () => {
    const window = parseExportWindow('2026-09-12', '2026-09-12');
    expect(withinExportWindow(new Date(2026, 8, 12, 0, 0).getTime(), window)).toBe(true);
    expect(withinExportWindow(new Date(2026, 8, 12, 23, 59).getTime(), window)).toBe(true);
    expect(withinExportWindow(new Date(2026, 8, 11, 23, 59).getTime(), window)).toBe(false);
    expect(withinExportWindow(new Date(2026, 8, 13, 0, 0).getTime(), window)).toBe(false);
  });

  test('a from-only window bounds one side and leaves the other open', () => {
    const window = parseExportWindow('2026-09-12', '');
    expect(withinExportWindow(new Date(2026, 8, 11, 23, 59).getTime(), window)).toBe(false);
    expect(withinExportWindow(new Date(2026, 8, 12, 0, 0).getTime(), window)).toBe(true);
    expect(withinExportWindow(new Date(2026, 8, 13, 0, 0).getTime(), window)).toBe(true);
  });

  test('a to-only window bounds one side and leaves the other open', () => {
    const window = parseExportWindow('', '2026-09-12');
    expect(withinExportWindow(new Date(2026, 8, 11, 0, 0).getTime(), window)).toBe(true);
    expect(withinExportWindow(new Date(2026, 8, 12, 23, 59).getTime(), window)).toBe(true);
    expect(withinExportWindow(new Date(2026, 8, 13, 0, 0).getTime(), window)).toBe(false);
  });

  test('an empty window admits everything, including 0', () => {
    expect(withinExportWindow(0, {})).toBe(true);
    expect(withinExportWindow(new Date(2026, 8, 12, 0, 0).getTime(), {})).toBe(true);
  });

  test('is inclusive at both exact boundary milliseconds', () => {
    const window = parseExportWindow('2026-09-12', '2026-09-12');
    expect(withinExportWindow(new Date(2026, 8, 12, 0, 0, 0, 0).getTime(), window)).toBe(true);
    expect(withinExportWindow(new Date(2026, 8, 12, 23, 59, 59, 999).getTime(), window)).toBe(true);
    expect(withinExportWindow(new Date(2026, 8, 11, 23, 59, 59, 999).getTime(), window)).toBe(false);
    expect(withinExportWindow(new Date(2026, 8, 13, 0, 0, 0, 0).getTime(), window)).toBe(false);
  });
});
