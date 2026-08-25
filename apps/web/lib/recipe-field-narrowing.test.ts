import { expect, test } from 'bun:test';

import type { FieldDataType } from '@priamo/convex/validators';

import { clampConfigToBound, type FieldConfig } from './recipe-field-narrowing';

const narrowingCases: Record<FieldDataType, () => void> = {
  text: () => {
    const bound: FieldConfig = { kind: 'text', minLength: 2, maxLength: 10 };
    const valid: FieldConfig = { kind: 'text', minLength: 4, maxLength: 8 };
    expect(clampConfigToBound(valid, bound)).toEqual(valid);
    expect(clampConfigToBound({ kind: 'text', minLength: 1, maxLength: 12 }, bound)).toEqual({
      kind: 'text',
      minLength: 2,
      maxLength: 10,
    });
    expect(clampConfigToBound({ kind: 'text' }, bound)).toEqual({ kind: 'text', minLength: 2, maxLength: 10 });
  },
  longText: () => {
    const bound: FieldConfig = { kind: 'longText', minLength: 20, maxLength: 200 };
    const valid: FieldConfig = { kind: 'longText', minLength: 40, maxLength: 100 };
    expect(clampConfigToBound(valid, bound)).toEqual(valid);
    expect(clampConfigToBound({ kind: 'longText', minLength: 10, maxLength: 300 }, bound)).toEqual({
      kind: 'longText',
      minLength: 20,
      maxLength: 200,
    });
    expect(clampConfigToBound({ kind: 'longText' }, bound)).toEqual({
      kind: 'longText',
      minLength: 20,
      maxLength: 200,
    });
  },
  number: () => {
    const bound: FieldConfig = { kind: 'number', min: 2, max: 10, integer: true };
    const valid: FieldConfig = { kind: 'number', min: 4, max: 8, integer: true };
    expect(clampConfigToBound(valid, bound)).toEqual(valid);
    expect(clampConfigToBound({ kind: 'number', min: 1, max: 12 }, bound)).toEqual({
      kind: 'number',
      min: 2,
      max: 10,
      integer: true,
    });
    expect(clampConfigToBound({ kind: 'number' }, bound)).toEqual({ kind: 'number', min: 2, max: 10, integer: true });
  },
  boolean: () => {
    const config: FieldConfig = { kind: 'boolean' };
    const bound: FieldConfig = { kind: 'boolean' };
    expect(clampConfigToBound(config, bound)).toBe(config);
  },
  date: () => {
    const bound: FieldConfig = { kind: 'date', min: '2026-02-03', max: '2026-12-31' };
    const valid: FieldConfig = { kind: 'date', min: '2026-03-01', max: '2026-11-30' };
    expect(clampConfigToBound(valid, bound)).toEqual(valid);
    const clamped = clampConfigToBound({ kind: 'date', min: '2026-01-01', max: '2027-01-01' }, bound);
    expect(clamped).toEqual({ kind: 'date', min: '2026-02-03', max: '2026-12-31' });
    if (clamped.kind !== 'date') throw new Error('Expected a date config');
    expect(typeof clamped.min).toBe('string');
    expect(typeof clamped.max).toBe('string');
    expect(clampConfigToBound({ kind: 'date' }, bound)).toEqual({ kind: 'date', min: '2026-02-03', max: '2026-12-31' });
  },
  datetime: () => {
    const bound: FieldConfig = { kind: 'datetime', min: 1_000, max: 2_000 };
    const valid: FieldConfig = { kind: 'datetime', min: 1_200, max: 1_800 };
    expect(clampConfigToBound(valid, bound)).toEqual(valid);
    const clamped = clampConfigToBound({ kind: 'datetime', min: 500, max: 2_500 }, bound);
    expect(clamped).toEqual({ kind: 'datetime', min: 1_000, max: 2_000 });
    if (clamped.kind !== 'datetime') throw new Error('Expected a datetime config');
    expect(typeof clamped.min).toBe('number');
    expect(typeof clamped.max).toBe('number');
    expect(clampConfigToBound({ kind: 'datetime' }, bound)).toEqual({ kind: 'datetime', min: 1_000, max: 2_000 });
  },
  time: () => {
    const bound: FieldConfig = { kind: 'time', min: '09:00', max: '17:00' };
    const valid: FieldConfig = { kind: 'time', min: '10:00', max: '16:00' };
    expect(clampConfigToBound(valid, bound)).toEqual(valid);
    const clamped = clampConfigToBound({ kind: 'time', min: '08:00', max: '18:00' }, bound);
    expect(clamped).toEqual({ kind: 'time', min: '09:00', max: '17:00' });
    if (clamped.kind !== 'time') throw new Error('Expected a time config');
    expect(typeof clamped.min).toBe('string');
    expect(typeof clamped.max).toBe('string');
    expect(clampConfigToBound({ kind: 'time' }, bound)).toEqual({ kind: 'time', min: '09:00', max: '17:00' });
  },
  select: () => {
    const bound: FieldConfig = {
      kind: 'select',
      options: [
        { id: 'one', label: 'One' },
        { id: 'two', label: 'Two' },
      ],
    };
    const valid: FieldConfig = { kind: 'select', options: [{ id: 'one', label: 'Recipe one' }] };
    expect(clampConfigToBound(valid, bound)).toEqual(valid);
    expect(
      clampConfigToBound(
        { kind: 'select', options: [{ id: 'one', label: 'Recipe one' }, { id: 'removed', label: 'Removed' }] },
        bound,
      ),
    ).toEqual({ kind: 'select', options: [{ id: 'one', label: 'Recipe one' }] });
  },
  multiSelect: () => {
    const bound: FieldConfig = {
      kind: 'multiSelect',
      options: [
        { id: 'one', label: 'One' },
        { id: 'two', label: 'Two' },
      ],
      minSelections: 1,
      maxSelections: 2,
    };
    const valid: FieldConfig = {
      kind: 'multiSelect',
      options: [{ id: 'one', label: 'Recipe one' }],
      minSelections: 1,
      maxSelections: 1,
    };
    expect(clampConfigToBound(valid, bound)).toEqual(valid);
    expect(
      clampConfigToBound(
        {
          kind: 'multiSelect',
          options: [{ id: 'one', label: 'Recipe one' }, { id: 'removed', label: 'Removed' }],
          minSelections: 0,
          maxSelections: 3,
        },
        bound,
      ),
    ).toEqual({
      kind: 'multiSelect',
      options: [{ id: 'one', label: 'Recipe one' }],
      minSelections: 1,
      maxSelections: 2,
    });
    expect(clampConfigToBound({ kind: 'multiSelect', options: [] }, bound)).toEqual({
      kind: 'multiSelect',
      options: [],
      minSelections: 1,
      maxSelections: 2,
    });
  },
  location: () => {
    const config: FieldConfig = { kind: 'location' };
    const bound: FieldConfig = { kind: 'location' };
    expect(clampConfigToBound(config, bound)).toBe(config);
  },
};

for (const [kind, run] of Object.entries(narrowingCases)) {
  test(`clamps ${kind} config inside the definition envelope`, run);
}
