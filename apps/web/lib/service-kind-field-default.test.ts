import { describe, expect, test } from 'bun:test';

import { emptyFieldValueFormState, fromServiceFieldValue, toServiceFieldValue } from './field-value-form';

describe('service kind field default values', () => {
  test('maps every default kind to its typed service value', () => {
    expect(toServiceFieldValue({ kind: 'text', value: 'x' })).toEqual({ kind: 'text', value: 'x' });
    expect(toServiceFieldValue({ kind: 'longText', value: 'x' })).toEqual({ kind: 'longText', value: 'x' });
    expect(toServiceFieldValue({ kind: 'number', value: '4.5' })).toEqual({ kind: 'number', value: 4.5 });
    expect(toServiceFieldValue({ kind: 'boolean', value: true })).toEqual({ kind: 'boolean', value: true });
    expect(toServiceFieldValue({ kind: 'date', value: '2026-02-03' })).toEqual({ kind: 'date', value: '2026-02-03' });
    expect(toServiceFieldValue({ kind: 'time', value: '09:05' })).toEqual({ kind: 'time', value: '09:05' });
    expect(toServiceFieldValue({ kind: 'datetime', date: '2026-02-03', time: '09:05' })?.kind).toBe('datetime');
    expect(toServiceFieldValue({ kind: 'select', optionId: 'a' })).toEqual({ kind: 'select', optionId: 'a' });
    expect(toServiceFieldValue({ kind: 'multiSelect', optionIds: ['a'] })).toEqual({
      kind: 'multiSelect',
      optionIds: ['a'],
    });
    expect(emptyFieldValueFormState('location')).toEqual({ kind: 'location' });
  });

  test('keeps calendar and clock strings strict and datetime numeric', () => {
    expect(toServiceFieldValue({ kind: 'date', value: '2026-02-30' })).toBeUndefined();
    expect(toServiceFieldValue({ kind: 'time', value: '25:00' })).toBeUndefined();
    const datetime = toServiceFieldValue({ kind: 'datetime', date: '2026-02-03', time: '09:05' });
    expect(datetime?.kind === 'datetime' && typeof datetime.value).toBe('number');
    expect(fromServiceFieldValue({ kind: 'date', value: '2026-02-03' })).toEqual({ kind: 'date', value: '2026-02-03' });
    expect(fromServiceFieldValue({ kind: 'time', value: '09:05' })).toEqual({ kind: 'time', value: '09:05' });
  });

  test('preserves first-twelve-day calendar strings and wall-clock times', () => {
    expect(toServiceFieldValue({ kind: 'date', value: '2026-03-07' })).toEqual({ kind: 'date', value: '2026-03-07' });
    expect(fromServiceFieldValue({ kind: 'date', value: '2026-11-12' })).toEqual({ kind: 'date', value: '2026-11-12' });
    expect(fromServiceFieldValue({ kind: 'time', value: '04:09' })).toEqual({ kind: 'time', value: '04:09' });
  });
});
