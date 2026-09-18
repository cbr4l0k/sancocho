import { expect, test } from 'bun:test';
import { ConvexError } from 'convex/values';

import { errorCodes } from '@priamo/convex/errors';

import { presentConvexError } from './convex-errors';

function present(code: string): string {
  return presentConvexError(new ConvexError({ code }));
}

test('an unknown backend code maps to the generic message', () => {
  expect(present('futureCode')).toBe('errors.generic');
});

test('a malformed or non-Convex throw stays generic rather than surfacing prose', () => {
  expect(presentConvexError(new Error('boom'))).toBe('errors.generic');
  expect(presentConvexError(new ConvexError('a bare string payload'))).toBe('errors.generic');
  expect(presentConvexError(new ConvexError({ message: 'no code here' }))).toBe('errors.generic');
  expect(presentConvexError(undefined)).toBe('errors.generic');
});

test('existence-hiding codes stay mapped to the generic not-found message', () => {
  // These intentionally collapse "exists but not yours" and "does not exist".
  // A more specific message would disclose record existence (I9).
  expect(present('notFoundOrInaccessible')).toBe('errors.notFound');
  // Not the same thing, and must not be merged into it: an expired session is
  // the caller's own problem to fix, and showing "not found" sends them looking
  // for a missing record instead of signing in again.
  expect(present('unauthenticated')).toBe('errors.unauthenticated');
});

test('the number of codes left with no specific copy is pinned, so one more is a decision', () => {
  // `errorCodeMessageKeys` is exhaustive over `ErrorCode`, so `tsc` already
  // guarantees every code is PRESENT — but the cheapest way to satisfy that is
  // `errors.generic`, which tells the user nothing. Only a pinned count makes
  // adding to that pile visible in review.
  //
  // Deriving this set from the mapping instead would be circular: the first
  // version of this test filtered the codes by what the mapping already said
  // and then asserted the result was empty, which it always was.
  //
  // Moved 31 -> 38 by #98, deliberately. All seven additions
  // (`seedVehicleClassMissing`, `seedCostCentreMissing`, `seedVehicleClassConflict`,
  // `seedCostCentreConflict`, `seedProviderConflict`, `seedRateLineMissing`,
  // `seedRateCardVersionMissing`) are thrown only by
  // `internalMutation`s behind `PRIAMO_ENABLE_SEED`. No console surface can
  // reach a seed, so specific copy would be words no user can ever see — which
  // is why every pre-existing `seed*` code sits in this pile too.
  const generic = errorCodes.filter((code) => present(code) === 'errors.generic');
  expect(generic).toHaveLength(38);
  expect(errorCodes).toHaveLength(176);
});

test('the mapping is a real table, not a constant', () => {
  // Mutation testing replaced the whole lookup with a single literal and the
  // suite stayed green: the two tests above happened to agree with it, and
  // nothing else touched the table. Distinct-key breadth is what makes that
  // impossible — a constant collapses this to 1.
  const distinct = new Set(errorCodes.map((code) => present(code)));
  expect(distinct.size).toBeGreaterThan(50);
  expect(distinct.size).toBe(110);
});

