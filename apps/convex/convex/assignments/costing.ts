import { assertMinorUnits, multiply, subtract, sum } from '../lib/money';

/**
 * Gives the agreed line amount one domain definition, so its name has a single
 * home and the rule has a direct test target.
 */
export function lineTotal(unitAmount: number, quantity: number): number {
  return multiply(unitAmount, quantity);
}

/**
 * Computes the persistable net amount for an Assignment. A not-executed amount
 * may exceed the line amount, but a net below zero is invalid rather than a
 * negative persisted amount: rejecting it preserves the discrepancy instead of
 * silently losing money through a clamp. The final `assertMinorUnits` reports
 * that invalid state as `moneyAmountNegative`.
 */
export function assignmentNet({
  lineTotal: agreedLineTotal,
  notExecutedAmount = 0,
  additionalCharges = 0,
}: {
  lineTotal: number;
  notExecutedAmount?: number;
  additionalCharges?: number;
}): number {
  const net = subtract(sum([agreedLineTotal, additionalCharges]), notExecutedAmount);
  assertMinorUnits(net);
  return net;
}
