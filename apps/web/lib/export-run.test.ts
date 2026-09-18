import { describe, expect, test } from 'bun:test';

import { drainPages, exportIsRunning, failedSheet, type ExportPage } from './export-run';

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
