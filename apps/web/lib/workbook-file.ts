import type { WorkbookCell } from './workbook-cells';

export type WorkbookSheet = {
  sheet: string;
  rows: readonly (readonly WorkbookCell[])[];
};

export type WorkbookReadResult =
  | { ok: true; sheets: readonly WorkbookSheet[] }
  | { ok: false; problem: 'invalidWorkbook' };

/** Narrows the parser boundary, including real Date instances its declarations mistype as typeof Date. */
export function isWorkbookCell(value: unknown): value is WorkbookCell {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date;
}

export async function readWorkbook(file: File): Promise<WorkbookReadResult> {
  try {
    // This stays browser-only: workbooks contain real coordinator names and phone
    // numbers that docs/cordillera-seed.md deliberately refuses to ship. Uploading
    // the source would turn a local preview into a new personal-data ingestion path.
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    const parsed = await readXlsxFile(file);
    const sheets: WorkbookSheet[] = [];
    for (const candidate of parsed) {
      const rows: WorkbookCell[][] = [];
      for (const candidateRow of candidate.data) {
        const row: WorkbookCell[] = [];
        for (const cell of candidateRow) {
          if (!isWorkbookCell(cell)) return { ok: false, problem: 'invalidWorkbook' };
          row.push(cell);
        }
        rows.push(row);
      }
      sheets.push({ sheet: candidate.sheet, rows });
    }
    return { ok: true, sheets };
  } catch {
    return { ok: false, problem: 'invalidWorkbook' };
  }
}
