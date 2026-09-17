import { describe, expect, test } from 'bun:test';

import {
  distinctRateLookupRequests,
  isRateLookupResult,
  rateLookupCollectionState,
  rateLookupResultsToRates,
  type RateLookupRequest,
} from './rate-lookup-result';
import type { Currency } from './workbook-plan';

const backendCurrencies = {
  COP: true,
  USD: true,
  EUR: true,
  MXN: true,
} as const satisfies Record<Currency, true>;

const resolved = {
  kind: 'resolved',
  rateCardId: 'card-1',
  rateCardName: 'Tarifa 2026',
  rateCardVersionId: 'version-1',
  rateLineId: 'line-1',
  unitAmount: 810000,
  currency: 'COP',
};

describe('rate lookup result boundary', () => {
  test('accepts every backend currency', () => {
    for (const currency of Object.keys(backendCurrencies)) {
      expect(isRateLookupResult({ ...resolved, currency })).toBe(true);
    }
  });

  test('accepts every backend union arm', () => {
    expect(isRateLookupResult(resolved)).toBe(true);
    expect(isRateLookupResult({
      kind: 'ambiguous',
      candidates: [{
        rateCardId: 'card-1', rateCardName: 'A', rateCardVersionId: 'version-1', unitAmount: 100, currency: 'USD',
      }],
    })).toBe(true);
    expect(isRateLookupResult({ kind: 'unpriceable', reason: 'noRateLine' })).toBe(true);
    expect(isRateLookupResult({ kind: 'unpriceable', reason: 'rateCardLimitExceeded' })).toBe(true);
  });

  test('rejects malformed and open-ended impostors', () => {
    for (const currency of ['GBP', null, 42, {}]) {
      expect(isRateLookupResult({ ...resolved, currency })).toBe(false);
    }
    expect(isRateLookupResult({ ...resolved, rateLineId: 17 })).toBe(false);
    expect(isRateLookupResult({ kind: 'unpriceable', reason: 'temporary', extra: true })).toBe(false);
    expect(isRateLookupResult({ kind: 'ambiguous', candidates: [{}] })).toBe(false);
    expect(isRateLookupResult(null)).toBe(false);
  });
});

describe('rate result collection', () => {
  test('collapses repeated rows to distinct Provider, Vehicle Class and modality triples', () => {
    expect(distinctRateLookupRequests([
      { rateLookup: { providerId: 'provider-1', vehicleClassId: 'class-1', modality: 'transfer', quantity: 1 } },
      { rateLookup: { providerId: 'provider-1', vehicleClassId: 'class-1', modality: 'transfer', quantity: 5 } },
      { rateLookup: { providerId: 'provider-1', vehicleClassId: 'class-1', modality: 'route', quantity: 1 } },
      {},
    ])).toEqual([
      {
        key: '["provider-1","class-1","transfer"]',
        providerId: 'provider-1', vehicleClassId: 'class-1', modality: 'transfer',
      },
      {
        key: '["provider-1","class-1","route"]',
        providerId: 'provider-1', vehicleClassId: 'class-1', modality: 'route',
      },
    ]);
  });

  test('turns only resolved entries into planner rates', () => {
    const requests: readonly RateLookupRequest[] = [
      { key: 'one', providerId: 'provider-1', vehicleClassId: 'class-1', modality: 'transfer' },
      { key: 'two', providerId: 'provider-2', vehicleClassId: 'class-1', modality: 'route' },
      { key: 'three', providerId: 'provider-3', vehicleClassId: 'class-2', modality: 'fixed' },
      { key: 'four', providerId: 'provider-4', vehicleClassId: 'class-2', modality: 'disposition' },
    ];
    expect(rateLookupResultsToRates(requests, {
      one: resolved,
      two: undefined,
      three: new Error('query failed'),
      four: { kind: 'ambiguous', candidates: [] },
    })).toEqual([{
      providerId: 'provider-1',
      vehicleClassId: 'class-1',
      modality: 'transfer',
      rateCardVersionId: 'version-1',
      rateLineId: 'line-1',
      unitAmount: 810000,
      currency: 'COP',
    }]);
  });

  test('reports an errored lookup as error, never as complete', () => {
    const requests: readonly RateLookupRequest[] = [
      { key: 'one', providerId: 'provider-1', vehicleClassId: 'class-1', modality: 'transfer' },
      { key: 'two', providerId: 'provider-2', vehicleClassId: 'class-1', modality: 'route' },
    ];
    // An Error is not `undefined`, so a bare presence check would call this complete
    // and the row would be written as unpriced.
    expect(rateLookupCollectionState(requests, { one: resolved, two: new Error('boom') })).toBe('error');
    expect(rateLookupCollectionState(requests, { one: resolved, two: undefined })).toBe('loading');
    expect(rateLookupCollectionState(requests, {
      one: resolved,
      two: { kind: 'unpriceable', reason: 'noRateLine' },
    })).toBe('complete');
  });

  test('accepts a resolved payload carrying a field this console does not know', () => {
    // A backend addition must not silently degrade every row to unpriced.
    const widened = { ...resolved, rateCardCurrencyNote: 'added later' };
    expect(isRateLookupResult(widened)).toBe(true);
    expect(rateLookupCollectionState(
      [{ key: 'one', providerId: 'provider-1', vehicleClassId: 'class-1', modality: 'transfer' }],
      { one: widened },
    )).toBe('complete');
  });
});
