import type { fieldConfigValidator } from '@priamo/convex/validators';
import { describe, expect, test } from 'bun:test';

import { formatFieldValue } from './field-value-format';

type FieldConfig = typeof fieldConfigValidator.type;
type LocationId = Extract<Parameters<typeof formatFieldValue>[2], { kind: 'location' }>['locationId'];

const missing = '—';
const somewhere = 'k17abc' as LocationId;

const selectConfig: FieldConfig = { kind: 'select', options: [{ id: 'van', label: 'Van' }] };
const multiConfig: FieldConfig = {
  kind: 'multiSelect',
  options: [
    { id: 'a', label: 'Silla de ruedas' },
    { id: 'b', label: 'Equipaje extra' },
  ],
};

describe('formatFieldValue', () => {
  test('resolves select labels through the snapshot, not the raw id', () => {
    expect(formatFieldValue('es-CO', selectConfig, { kind: 'select', optionId: 'van' }, missing)).toBe('Van');
  });

  test('falls back rather than printing an id the snapshot no longer knows', () => {
    expect(formatFieldValue('es-CO', selectConfig, { kind: 'select', optionId: 'bus' }, missing)).toBe(missing);
  });

  test('joins multi-select labels in stored order', () => {
    expect(formatFieldValue('es-CO', multiConfig, { kind: 'multiSelect', optionIds: ['b', 'a'] }, missing)).toBe(
      'Equipaje extra, Silla de ruedas',
    );
  });

  test('names a location instead of showing its id', () => {
    expect(
      formatFieldValue('es-CO', { kind: 'location' }, { kind: 'location', locationId: somewhere }, missing, 'Terminal T2'),
    ).toBe('Terminal T2');
  });

  test('falls back when a location cannot be named', () => {
    expect(formatFieldValue('es-CO', { kind: 'location' }, { kind: 'location', locationId: somewhere }, missing)).toBe(
      missing,
    );
  });

  test('renders text and booleans without locale machinery', () => {
    expect(formatFieldValue('en-US', { kind: 'text' }, { kind: 'text', value: 'T2' }, missing)).toBe('T2');
    expect(formatFieldValue('en-US', { kind: 'boolean' }, { kind: 'boolean', value: true }, missing)).toBe('✓');
    expect(formatFieldValue('en-US', { kind: 'boolean' }, { kind: 'boolean', value: false }, missing)).toBe('—');
  });

  test('falls back when the value and its snapshot disagree on kind', () => {
    // Corruption rather than a display case: refuse to guess a label source.
    expect(formatFieldValue('es-CO', { kind: 'text' }, { kind: 'select', optionId: 'van' }, missing)).toBe(missing);
  });

  test('formats a date without drifting to the previous day', () => {
    expect(formatFieldValue('en-US', { kind: 'date' }, { kind: 'date', value: '2026-08-15' }, missing)).toContain('15');
  });
});
