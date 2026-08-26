import { describe, expect, test } from 'bun:test';

import { datetimeDateBounds, fieldInputBounds } from './field-input-bounds';

describe('fieldInputBounds', () => {
  test('carries a number field’s configured range onto the control', () => {
    expect(fieldInputBounds({ kind: 'number', min: 1, max: 8 })).toEqual({ min: 1, max: 8 });
  });

  test('steps whole numbers for an integer-only field', () => {
    expect(fieldInputBounds({ kind: 'number', integer: true })).toEqual({ step: 1 });
    expect(fieldInputBounds({ kind: 'number' })).toEqual({});
  });

  test('passes date and time bounds through as the strings they are stored as', () => {
    expect(fieldInputBounds({ kind: 'date', min: '2026-08-15', max: '2026-08-19' })).toEqual({
      min: '2026-08-15',
      max: '2026-08-19',
    });
    expect(fieldInputBounds({ kind: 'time', min: '06:00' })).toEqual({ min: '06:00' });
  });

  test('limits text length where the snapshot does', () => {
    expect(fieldInputBounds({ kind: 'text', maxLength: 40 })).toEqual({ maxLength: 40 });
    expect(fieldInputBounds({ kind: 'longText' })).toEqual({});
  });

  test('leaves option-based and reference fields unbounded', () => {
    expect(fieldInputBounds({ kind: 'select', options: [] })).toEqual({});
    expect(fieldInputBounds({ kind: 'boolean' })).toEqual({});
    expect(fieldInputBounds({ kind: 'location' })).toEqual({});
    // A datetime's bounds are timestamps; they belong to the date half.
    expect(fieldInputBounds({ kind: 'datetime', min: 0 })).toEqual({});
  });
});

describe('datetimeDateBounds', () => {
  test('reduces timestamp bounds to local calendar days', () => {
    const min = new Date(2026, 7, 15, 16, 0).getTime();
    const max = new Date(2026, 7, 19, 16, 0).getTime();
    expect(datetimeDateBounds({ kind: 'datetime', min, max })).toEqual({ min: '2026-08-15', max: '2026-08-19' });
  });

  test('is empty for anything that is not a datetime', () => {
    expect(datetimeDateBounds({ kind: 'date', min: '2026-08-15' })).toEqual({});
  });
});
