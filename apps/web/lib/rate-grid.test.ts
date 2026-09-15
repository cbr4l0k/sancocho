import { describe, expect, test } from 'bun:test';

import { rateModalityValidator } from '@priamo/convex/validators';

import { assembleRateGrid, rateCellTransition, rateModalities, rateVersionAffordances } from './rate-grid';

describe('rateCellTransition', () => {
  test('preserves empty, zero, and amount as distinct states', () => {
    expect(rateCellTransition(undefined, '')).toEqual({ kind: 'noop' });
    expect(rateCellTransition(undefined, '0')).toEqual({ kind: 'add', unitAmount: 0 });
    expect(rateCellTransition(0, '')).toEqual({ kind: 'remove' });
    expect(rateCellTransition(12_34, '   ')).toEqual({ kind: 'remove' });
    expect(rateCellTransition(0, '0.00')).toEqual({ kind: 'noop' });
    expect(rateCellTransition(12_34, '12.34')).toEqual({ kind: 'noop' });
    expect(rateCellTransition(12_34, '56.78')).toEqual({ kind: 'update', unitAmount: 56_78 });
    expect(rateCellTransition(undefined, '56.78')).toEqual({ kind: 'add', unitAmount: 56_78 });
  });

  test('returns money parsing failures without turning them into zero', () => {
    expect(rateCellTransition(undefined, '1,234.56')).toEqual({ kind: 'invalid', problem: 'invalid' });
  });

  test('an archived Class cell can only be cleared', () => {
    expect(rateCellTransition(undefined, '', true)).toEqual({ kind: 'noop' });
    expect(rateCellTransition(undefined, '12.34', true)).toEqual({ kind: 'noop' });
    expect(rateCellTransition(12_34, '56.78', true)).toEqual({ kind: 'noop' });
    expect(rateCellTransition(12_34, '', true)).toEqual({ kind: 'remove' });
  });
});

test('the grid columns are the backend modality union, not a copy of it', () => {
  // Pinning the four literals instead would agree with a hand-written copy of
  // the union forever: the copy and the pin would both be wrong together the
  // day the backend gains a fifth modality, the grid would quietly lose a
  // column, and nothing would fail. Comparing against the validator is what
  // makes that day a test failure.
  expect([...rateModalities].sort()).toEqual(rateModalityValidator.members.map((member) => member.value).sort());
  expect(rateModalities).toHaveLength(rateModalityValidator.members.length);
});

test('grid assembly gives every Class every modality and identifies cells by Class plus modality', () => {
  const result = assembleRateGrid(
    [{ _id: 'class-a', name: 'Van', status: 'active' }, { _id: 'class-b', name: 'Bus', status: 'archived' }],
    rateModalities,
    [{ _id: 'line-1', vehicleClassId: 'class-a', modality: 'fixed', unitAmount: 0 }],
  );

  expect(result).toEqual({ ok: true, rows: [
    {
      vehicleClass: { _id: 'class-a', name: 'Van', status: 'active' },
      cells: [
        { vehicleClassId: 'class-a', modality: 'transfer', line: undefined },
        { vehicleClassId: 'class-a', modality: 'disposition', line: undefined },
        { vehicleClassId: 'class-a', modality: 'route', line: undefined },
        {
          vehicleClassId: 'class-a',
          modality: 'fixed',
          line: { _id: 'line-1', vehicleClassId: 'class-a', modality: 'fixed', unitAmount: 0 },
        },
      ],
    },
    {
      vehicleClass: { _id: 'class-b', name: 'Bus', status: 'archived' },
      cells: [
        { vehicleClassId: 'class-b', modality: 'transfer', line: undefined },
        { vehicleClassId: 'class-b', modality: 'disposition', line: undefined },
        { vehicleClassId: 'class-b', modality: 'route', line: undefined },
        { vehicleClassId: 'class-b', modality: 'fixed', line: undefined },
      ],
    },
  ] });
});

test('grid assembly refuses a Rate Line for a Class absent from the row axis', () => {
  expect(
    assembleRateGrid(
      [{ _id: 'class-a', name: 'Van', status: 'active' }],
      ['fixed'],
      [{ _id: 'line-1', vehicleClassId: 'class-missing', modality: 'fixed', unitAmount: 10_00 }],
    ),
  ).toEqual({ ok: false, reason: 'rateGridUnknownVehicleClass' });
});

test('grid assembly reports duplicate cells without throwing', () => {
  expect(assembleRateGrid(
    [{ _id: 'class-a', name: 'Van', status: 'active' }],
    ['fixed'],
    [
      { _id: 'line-1', vehicleClassId: 'class-a', modality: 'fixed', unitAmount: 10_00 },
      { _id: 'line-2', vehicleClassId: 'class-a', modality: 'fixed', unitAmount: 20_00 },
    ],
  )).toEqual({ ok: false, reason: 'rateGridDuplicateCell' });
});

test('grid assembly reports an unknown modality without throwing', () => {
  expect(assembleRateGrid(
    [{ _id: 'class-a', name: 'Van', status: 'active' }],
    ['fixed'],
    [{
      _id: 'line-1',
      vehicleClassId: 'class-a',
      // @ts-expect-error Exercise a malformed persisted row crossing the runtime boundary.
      modality: 'hourly',
      unitAmount: 10_00,
    }],
  )).toEqual({ ok: false, reason: 'rateGridUnknownModality' });
});

test('only draft Versions expose the edit affordance', () => {
  expect(rateVersionAffordances('active', 'draft')).toEqual(['edit']);
  expect(rateVersionAffordances('active', 'published')).toEqual([]);
  expect(rateVersionAffordances('active', 'retired')).toEqual([]);
  expect(rateVersionAffordances('archived', 'draft')).toEqual([]);
});
