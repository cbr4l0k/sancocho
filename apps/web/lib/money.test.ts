import { describe, expect, test } from 'bun:test';

import { budgetInputProblem, formatMoneyParts, moneyDisplay, moneyInputText, parseMoneyInput } from './money';

describe('parseMoneyInput', () => {
  test('accepts either decimal separator and rejects grouping ambiguity and negatives', () => {
    expect(parseMoneyInput('12,34')).toEqual({ ok: true, minorUnits: 1234 });
    expect(parseMoneyInput('12.34')).toEqual({ ok: true, minorUnits: 1234 });
    expect(parseMoneyInput('1,234.56')).toEqual({ ok: false, problem: 'invalid' });
    expect(parseMoneyInput('1.234,56')).toEqual({ ok: false, problem: 'invalid' });
    expect(parseMoneyInput('-1.00')).toEqual({ ok: false, problem: 'negative' });
    expect(parseMoneyInput('1.234')).toEqual({ ok: false, problem: 'tooManyDecimalPlaces' });
  });

  test('re-populates an edit form from moneyInputText, never from display output', () => {
    // These are two different jobs and only one of them round-trips. A previous
    // version of this test fed `formatMoneyParts` output back into the parser
    // and passed — but only because 12.34 is too small to carry a grouping
    // separator. Display output is deliberately NOT re-parseable: grouping is
    // ambiguous between the two locales and the parser rejects it on purpose.
    for (const locale of ['es-CO', 'en-US'] as const) {
      for (const minorUnits of [12_34, 100_000_00, 1_234_567_89]) {
        expect(parseMoneyInput(moneyInputText(minorUnits))).toEqual({ ok: true, minorUnits });
        const grouped = formatMoneyParts(locale, 1_234_567_89).amount;
        expect(parseMoneyInput(grouped)).toEqual({ ok: false, problem: 'invalid' });
      }
    }
  });

  test('keeps exact integer results near the safe-integer boundary', () => {
    const value = Number.MAX_SAFE_INTEGER - 90;
    const formatted = formatMoneyParts('en-US', value).amount;
    expect(formatted.endsWith('.01')).toBe(true);
    expect(parseMoneyInput(moneyInputText(value))).toEqual({ ok: true, minorUnits: value });
    expect(parseMoneyInput('90071992547409.92')).toEqual({ ok: false, problem: 'outOfRange' });
  });
});

test('budget is optional but both amount and currency must be supplied together', () => {
  expect(budgetInputProblem('', '')).toBeUndefined();
  expect(budgetInputProblem('10.00', '')).toEqual({ kind: 'incomplete' });
  expect(budgetInputProblem('', 'USD')).toEqual({ kind: 'incomplete' });
  expect(budgetInputProblem('10.00', 'USD')).toBeUndefined();
});

test('each amount stays bound to its own currency across a mixed-currency list', () => {
  // The cross-currency boundary. Three Events in three currencies produce three
  // independent labels; nothing here can combine them, because `moneyDisplay`
  // accepts one amount and returns that amount's own currency with it.
  //
  // This replaced an assertion that the module exported nothing NAMED `total`
  // or `blendedTotal`. Mutation testing added a genuine blended total under a
  // different name and the whole suite stayed green, so the old guard protected
  // nothing.
  const rows = [
    { amount: 100_00, currency: 'USD' },
    { amount: 250_000_00, currency: 'COP' },
    { amount: 50_00, currency: 'USD' },
  ] as const;
  const displayed = rows.map((row) => moneyDisplay('en-US', row.amount, row.currency));
  expect(displayed).toHaveLength(rows.length);
  expect(displayed.map((entry) => (entry.kind === 'money' ? entry.currency : null))).toEqual(['USD', 'COP', 'USD']);
  expect(displayed.map((entry) => (entry.kind === 'money' ? entry.amount : null))).toEqual(['100.00', '250,000.00', '50.00']);
});

test('a money pair missing either half reads as unset rather than half a number', () => {
  expect(moneyDisplay('en-US', undefined, undefined)).toEqual({ kind: 'unset' });
  expect(moneyDisplay('en-US', 100_00, undefined)).toEqual({ kind: 'unset' });
  expect(moneyDisplay('en-US', undefined, 'USD')).toEqual({ kind: 'unset' });
  expect(moneyDisplay('en-US', 0, 'USD')).toEqual({ kind: 'money', amount: '0.00', currency: 'USD' });
});
