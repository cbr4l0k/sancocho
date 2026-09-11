import { describe, expect, test } from 'bun:test';

import { engagementDisplayNumber } from './portal-engagement';

describe('engagementDisplayNumber', () => {
  test('identifies rows only by their place in the loaded list', () => {
    expect(engagementDisplayNumber(0)).toBe('01');
    expect(engagementDisplayNumber(8)).toBe('09');
    expect(engagementDisplayNumber(24)).toBe('25');
  });
});
