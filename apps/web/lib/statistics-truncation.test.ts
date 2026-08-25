import { describe, expect, test } from 'bun:test';

import { formatTruncatableValue, hasOccupancySample, hasSemanticData } from './statistics-truncation';

describe('formatTruncatableValue', () => {
  test('an exact value renders with no suffix', () => {
    expect(formatTruncatableValue('en-US', { value: 42, isTruncated: false })).toBe('42');
  });

  test('a truncated value always renders the "+" suffix — this is the honesty guarantee', () => {
    expect(formatTruncatableValue('en-US', { value: 500, isTruncated: true })).toBe('500+');
  });

  test('locale-appropriate thousands separators are used for both exact and truncated values', () => {
    expect(formatTruncatableValue('en-US', { value: 1500, isTruncated: false })).toBe('1,500');
    expect(formatTruncatableValue('es-CO', { value: 1500, isTruncated: true })).toBe('1.500+');
  });

  test('a zero value with isTruncated somehow true still renders the suffix (never silently dropped)', () => {
    // Not a real backend shape, but the formatter must not special-case it away.
    expect(formatTruncatableValue('en-US', { value: 0, isTruncated: true })).toBe('0+');
  });
});

describe('hasSemanticData / hasOccupancySample', () => {
  test('zero eventCount reads as no data', () => {
    expect(hasSemanticData({ value: 0, isTruncated: false })).toBe(false);
  });

  test('any positive eventCount reads as having data', () => {
    expect(hasSemanticData({ value: 1, isTruncated: false })).toBe(true);
  });

  test('zero sampleSize reads as no occupancy sample', () => {
    expect(hasOccupancySample(0)).toBe(false);
  });

  test('any positive sampleSize reads as having a sample', () => {
    expect(hasOccupancySample(3)).toBe(true);
  });
});
