import { describe, expect, test } from 'bun:test';

import {
  drainPages,
  exportFileName,
  exportIsRunning,
  failedSheet,
  mapInBatches,
  type ExportPage,
} from './export-run';

function pagedReader(pages: readonly (readonly string[])[]): {
  read: (cursor: string | null) => Promise<ExportPage<string>>;
  cursors: (string | null)[];
} {
  const cursors: (string | null)[] = [];
  return {
    cursors,
    read: (cursor) => {
      cursors.push(cursor);
      const index = cursor === null ? 0 : Number(cursor);
      const page = pages[index] ?? [];
      return Promise.resolve({
        page,
        continueCursor: String(index + 1),
        isDone: index >= pages.length - 1,
      });
    },
  };
}

describe('walking a paginated query', () => {
  test('returns every row of every page, in order and without duplicates', async () => {
    const { read, cursors } = pagedReader([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    const rows = await drainPages(read);
    expect(rows).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // Three reads, each continuing from the previous page's cursor. A walk that re-read
    // the first page would still return six rows, so the cursors are asserted too.
    expect(cursors).toEqual([null, '1', '2']);
  });

  test('stops after a single page that is already done', async () => {
    const { read, cursors } = pagedReader([['only']]);
    expect(await drainPages(read)).toEqual(['only']);
    expect(cursors).toEqual([null]);
  });

  test('reports the running total after each page', async () => {
    const { read } = pagedReader([
      ['a', 'b'],
      ['c'],
      ['d', 'e', 'f'],
    ]);
    const totals: number[] = [];
    await drainPages(read, (total) => totals.push(total));
    expect(totals).toEqual([2, 3, 6]);
  });

  test('keeps an empty page rather than treating it as the end', async () => {
    const { read } = pagedReader([['a'], [], ['b']]);
    expect(await drainPages(read)).toEqual(['a', 'b']);
  });

  test('refuses to loop forever on a cursor that never advances', async () => {
    let reads = 0;
    const read = (): Promise<ExportPage<string>> => {
      reads += 1;
      return Promise.resolve({ page: ['a'], continueCursor: 'stuck', isDone: false });
    };
    await expect(drainPages(read)).rejects.toThrow();
    // Two reads: the first records the cursor, the second sees it repeat and stops.
    expect(reads).toBe(2);
  });
});

describe('mapping in batches', () => {
  test('maps every item exactly once and keeps input order across full batches', async () => {
    // Eight items at concurrency 4 is an exact multiple; nine is one past it. A slice
    // that is one short drops the last item of every batch, and pushing batches at the
    // front instead of the back would reverse them.
    const map = async (item: number) => `n${item}`;
    expect(await mapInBatches([0, 1, 2, 3, 4, 5, 6, 7], 4, map)).toEqual([
      'n0',
      'n1',
      'n2',
      'n3',
      'n4',
      'n5',
      'n6',
      'n7',
    ]);
    expect(await mapInBatches([0, 1, 2, 3, 4, 5, 6, 7, 8], 4, map)).toEqual([
      'n0',
      'n1',
      'n2',
      'n3',
      'n4',
      'n5',
      'n6',
      'n7',
      'n8',
    ]);
  });

  test('refuses a concurrency of zero', async () => {
    await expect(mapInBatches(['a'], 0, async (item) => item)).rejects.toThrow(RangeError);
  });
});

describe('export file name', () => {
  // 20:00 in Bogotá is 01:00 UTC the next calendar day. The UTC date would stamp
  // every evening export as tomorrow.
  const tonight = new Date(2026, 8, 18, 20, 0);

  test('sanitizes the organization name so it cannot form a path', () => {
    expect(exportFileName('Andes / Bogotá', tonight)).toBe('priamo-andes-bogota-2026-09-18.xlsx');
    expect(exportFileName('Andes\\Bogotá', tonight)).toBe('priamo-andes-bogota-2026-09-18.xlsx');
    expect(exportFileName('Op. 2026/27', tonight)).toBe('priamo-op-2026-27-2026-09-18.xlsx');
    expect(exportFileName('--Andes--', tonight)).toBe('priamo-andes-2026-09-18.xlsx');
  });

  test('falls back when the name sanitizes to nothing, so the file is never priamo--<date>', () => {
    expect(exportFileName('///', tonight)).toBe('priamo-export-2026-09-18.xlsx');
    expect(exportFileName('', tonight)).toBe('priamo-export-2026-09-18.xlsx');
  });

  test('stamps the local calendar date, not the UTC date', () => {
    expect(exportFileName('Andes', tonight)).toBe('priamo-andes-2026-09-18.xlsx');
  });
});

describe('export progress', () => {
  test('counts reading and writing as running, and nothing else', () => {
    expect(exportIsRunning({ kind: 'idle' })).toBe(false);
    expect(exportIsRunning({ kind: 'reading', sheet: 'events', rows: 12 })).toBe(true);
    expect(exportIsRunning({ kind: 'writing', rows: 12 })).toBe(true);
    expect(exportIsRunning({ kind: 'done', rows: 12 })).toBe(false);
    // A failed export is finished, not running: the button has to come back so the
    // operator can retry it.
    expect(exportIsRunning({ kind: 'failed', sheet: 'services' })).toBe(false);
    expect(exportIsRunning({ kind: 'refused' })).toBe(false);
  });

  test('names the sheet a stopped walk died on, and names none when the gate refused', () => {
    expect(failedSheet({ kind: 'failed', sheet: 'services' })).toBe('services');
    // The gate runs before the first page. Blaming a sheet here would tell the operator
    // their Events read broke when what happened is that they may not export at all.
    expect(failedSheet({ kind: 'refused' })).toBeUndefined();
    expect(failedSheet({ kind: 'reading', sheet: 'events', rows: 3 })).toBeUndefined();
    expect(failedSheet({ kind: 'done', rows: 3 })).toBeUndefined();
  });
});
