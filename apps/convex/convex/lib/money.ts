import { invalidInput } from './errors';

/**
 * Largest supported absolute money value, in minor units.
 *
 * JavaScript represents every integer from `-Number.MAX_SAFE_INTEGER` through
 * `Number.MAX_SAFE_INTEGER` exactly. Keeping money inside that closed interval
 * makes numeric equality reliable and lets every helper reject a result before
 * a rounded integer could enter the domain.
 */
export const maxMinorUnits = Number.MAX_SAFE_INTEGER;

/**
 * Asserts that `amount` is a finite, non-negative integer inside the supported
 * exact-integer range. This is the shared boundary for persisted money inputs.
 */
export function assertMinorUnits(amount: number): void {
  if (!Number.isFinite(amount)) {
    return invalidInput('moneyAmountNotFinite', 'Money amount must be finite');
  }
  if (!Number.isInteger(amount)) {
    return invalidInput('moneyAmountNotInteger', 'Money amount must be an integer');
  }
  if (amount < 0) {
    return invalidInput('moneyAmountNegative', 'Money amount must not be negative');
  }
  if (amount > maxMinorUnits) {
    return invalidInput('moneyAmountOutOfRange', 'Money amount exceeds the supported exact-integer range');
  }
}

/** Multiplies a non-negative money amount by a non-negative integer quantity. */
export function multiply(amount: number, quantity: number): number {
  assertMinorUnits(amount);
  assertQuantity(quantity);

  const result = amount * quantity;
  return assertExactResult(result);
}

/** Adds non-negative money amounts, checking every input and intermediate result. */
export function sum(amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) {
    assertMinorUnits(amount);
    total = assertExactResult(total + amount);
  }
  return total;
}

/**
 * Subtracts two non-negative money amounts.
 *
 * The result MAY be negative: this helper expresses a signed difference, not a
 * persistable non-negative amount. Callers that persist the result in a domain
 * that forbids negatives must pass it through `assertMinorUnits` first.
 */
export function subtract(left: number, right: number): number {
  assertMinorUnits(left);
  assertMinorUnits(right);
  return assertExactResult(left - right);
}

function assertQuantity(quantity: number): void {
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0 || quantity > Number.MAX_SAFE_INTEGER) {
    return invalidInput('moneyQuantityInvalid', 'Money quantity must be a non-negative safe integer');
  }
}

function assertExactResult(result: number): number {
  if (!Number.isSafeInteger(result)) {
    return invalidInput('moneyArithmeticOverflow', 'Money arithmetic result exceeds the supported exact-integer range');
  }
  return result;
}
