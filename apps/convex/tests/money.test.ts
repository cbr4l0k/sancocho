import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';

import type { ErrorCode } from '../convex/lib/errors';
import { assertMinorUnits, maxMinorUnits, multiply, subtract, sum } from '../convex/lib/money';
import { currencyValidator } from '../convex/validators';

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

describe('money vocabulary', () => {
  test('currency validator contains exactly the code-owned currencies', () => {
    expect(currencyValidator.members.map((member) => member.value)).toEqual(['COP', 'USD', 'EUR', 'MXN']);
  });
});

describe('assertMinorUnits', () => {
  test('rejects a non-integer amount with a stable code', () => {
    expectErrorCode(() => assertMinorUnits(1.5), 'moneyAmountNotInteger');
  });

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s with the non-finite stable code', (_label, amount) => {
    expectErrorCode(() => assertMinorUnits(amount), 'moneyAmountNotFinite');
  });

  test('rejects a negative amount in the non-negative input context', () => {
    expectErrorCode(() => assertMinorUnits(-1), 'moneyAmountNegative');
  });

  test('accepts the safe-integer boundary and rejects the next integer', () => {
    expect(() => assertMinorUnits(maxMinorUnits)).not.toThrow();
    expectErrorCode(() => assertMinorUnits(maxMinorUnits + 1), 'moneyAmountOutOfRange');
  });
});

describe('checked arithmetic', () => {
  test('multiply is exact at the boundary and rejects overflow', () => {
    expect(multiply(maxMinorUnits, 1)).toBe(maxMinorUnits);
    expect(multiply(81000000, 3)).toBe(243000000);
    expectErrorCode(() => multiply(maxMinorUnits, 2), 'moneyArithmeticOverflow');
  });

  test('multiply rejects a non-integer quantity', () => {
    expectErrorCode(() => multiply(100, 1.5), 'moneyQuantityInvalid');
  });

  test('sum validates every element even when the final arithmetic would be valid', () => {
    expectErrorCode(() => sum([5, -1]), 'moneyAmountNegative');
  });

  test('sum is exact and rejects an overflowing intermediate result', () => {
    expect(sum([81000000, 28000000, 9500000])).toBe(118500000);
    expectErrorCode(() => sum([maxMinorUnits, 1]), 'moneyArithmeticOverflow');
  });

  test('subtract is exact and deliberately permits a negative result', () => {
    expect(subtract(243000000, 28000000)).toBe(215000000);
    expect(subtract(28000000, 243000000)).toBe(-215000000);
  });

  test('repeated chained arithmetic remains exactly equal without drift', () => {
    let accumulated = 0;
    for (let index = 0; index < 1000; index += 1) {
      accumulated = sum([accumulated, multiply(101, 3)]);
    }

    expect(accumulated).toBe(303000);
    expect(subtract(accumulated, multiply(101, 3000))).toBe(0);
  });
});
