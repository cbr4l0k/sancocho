import { describe, expect, test } from 'bun:test';

import { emptyFieldValueFormState, fromEventFieldValue, toEventFieldValue } from './field-value-form';

describe('recipe field default values', () => {
  test('maps every default kind to its typed event value', () => {
    expect(toEventFieldValue({ kind: 'text', value: 'x' })).toEqual({ kind: 'text', value: 'x' });
    expect(toEventFieldValue({ kind: 'longText', value: 'x' })).toEqual({ kind: 'longText', value: 'x' });
    expect(toEventFieldValue({ kind: 'number', value: '4.5' })).toEqual({ kind: 'number', value: 4.5 });
    expect(toEventFieldValue({ kind: 'boolean', value: true })).toEqual({ kind: 'boolean', value: true });
    expect(toEventFieldValue({ kind: 'date', value: '2026-02-03' })).toEqual({ kind: 'date', value: '2026-02-03' });
    expect(toEventFieldValue({ kind: 'time', value: '09:05' })).toEqual({ kind: 'time', value: '09:05' });
    expect(toEventFieldValue({ kind: 'datetime', date: '2026-02-03', time: '09:05' })?.kind).toBe('datetime');
    expect(toEventFieldValue({ kind: 'select', optionId: 'a' })).toEqual({ kind: 'select', optionId: 'a' });
    expect(toEventFieldValue({ kind: 'multiSelect', optionIds: ['a'] })).toEqual({
      kind: 'multiSelect',
      optionIds: ['a'],
    });
    expect(emptyFieldValueFormState('location')).toEqual({ kind: 'location' });
  });

  test('keeps calendar and clock strings strict and datetime numeric', () => {
    expect(toEventFieldValue({ kind: 'date', value: '2026-02-30' })).toBeUndefined();
    expect(toEventFieldValue({ kind: 'time', value: '25:00' })).toBeUndefined();
    const datetime = toEventFieldValue({ kind: 'datetime', date: '2026-02-03', time: '09:05' });
    expect(datetime?.kind === 'datetime' && typeof datetime.value).toBe('number');
    expect(fromEventFieldValue({ kind: 'date', value: '2026-02-03' })).toEqual({ kind: 'date', value: '2026-02-03' });
    expect(fromEventFieldValue({ kind: 'time', value: '09:05' })).toEqual({ kind: 'time', value: '09:05' });
  });

  test('preserves first-twelve-day calendar strings and wall-clock times', () => {
    expect(toEventFieldValue({ kind: 'date', value: '2026-03-07' })).toEqual({ kind: 'date', value: '2026-03-07' });
    expect(fromEventFieldValue({ kind: 'date', value: '2026-11-12' })).toEqual({ kind: 'date', value: '2026-11-12' });
    expect(fromEventFieldValue({ kind: 'time', value: '04:09' })).toEqual({ kind: 'time', value: '04:09' });
  });
});
