import { describe, expect, test } from 'bun:test';

import { maxCount, orderProjectStatusCounts, orderServiceStatusCounts } from './statistics-status-series';

describe('orderServiceStatusCounts', () => {
  test('orders rows least-to-most-settled, matching lib/status.ts serviceStatuses', () => {
    const ordered = orderServiceStatusCounts([
      { status: 'cancelled', count: 2, isTruncated: false },
      { status: 'draft', count: 5, isTruncated: false },
      { status: 'confirmed', count: 9, isTruncated: true },
    ]);
    expect(ordered.map((row) => row.status)).toEqual(['draft', 'planned', 'confirmed', 'active', 'completed', 'cancelled']);
  });

  test('a status missing from the backend response fills in as a real zero row, not a gap', () => {
    const ordered = orderServiceStatusCounts([{ status: 'draft', count: 5, isTruncated: false }]);
    const planned = ordered.find((row) => row.status === 'planned');
    expect(planned).toEqual({ status: 'planned', count: 0, isTruncated: false });
  });

  test('preserves the isTruncated flag per row — this must never be dropped', () => {
    const ordered = orderServiceStatusCounts([{ status: 'confirmed', count: 500, isTruncated: true }]);
    const confirmed = ordered.find((row) => row.status === 'confirmed');
    expect(confirmed?.isTruncated).toBe(true);
  });
});

describe('orderProjectStatusCounts', () => {
  test('orders rows least-to-most-settled, matching lib/status.ts projectStatuses', () => {
    const ordered = orderProjectStatusCounts([
      { status: 'archived', count: 1 },
      { status: 'draft', count: 4 },
    ]);
    expect(ordered.map((row) => row.status)).toEqual(['draft', 'active', 'completed', 'archived']);
  });

  test('a status missing from the backend response fills in as zero', () => {
    const ordered = orderProjectStatusCounts([{ status: 'draft', count: 4 }]);
    expect(ordered.find((row) => row.status === 'active')).toEqual({ status: 'active', count: 0 });
  });
});

describe('maxCount', () => {
  test('returns the largest count among the rows', () => {
    expect(maxCount([{ count: 3 }, { count: 9 }, { count: 1 }])).toBe(9);
  });

  test('floors at 1 for an all-zero or empty set, so a proportional bar never divides by zero', () => {
    expect(maxCount([{ count: 0 }, { count: 0 }])).toBe(1);
    expect(maxCount([])).toBe(1);
  });
});
