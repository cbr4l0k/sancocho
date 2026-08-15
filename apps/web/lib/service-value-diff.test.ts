import { describe, expect, test } from 'bun:test';

import type { EventFieldValue } from './field-value-form';
import { changedEventFieldValues } from './service-value-diff';

type ValueCase = {
  unchanged: EventFieldValue;
  changed: EventFieldValue;
};

type LocationId = Extract<EventFieldValue, { kind: 'location' }>['locationId'];

/** Branded ids cannot be constructed at runtime; a fixture cast is the honest way to make one. */
function locationId(value: string): LocationId {
  return value as LocationId;
}

const valueCases: Record<EventFieldValue['kind'], ValueCase> = {
  text: {
    unchanged: { kind: 'text', value: 'Original' },
    changed: { kind: 'text', value: 'Updated' },
  },
  longText: {
    unchanged: { kind: 'longText', value: 'Original notes' },
    changed: { kind: 'longText', value: 'Updated notes' },
  },
  number: {
    unchanged: { kind: 'number', value: 12 },
    changed: { kind: 'number', value: 16 },
  },
  boolean: {
    unchanged: { kind: 'boolean', value: false },
    changed: { kind: 'boolean', value: true },
  },
  date: {
    unchanged: { kind: 'date', value: '2026-08-15' },
    changed: { kind: 'date', value: '2026-08-16' },
  },
  time: {
    unchanged: { kind: 'time', value: '09:00' },
    changed: { kind: 'time', value: '10:00' },
  },
  datetime: {
    unchanged: { kind: 'datetime', value: 1_786_752_000_000 },
    changed: { kind: 'datetime', value: 1_786_755_600_000 },
  },
  select: {
    unchanged: { kind: 'select', optionId: 'original-option' },
    changed: { kind: 'select', optionId: 'updated-option' },
  },
  multiSelect: {
    unchanged: { kind: 'multiSelect', optionIds: ['first-option', 'second-option'] },
    changed: { kind: 'multiSelect', optionIds: ['first-option', 'third-option'] },
  },
  location: {
    unchanged: { kind: 'location', locationId: locationId('archived-location') },
    changed: { kind: 'location', locationId: locationId('updated-location') },
  },
};

describe('changedEventFieldValues', () => {
  test.each(Object.entries(valueCases))('%s values omit an unchanged value and emit a changed value', (_, valueCase) => {
    const original = new Map<string, EventFieldValue>([['field', valueCase.unchanged]]);

    expect(changedEventFieldValues(original, new Map([['field', valueCase.unchanged]]))).toEqual([]);
    expect(changedEventFieldValues(original, new Map([['field', valueCase.changed]]))).toEqual([
      { fieldDefinitionId: 'field', value: valueCase.changed },
    ]);
  });

  test('does not resubmit an untouched archived-location value', () => {
    const original = new Map<string, EventFieldValue>([['pickup', valueCases.location.unchanged]]);
    const edited = new Map<string, EventFieldValue | undefined>([['pickup', valueCases.location.unchanged]]);

    expect(changedEventFieldValues(original, edited)).toEqual([]);
  });

  test('emits multi-select values when their members, length, or order differ', () => {
    const original = new Map<string, EventFieldValue>([
      ['different-member', { kind: 'multiSelect', optionIds: ['first-option', 'second-option'] }],
      ['different-length', { kind: 'multiSelect', optionIds: ['first-option', 'second-option'] }],
      ['different-order', { kind: 'multiSelect', optionIds: ['first-option', 'second-option'] }],
    ]);
    const edited = new Map<string, EventFieldValue | undefined>([
      ['different-member', { kind: 'multiSelect', optionIds: ['first-option', 'third-option'] }],
      ['different-length', { kind: 'multiSelect', optionIds: ['first-option'] }],
      ['different-order', { kind: 'multiSelect', optionIds: ['second-option', 'first-option'] }],
    ]);

    expect(changedEventFieldValues(original, edited)).toEqual([
      {
        fieldDefinitionId: 'different-member',
        value: { kind: 'multiSelect', optionIds: ['first-option', 'third-option'] },
      },
      {
        fieldDefinitionId: 'different-length',
        value: { kind: 'multiSelect', optionIds: ['first-option'] },
      },
      {
        fieldDefinitionId: 'different-order',
        value: { kind: 'multiSelect', optionIds: ['second-option', 'first-option'] },
      },
    ]);
  });

  test('uses null to clear a stored optional value', () => {
    const original = new Map<string, EventFieldValue>([['notes', { kind: 'text', value: 'Keep no more' }]]);
    const edited = new Map<string, EventFieldValue | undefined>([['notes', undefined]]);

    expect(changedEventFieldValues(original, edited)).toEqual([{ fieldDefinitionId: 'notes', value: null }]);
  });

  test('omits a field absent from both sides', () => {
    expect(changedEventFieldValues(new Map(), new Map([['new-field', undefined]]))).toEqual([]);
  });
});
