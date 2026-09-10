import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';

import type { ErrorCode } from '../lib/errors';
import { maxMinorUnits } from '../lib/money';
import { assignmentNet, lineTotal } from './costing';

function expectErrorCode(operation: () => unknown, code: ErrorCode): void {
  try {
    operation();
  } catch (error: unknown) {
    if (!(error instanceof ConvexError)) throw error;
    expect(error.data).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ConvexError code ${code}`);
}

const invalidAmounts = [
  ['negative', -1, 'moneyAmountNegative'],
  ['fractional', 1.5, 'moneyAmountNotInteger'],
  ['NaN', Number.NaN, 'moneyAmountNotFinite'],
  ['Infinity', Number.POSITIVE_INFINITY, 'moneyAmountNotFinite'],
  ['negative Infinity', Number.NEGATIVE_INFINITY, 'moneyAmountNotFinite'],
  ['out-of-range', maxMinorUnits + 1, 'moneyAmountOutOfRange'],
] as const satisfies ReadonlyArray<readonly [string, number, ErrorCode]>;

const invalidQuantities = [
  ['negative', -1],
  ['fractional', 1.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['negative Infinity', Number.NEGATIVE_INFINITY],
  ['out-of-range', maxMinorUnits + 1],
] as const;

describe('lineTotal', () => {
  test('multiplies integer minor units exactly', () => {
    expect(lineTotal(81_000_000, 3)).toBe(243_000_000);
    expect(lineTotal(0, 9)).toBe(0);
  });

  test.each(invalidAmounts)('rejects a %s unitAmount', (_label, unitAmount, code) => {
    expectErrorCode(() => lineTotal(unitAmount, 1), code);
  });

  test.each(invalidQuantities)('rejects a %s quantity', (_label, quantity) => {
    expectErrorCode(() => lineTotal(1, quantity), 'moneyQuantityInvalid');
  });

  test('rejects multiplication overflow', () => {
    expectErrorCode(() => lineTotal(maxMinorUnits, 2), 'moneyArithmeticOverflow');
  });
});

describe('assignmentNet', () => {
  test('treats zero and absent notExecutedAmount identically', () => {
    expect(assignmentNet({ lineTotal: 1_000, notExecutedAmount: 0, additionalCharges: 250 })).toBe(1_250);
    expect(assignmentNet({ lineTotal: 1_000, additionalCharges: 250 })).toBe(1_250);
  });

  test('defaults absent additionalCharges to zero', () => {
    expect(assignmentNet({ lineTotal: 1_000, notExecutedAmount: 250 })).toBe(750);
  });

  test('accepts a notExecutedAmount equal to lineTotal as a zero net', () => {
    expect(assignmentNet({ lineTotal: 1_000, notExecutedAmount: 1_000 })).toBe(0);
  });

  test('rejects a notExecutedAmount greater than the line total when nothing offsets it', () => {
    expectErrorCode(
      () => assignmentNet({ lineTotal: 1_000, notExecutedAmount: 1_001 }),
      'moneyAmountNegative',
    );
  });

  // The two cases below are the whole reason the operation order is
  // `(lineTotal + additionalCharges) - notExecutedAmount` and not
  // `(lineTotal - notExecutedAmount) + additionalCharges`. Both orders agree
  // whenever `additionalCharges` is zero, which is every other case here, so
  // without these the order would be unspecified in practice.
  test('additionalCharges widen the total a notExecutedAmount may consume', () => {
    // Subtracting first would reject this on a negative intermediate, even
    // though the amount actually payable is a perfectly valid 500.
    expect(assignmentNet({ lineTotal: 1_000, additionalCharges: 1_000, notExecutedAmount: 1_500 })).toBe(500);
  });

  test('rejects an overflowing intermediate even when the net would fit', () => {
    // The conservative direction of the same choice: the sum is checked before
    // the reduction, so an unrepresentable intermediate is refused rather than
    // silently cancelled out.
    expectErrorCode(
      () => assignmentNet({ lineTotal: maxMinorUnits, additionalCharges: 1_000, notExecutedAmount: 1_000 }),
      'moneyArithmeticOverflow',
    );
  });

  test.each(invalidAmounts)('rejects a %s lineTotal', (_label, agreedLineTotal, code) => {
    expectErrorCode(() => assignmentNet({ lineTotal: agreedLineTotal }), code);
  });

  test.each(invalidAmounts)('rejects a %s notExecutedAmount', (_label, notExecutedAmount, code) => {
    expectErrorCode(() => assignmentNet({ lineTotal: 10, notExecutedAmount }), code);
  });

  test.each(invalidAmounts)('rejects %s additionalCharges', (_label, additionalCharges, code) => {
    expectErrorCode(() => assignmentNet({ lineTotal: 10, additionalCharges }), code);
  });

  test('rejects addition overflow', () => {
    expectErrorCode(
      () => assignmentNet({ lineTotal: maxMinorUnits, additionalCharges: 1 }),
      'moneyArithmeticOverflow',
    );
  });
});
