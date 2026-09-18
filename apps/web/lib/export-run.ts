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
 */
export type ExportProgress =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading'; readonly sheet: ExportSheetName; readonly rows: number }
  | { readonly kind: 'writing'; readonly rows: number }
  | { readonly kind: 'done'; readonly rows: number }
  | { readonly kind: 'failed'; readonly sheet: ExportSheetName };

export function exportIsRunning(progress: ExportProgress): boolean {
  return progress.kind === 'reading' || progress.kind === 'writing';
}
