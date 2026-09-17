import { describe, expect, test } from 'bun:test';

import { isWorkbookCell } from './workbook-file';

describe('workbook parser cell boundary', () => {
  test('accepts every WorkbookCell arm, including the parser declaration’s Date mistake', () => {
    expect([
      'Traslado',
      42,
      true,
      new Date('2026-09-12T10:20:00.000Z'),
      null,
    ].every(isWorkbookCell)).toBe(true);
  });

  test('rejects the Date constructor and non-cell objects', () => {
    expect(isWorkbookCell(Date)).toBe(false);
    expect(isWorkbookCell({ value: 'Traslado' })).toBe(false);
    expect(isWorkbookCell(undefined)).toBe(false);
  });
});
