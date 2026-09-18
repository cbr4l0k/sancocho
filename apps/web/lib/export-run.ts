import type { ExportSheetName } from './export-sheets';

/** One page of an ordinary paginated Convex query, as the generated client returns it. */
export type ExportPage<Row> = {
  readonly page: readonly Row[];
  readonly continueCursor: string;
  readonly isDone: boolean;
};

export type ReadExportPage<Row> = (cursor: string | null) => Promise<ExportPage<Row>>;

/**
 * Walks an authorized paginated query to the end, one page at a time.
 *
 * The export adds no fetch-all endpoint (I6): it drives the same queries the screens use,
 * and this is the loop that turns them into a whole sheet. `onRows` receives the RUNNING
 * total after each page so the surface can show real progress rather than a spinner.
 *
 * A cursor that repeats stops the walk with an error instead of looping forever. It should
 * not happen — Convex advances the cursor or sets `isDone` — but the failure mode if it
 * ever did is a browser tab that fills memory silently, which is worse than a failed
 * export the operator can retry.
 */
export async function drainPages<Row>(
  read: ReadExportPage<Row>,
  onRows?: (total: number) => void,
): Promise<Row[]> {
  const rows: Row[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const result = await read(cursor);
    rows.push(...result.page);
    onRows?.(rows.length);
    if (result.isDone) return rows;
    if (seenCursors.has(result.continueCursor)) {
      throw new Error('Export page cursor did not advance');
    }
    seenCursors.add(result.continueCursor);
    cursor = result.continueCursor;
  }
}

/**
 * What the surface shows while it walks.
 *
 * `failed` names the sheet the walk stopped on, because "the export failed" tells an
 * operator nothing they can act on, and no file is written in that state — a partial
 * workbook that looks complete is the one outcome worth preventing.
 *
 * `refused` is deliberately NOT a `failed` carrying a sheet. The gate runs before the
 * first page is read, so there is no sheet it stopped on; reporting one would tell the
 * operator their Events read broke when what actually happened is that they may not
 * export at all.
 */
export type ExportProgress =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading'; readonly sheet: ExportSheetName; readonly rows: number }
  | { readonly kind: 'writing'; readonly rows: number }
  | { readonly kind: 'done'; readonly rows: number }
  | { readonly kind: 'failed'; readonly sheet: ExportSheetName }
  | { readonly kind: 'refused' };

export function exportIsRunning(progress: ExportProgress): boolean {
  return progress.kind === 'reading' || progress.kind === 'writing';
}

/** The sheet a stopped export names, or nothing when it never got as far as a sheet. */
export function failedSheet(progress: ExportProgress): ExportSheetName | undefined {
  return progress.kind === 'failed' ? progress.sheet : undefined;
}

/**
 * Maps `items` with at most `concurrency` calls in flight, preserving input order.
 *
 * The Assignments and Assignment Revisions sheets are N+1 by construction — the backend
 * has no Project-scoped revision index (docs/export.md "Sheets") — so a plain
 * `Promise.all` over every Service in a large tenant would open thousands of requests at
 * once. Order is preserved because a sheet's rows must match the order the queries
 * returned them in, and every item is mapped exactly once: this is the one place in the
 * export where rows could be silently dropped or repeated.
 */
export async function mapInBatches<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  mapper: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  if (concurrency < 1) throw new RangeError('concurrency must be at least 1');
  const results: Result[] = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency);
    results.push(...(await Promise.all(batch.map((item) => mapper(item)))));
  }
  return results;
}

/**
 * `priamo-<organization>-<date>.xlsx`.
 *
 * The organization's name is tenant-authored, so it is sanitized rather than trusted: a
 * name like `Andes / Bogotá` or `Op. 2026/27` would otherwise put a path separator into a
 * download filename. Everything outside letters, digits and dashes collapses to a single
 * dash, and a name that survives as nothing at all falls back to the product name so the
 * file is never called `priamo--2026-09-18.xlsx`.
 *
 * The date is the LOCAL calendar date, matching every other date the console shows; the
 * UTC date would roll forward a day for any export run after 19:00 in Bogotá.
 */
export function exportFileName(organizationName: string, today: Date): string {
  const slug = organizationName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return `priamo-${slug === '' ? 'export' : slug}-${date}.xlsx`;
}
