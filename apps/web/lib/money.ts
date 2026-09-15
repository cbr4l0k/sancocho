import type { currencyValidator } from '@priamo/convex/validators';

import type { CanonicalLocale } from '@/i18n/locales';

export type Currency = typeof currencyValidator.type;

/**
 * docs/rates.md §Representation deliberately gives every supported currency
 * one fixed exponent and explicitly rejects a per-currency exponent table.
 */
export const MONEY_EXPONENT = 2;
const MINOR_UNIT_FACTOR = 10 ** MONEY_EXPONENT;

export type MoneyInputProblem = 'invalid' | 'negative' | 'tooManyDecimalPlaces' | 'outOfRange';
export type MoneyInputResult = { ok: true; minorUnits: number } | { ok: false; problem: MoneyInputProblem };

/** Parses an ungrouped user-entered amount without localized Number coercion. */
export function parseMoneyInput(text: string): MoneyInputResult {
  const value = text.trim();
  if (value.startsWith('-')) return { ok: false, problem: 'negative' };
  if (value.length === 0 || !/^\d+(?:[.,]\d*)?$/.test(value)) return { ok: false, problem: 'invalid' };
  const separator = value.includes(',') ? ',' : value.includes('.') ? '.' : undefined;
  const pieces = separator === undefined ? [value] : value.split(separator);
  const majorText = pieces[0] ?? '';
  const fractionText = pieces[1] ?? '';
  if (fractionText.length > MONEY_EXPONENT) return { ok: false, problem: 'tooManyDecimalPlaces' };
  const paddedFraction = fractionText.padEnd(MONEY_EXPONENT, '0');
  const minorText = `${majorText}${paddedFraction}`.replace(/^0+(?=\d)/, '');
  const minorBigInt = BigInt(minorText);
  if (minorBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, problem: 'outOfRange' };
  return { ok: true, minorUnits: Number(minorBigInt) };
}

/** Formats exact integer minor units into the `moneyValue` catalogue's amount part. */
export function formatMoneyParts(locale: CanonicalLocale, minorUnits: number): { amount: string } {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) throw new RangeError('minorUnits must be a non-negative safe integer');
  const major = Math.floor(minorUnits / MINOR_UNIT_FACTOR);
  const minor = minorUnits % MINOR_UNIT_FACTOR;
  const parts = new Intl.NumberFormat(locale, {
    minimumFractionDigits: MONEY_EXPONENT,
    maximumFractionDigits: MONEY_EXPONENT,
  }).formatToParts(BigInt(major));
  return {
    amount: parts.map((part) => part.type === 'fraction' ? String(minor).padStart(MONEY_EXPONENT, '0') : part.value).join(''),
  };
}

/** Exact, ungrouped decimal text suitable for repopulating an amount input. */
export function moneyInputText(minorUnits: number): string {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) throw new RangeError('minorUnits must be a non-negative safe integer');
  const major = Math.floor(minorUnits / MINOR_UNIT_FACTOR);
  const minor = minorUnits % MINOR_UNIT_FACTOR;
  return `${major}.${String(minor).padStart(MONEY_EXPONENT, '0')}`;
}

export type BudgetInputProblem =
  | { kind: 'incomplete' }
  | { kind: 'amount'; problem: MoneyInputProblem };

/** Mirrors the server's both-or-neither `validateEventBudget` contract. */
export function budgetInputProblem(amountText: string, currency: Currency | ''): BudgetInputProblem | undefined {
  const hasAmount = amountText.trim().length > 0;
  const hasCurrency = currency !== '';
  if (hasAmount !== hasCurrency) return { kind: 'incomplete' };
  if (!hasAmount) return undefined;
  const parsed = parseMoneyInput(amountText);
  return parsed.ok ? undefined : { kind: 'amount', problem: parsed.problem };
}

export type MoneyDisplay = { kind: 'unset' } | { kind: 'money'; amount: string; currency: Currency };

/**
 * Renders one optional stored money pair — an Event budget, today — as either
 * "not set" or an amount bound to its own currency.
 *
 * It returns a currency per value rather than a formatted string so the caller
 * supplies the localized pattern, and so that **the currency can never be
 * separated from the amount it belongs to**. That is the cross-currency
 * boundary in this console: a list of Events in COP, USD and EUR renders three
 * independent labels and there is no operation here that could produce a fourth
 * combining them. Priamo has no conversion engine and no exchange rates (see
 * the non-goals in CLAUDE.md), so a blended total would be a fabricated number,
 * not a rounded one.
 *
 * An earlier draft guarded that intent by asserting the module exported no
 * function *named* `total` or `blendedTotal`. Mutation testing showed a real
 * blended total added under any other name sailed through, so the guard is
 * structural now: nothing in this module accepts more than one amount.
 *
 * Both columns are `v.optional` on the stored row and the server enforces
 * both-or-neither, so a half-set pair means the row predates the pairing rule
 * or was written around it; it reads as unset rather than as half a number.
 */
export function moneyDisplay(
  locale: CanonicalLocale,
  minorUnits: number | undefined,
  currency: Currency | undefined,
): MoneyDisplay {
  if (minorUnits === undefined || currency === undefined) return { kind: 'unset' };
  return { kind: 'money', ...formatMoneyParts(locale, minorUnits), currency };
}
