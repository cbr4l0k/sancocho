import type { FunctionReturnType } from 'convex/server';

import { api } from '@priamo/convex/api';

import type { Currency, PlannedRow, ResolvedRate } from './workbook-plan';

export type RateLookupResult = FunctionReturnType<typeof api.assignments.queries.resolveProspectiveRate>;

export type RateLookupRequest = {
  key: string;
  providerId: string;
  vehicleClassId: string;
  modality: ResolvedRate['modality'];
};

export function rateLookupKey(lookup: Pick<RateLookupRequest, 'providerId' | 'vehicleClassId' | 'modality'>): string {
  return JSON.stringify([lookup.providerId, lookup.vehicleClassId, lookup.modality]);
}

export function distinctRateLookupRequests(
  rows: readonly Pick<PlannedRow, 'rateLookup'>[],
): readonly RateLookupRequest[] {
  const distinct = new Map<string, RateLookupRequest>();
  for (const row of rows) {
    if (row.rateLookup === undefined) continue;
    const key = rateLookupKey(row.rateLookup);
    distinct.set(key, {
      key,
      providerId: row.rateLookup.providerId,
      vehicleClassId: row.rateLookup.vehicleClassId,
      modality: row.rateLookup.modality,
    });
  }
  return [...distinct.values()];
}

const currencyMembers = {
  COP: true,
  USD: true,
  EUR: true,
  MXN: true,
} as const satisfies Record<Currency, true>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactly(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.hasOwn(currencyMembers, value);
}

function isCandidate(value: unknown): boolean {
  if (!isRecord(value) || !hasExactly(value, [
    'rateCardId', 'rateCardName', 'rateCardVersionId', 'unitAmount', 'currency',
  ])) return false;
  return typeof value.rateCardId === 'string' &&
    typeof value.rateCardName === 'string' &&
    typeof value.rateCardVersionId === 'string' &&
    typeof value.unitAmount === 'number' &&
    Number.isFinite(value.unitAmount) &&
    isCurrency(value.currency);
}

export function isRateLookupResult(value: unknown): value is RateLookupResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'resolved') {
    return hasExactly(value, [
      'kind', 'rateCardId', 'rateCardName', 'rateCardVersionId', 'rateLineId', 'unitAmount', 'currency',
    ]) &&
      typeof value.rateCardId === 'string' &&
      typeof value.rateCardName === 'string' &&
      typeof value.rateCardVersionId === 'string' &&
      typeof value.rateLineId === 'string' &&
      typeof value.unitAmount === 'number' &&
      Number.isFinite(value.unitAmount) &&
      isCurrency(value.currency);
  }
  if (value.kind === 'ambiguous') {
    return hasExactly(value, ['kind', 'candidates']) &&
      Array.isArray(value.candidates) && value.candidates.every(isCandidate);
  }
  return value.kind === 'unpriceable' &&
    hasExactly(value, ['kind', 'reason']) &&
    (value.reason === 'noRateLine' || value.reason === 'rateCardLimitExceeded');
}

export function rateLookupResultsToRates(
  requests: readonly RateLookupRequest[],
  results: Readonly<Record<string, unknown>>,
): readonly ResolvedRate[] {
  return requests.flatMap((request) => {
    const result = results[request.key];
    if (!isRateLookupResult(result) || result.kind !== 'resolved') return [];
    return [{
      providerId: request.providerId,
      vehicleClassId: request.vehicleClassId,
      modality: request.modality,
      rateCardVersionId: result.rateCardVersionId,
      rateLineId: result.rateLineId,
      unitAmount: result.unitAmount,
      currency: result.currency,
    }];
  });
}