test('each Provider, Fleet, and Rate Card code carries its own copy, not a neighbour\'s', () => {
  // A swapped pair still type-checks and still renders a real translated string;
  // only the words are wrong. Archiving a Class with vehicles attached read
  // "License plate is invalid" under one injected mutation.
  const pinned: Readonly<Record<string, string>> = {
    providerDetailTooLong: 'errors.providerDetailTooLong',
    providerNotesTooLong: 'errors.providerNotesTooLong',
    providerArchived: 'errors.providerArchived',
    providerClaimAlreadyClaimed: 'errors.providerClaimAlreadyClaimed',
    providerClaimOrganizationConflict: 'errors.providerClaimOrganizationConflict',
    vehicleClassKeyInvalid: 'errors.vehicleClassKeyInvalid',
    vehicleClassDescriptionTooLong: 'errors.vehicleClassDescriptionTooLong',
    vehicleClassCapacityInvalid: 'errors.vehicleClassCapacityInvalid',
    vehicleClassCargoNoteTooLong: 'errors.vehicleClassCargoNoteTooLong',
    vehicleClassArchived: 'errors.vehicleClassArchived',
    fleetVehiclePlateInvalid: 'errors.fleetVehiclePlateInvalid',
    fleetVehicleLabelInvalid: 'errors.fleetVehicleLabelInvalid',
    fleetVehicleYearInvalid: 'errors.fleetVehicleYearInvalid',
    fleetVehicleNotesTooLong: 'errors.fleetVehicleNotesTooLong',
    fleetVehicleArchived: 'errors.fleetVehicleArchived',
    rateCardArchived: 'errors.rateCardArchived',
    rateCardPublishedVersionRequired: 'errors.rateCardPublishedVersionRequired',
    rateCardVersionNotDraft: 'errors.rateCardVersionNotDraft',
    rateCardVersionNotPublished: 'errors.rateCardVersionNotPublished',
    rateCardVersionEmpty: 'errors.rateCardVersionEmpty',
    rateCardProviderUnavailable: 'errors.rateCardProviderUnavailable',
    rateLineVehicleClassUnavailable: 'errors.rateLineVehicleClassUnavailable',
    rateLineDuplicateCell: 'errors.rateLineDuplicateCell',
    rateLineLimitExceeded: 'errors.rateLineLimitExceeded',
  };
  for (const [code, key] of Object.entries(pinned)) {
    expect(`${code} -> ${present(code)}`).toBe(`${code} -> ${key}`);
  }
  // Each of them is distinct from every other, so no two can be merged either.
  expect(new Set(Object.values(pinned)).size).toBe(Object.keys(pinned).length);
});

test('Assignment failures use stable specific copy rather than backend prose', () => {
  const pinned: Readonly<Record<string, string>> = {
    assignmentPositionInvalid: 'errors.assignmentPositionInvalid',
    assignmentNotesTooLong: 'errors.assignmentNotesTooLong',
    assignmentLimitExceeded: 'errors.assignmentLimitExceeded',
    assignmentRemoveBlocked: 'errors.assignmentRemoveBlocked',
    assignmentRevisionQuantityInvalid: 'errors.assignmentRevisionQuantityInvalid',
    assignmentRevisionNotDraft: 'errors.assignmentRevisionNotDraft',
    assignmentRevisionNotDeclinable: 'errors.assignmentRevisionNotDeclinable',
    assignmentRevisionProviderAcceptanceForbidden: 'errors.assignmentRevisionProviderAcceptanceForbidden',
    assignmentRevisionOutdated: 'errors.assignmentRevisionOutdated',
    assignmentRevisionLimitReached: 'errors.assignmentRevisionLimitReached',
    assignmentCheckpointLimitReached: 'errors.assignmentCheckpointLimitReached',
    assignmentDeclinedReasonRequired: 'errors.assignmentDeclinedReasonRequired',
    assignmentDeclinedReasonTooLong: 'errors.assignmentDeclinedReasonTooLong',
    assignmentCheckpointOccurredAtInvalid: 'errors.assignmentCheckpointOccurredAtInvalid',
    assignmentCheckpointNoteTooLong: 'errors.assignmentCheckpointNoteTooLong',
    assignmentExecutionTerminal: 'errors.assignmentExecutionTerminal',
    assignmentExecutionStatusTransitionInvalid: 'errors.assignmentExecutionStatusTransitionInvalid',
    assignmentExecutionVehicleInvalid: 'errors.assignmentExecutionVehicleInvalid',
    assignmentExecutionDriverRequired: 'errors.assignmentExecutionDriverRequired',
    assignmentExecutionDriverPhoneInvalid: 'errors.assignmentExecutionDriverPhoneInvalid',
    assignmentExecutionServiceNotConfirmed: 'errors.assignmentExecutionServiceNotConfirmed',
    assignmentNotExecutedReasonInvalid: 'errors.assignmentNotExecutedReasonInvalid',
    assignmentVehiclePlateOverrideInvalid: 'errors.assignmentVehiclePlateOverrideInvalid',
    assignmentAcceptedRevisionRequired: 'errors.assignmentAcceptedRevisionRequired',
  };
  for (const [code, key] of Object.entries(pinned)) expect(present(code)).toBe(key);
});
