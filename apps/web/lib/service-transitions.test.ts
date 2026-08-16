import { describe, expect, test } from 'bun:test';

import { serviceStatuses } from '@/lib/status';
import { legalNextServiceStatuses } from './service-transitions';

describe('legalNextServiceStatuses', () => {
  test('offers exactly the backend one-step transitions', () => {
    expect(legalNextServiceStatuses('draft')).toEqual(['planned', 'cancelled']);
    expect(legalNextServiceStatuses('planned')).toEqual(['confirmed', 'cancelled']);
    expect(legalNextServiceStatuses('confirmed')).toEqual(['active', 'cancelled']);
    expect(legalNextServiceStatuses('active')).toEqual(['completed', 'cancelled']);
  });

  test('offers no transitions from terminal statuses and cancellation from every other status', () => {
    for (const status of serviceStatuses) {
      const next = legalNextServiceStatuses(status);
      if (status === 'completed' || status === 'cancelled') expect(next).toEqual([]);
      else expect(next).toContain('cancelled');
    }
  });
});
