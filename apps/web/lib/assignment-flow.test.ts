import { expect, test } from 'bun:test';

import {
  assignmentRateState,
  nextAssignmentPosition,
  parseQuantity,
  readExecutionStatus,
  readModality,
  repriceAssignment,
  type ResolvedAssignmentRate,
} from './assignment-flow';

const resolvedRate = {
  kind: 'resolved',
  rateCardId: 'card-1',
  rateCardName: 'Principal',
  rateCardVersionId: 'version-1',
  rateLineId: 'line-1',
  unitAmount: 25_000,
  currency: 'COP',
} as ResolvedAssignmentRate;

test('a resolved rate exposes the literal unit-times-quantity line total', () => {
  expect(assignmentRateState(resolvedRate, 10)).toEqual({
    kind: 'resolved',
    rate: resolvedRate,
    lineTotal: 250_000,
  });
});

test('rate state waits when the resolution is missing', () => {
  expect(assignmentRateState(undefined, 2)).toEqual({ kind: 'waiting' });
});

test('rate state waits when the quantity is missing', () => {
  expect(assignmentRateState(resolvedRate, undefined)).toEqual({ kind: 'waiting' });
});

test('no Rate Line is a recoverable configuration gap and cannot become submittable', () => {
  expect(assignmentRateState({ kind: 'unpriceable', reason: 'noRateLine' }, 2)).toEqual({
    kind: 'configurationGap',
    reason: 'noRateLine',
  });
});

test('an ambiguous answer stays non-submittable and preserves every competing card', () => {
  const candidates = [{
    rateCardId: 'card-1',
    rateCardName: 'Aeropuerto 2026',
    rateCardVersionId: 'version-1',
    unitAmount: 20_000,
    currency: 'COP',
  }] as Extract<Parameters<typeof assignmentRateState>[0], { kind: 'ambiguous' }>['candidates'];
  expect(assignmentRateState({ kind: 'ambiguous', candidates }, 1)).toEqual({ kind: 'ambiguous', candidates });
});

test('reprice creates an immutable Revision and has no commercial patch path', async () => {
  const calls: string[] = [];
  await repriceAssignment({
    assignmentId: 'assignment-1' as Parameters<typeof repriceAssignment>[0]['assignmentId'],
    vehicleClassId: 'class-1' as Parameters<typeof repriceAssignment>[0]['vehicleClassId'],
    modality: 'fixed',
    quantity: 2,
    rate: resolvedRate,
    createRevision: async (args) => {
      calls.push(`create:${args.assignmentId}:${args.rateLineId}:${args.quantity}`);
      return 'revision-1' as Awaited<ReturnType<Parameters<typeof repriceAssignment>[0]['createRevision']>>;
    },
  });
  expect(calls).toEqual(['create:assignment-1:line-1:2']);
});

test('quantity parsing accepts only positive safe integers', () => {
  expect(parseQuantity(' 12 ')).toBe(12);
  expect(parseQuantity('0')).toBeUndefined();
  expect(parseQuantity('-1')).toBeUndefined();
  expect(parseQuantity('1.5')).toBeUndefined();
  expect(parseQuantity('9007199254740992')).toBeUndefined();
});

test('modality reading returns only backend-owned modalities', () => {
  expect(readModality('fixed')).toBe('fixed');
  expect(readModality('invented')).toBeUndefined();
});

test('execution status reading returns only a currently allowed transition', () => {
  const allowed = ['assigned', 'confirmed'] as const;
  expect(readExecutionStatus(allowed, 'confirmed')).toBe('confirmed');
  expect(readExecutionStatus(allowed, 'completed')).toBeUndefined();
});

test('next Assignment position is zero for an empty panel', () => {
  expect(nextAssignmentPosition([])).toBe(0);
});

test('next Assignment position is one after the greatest existing position', () => {
  expect(nextAssignmentPosition([
    { assignment: { position: 4 } },
    { assignment: { position: 1 } },
    { assignment: { position: 7 } },
  ])).toBe(8);
});
