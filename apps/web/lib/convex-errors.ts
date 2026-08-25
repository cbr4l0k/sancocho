import type { ErrorCode } from '@priamo/convex/errors';
import { ConvexError } from 'convex/values';

export type ConvexErrorMessageKey =
  | 'errors.generic'
  | 'errors.notFound'
  | 'errors.unauthenticated'
  | 'errors.conflict'
  | 'errors.entityNameInvalid'
  | 'errors.searchTermTooLong'
  | 'errors.organizationSlugInvalid'
  | 'errors.projectDescriptionTooLong'
  | 'errors.projectArchived'
  | 'errors.projectArchiveRequired'
  | 'errors.projectDatesInvalid'
  | 'errors.relationshipSelfReference'
  | 'errors.fieldKeyInvalid'
  | 'errors.fieldKeyTaken'
  | 'errors.fieldKeyBuiltin'
  | 'errors.fieldDescriptionTooLong'
  | 'errors.fieldSemanticIncompatible'
  | 'errors.fieldSemanticTypeLimitExceeded'
  | 'errors.fieldHistoricalFrozen'
  | 'errors.fieldArchived'
  | 'errors.fieldDeleteBlocked'
  | 'errors.fieldLookupTooLarge'
  | 'errors.fieldConfigInvalid'
  | 'errors.fieldValueInvalid'
  | 'errors.recipeKeyInvalid'
  | 'errors.recipeDescriptionTooLong'
  | 'errors.recipeArchived'
  | 'errors.recipePublishedVersionRequired'
  | 'errors.recipeVersionNotDraft'
  | 'errors.recipeDraftInvalid'
  | 'errors.eventRecipeUnavailable'
  | 'errors.eventFieldsInvalid'
  | 'errors.eventDatesInvalid'
  | 'errors.eventProjectReadOnly'
  | 'errors.eventProjectUnavailable'
  | 'errors.eventReadOnly'
  | 'errors.eventTerminal'
  | 'errors.eventStatusTransitionInvalid'
  | 'errors.locationArchived'
  | 'errors.locationArchiveRequired'
  | 'errors.locationDeleteBlocked'
  | 'errors.locationAddressTooLong'
  | 'errors.locationCoordinatesInvalid'
  | 'errors.auditInvalid'
  | 'errors.statisticsWindowInvalid'
  | 'errors.statisticsWindowTooLarge'
  | 'errors.statisticsLimitInvalid'
  | 'errors.statisticsFilterWindowInvalid'
  | 'errors.statisticsThresholdInvalid';

/** Kept as an alias so existing presentation call sites remain unchanged. */
export type ConvexErrorPresentation = ConvexErrorMessageKey;

/**
 * The client-owned interpretation of every stable backend error code. `Record` makes
 * additions to ErrorCode a web type error until they receive a presentation.
 */
const errorCodeMessageKeys: Record<ErrorCode, ConvexErrorMessageKey> = {
  notFoundOrInaccessible: 'errors.notFound',
  unauthenticated: 'errors.unauthenticated',
  conflict: 'errors.conflict',
  entityNameInvalid: 'errors.entityNameInvalid',
  searchTermTooLong: 'errors.searchTermTooLong',
  organizationSlugInvalid: 'errors.organizationSlugInvalid',
  projectDescriptionTooLong: 'errors.projectDescriptionTooLong',
  projectArchived: 'errors.projectArchived',
  projectArchiveRequired: 'errors.projectArchiveRequired',
  projectStartInvalid: 'errors.projectDatesInvalid',
  projectEndInvalid: 'errors.projectDatesInvalid',
  projectDateRangeInvalid: 'errors.projectDatesInvalid',
  relationshipSelfReference: 'errors.relationshipSelfReference',
  fieldNameInvalid: 'errors.entityNameInvalid',
  fieldKeyInvalid: 'errors.fieldKeyInvalid',
  fieldKeyTaken: 'errors.fieldKeyTaken',
  fieldKeyShadowsBuiltin: 'errors.fieldKeyBuiltin',
  fieldDescriptionTooLong: 'errors.fieldDescriptionTooLong',
  fieldSemanticIncompatible: 'errors.fieldSemanticIncompatible',
  fieldSemanticTypeLimitExceeded: 'errors.fieldSemanticTypeLimitExceeded',
  fieldArchived: 'errors.fieldArchived',
  fieldHistoricalFrozen: 'errors.fieldHistoricalFrozen',
  fieldDeleteBlocked: 'errors.fieldDeleteBlocked',
  fieldLookupTooLarge: 'errors.fieldLookupTooLarge',
  fieldConfigInvalid: 'errors.fieldConfigInvalid',
  fieldSelectOptionsInvalid: 'errors.fieldConfigInvalid',
  fieldValueInvalid: 'errors.fieldValueInvalid',
  fieldValueKindMismatch: 'errors.fieldValueInvalid',
  fieldValueOptionInvalid: 'errors.fieldValueInvalid',
  fieldValueLengthInvalid: 'errors.fieldValueInvalid',
  fieldValueRangeInvalid: 'errors.fieldValueInvalid',
  recipeKeyInvalid: 'errors.recipeKeyInvalid',
  recipeDescriptionTooLong: 'errors.recipeDescriptionTooLong',
  recipeArchived: 'errors.recipeArchived',
  recipePublishedVersionRequired: 'errors.recipePublishedVersionRequired',
  recipeVersionNotDraft: 'errors.recipeVersionNotDraft',
  recipeVersionEmpty: 'errors.recipeDraftInvalid',
  recipeFieldRequiredHidden: 'errors.recipeDraftInvalid',
  recipeFieldConfigMismatch: 'errors.recipeDraftInvalid',
  recipeFieldConfigNotNarrower: 'errors.recipeDraftInvalid',
  recipeFieldSnapshotOptionInvalid: 'errors.recipeDraftInvalid',
  recipeFieldDuplicateDefinition: 'errors.recipeDraftInvalid',
  recipeFieldDefinitionUnavailable: 'errors.recipeDraftInvalid',
  recipeFieldLimitExceeded: 'errors.recipeDraftInvalid',
  recipeFieldOrderInvalid: 'errors.recipeDraftInvalid',
  recipeFieldPositionInvalid: 'errors.recipeDraftInvalid',
  eventRecipeUnavailable: 'errors.eventRecipeUnavailable',
  eventFieldUnknown: 'errors.eventFieldsInvalid',
  eventFieldDuplicate: 'errors.eventFieldsInvalid',
  eventFieldRequired: 'errors.eventFieldsInvalid',
  eventStartInvalid: 'errors.eventDatesInvalid',
  eventEndInvalid: 'errors.eventDatesInvalid',
  eventDateRangeInvalid: 'errors.eventDatesInvalid',
  eventProjectReadOnly: 'errors.eventProjectReadOnly',
  eventProjectUnavailable: 'errors.eventProjectUnavailable',
  eventReadOnly: 'errors.eventReadOnly',
  eventTerminal: 'errors.eventTerminal',
  eventStatusTransitionInvalid: 'errors.eventStatusTransitionInvalid',
  locationArchived: 'errors.locationArchived',
  locationArchiveRequired: 'errors.locationArchiveRequired',
  locationDeleteBlocked: 'errors.locationDeleteBlocked',
  locationAddressTooLong: 'errors.locationAddressTooLong',
  locationCoordinatesIncomplete: 'errors.locationCoordinatesInvalid',
  locationCoordinatesInvalid: 'errors.locationCoordinatesInvalid',
  seedDisabled: 'errors.generic',
  seedBuiltinFieldMissing: 'errors.generic',
  seedDemonstrationOrganizationMissing: 'errors.generic',
  seedOrganizationMissing: 'errors.generic',
  seedOrganizationOwnerMissing: 'errors.generic',
  seedLocationMissing: 'errors.generic',
  seedRecipeMissing: 'errors.generic',
  seedRecipeVersionMissing: 'errors.generic',
  auditEntityIdTooLong: 'errors.auditInvalid',
  auditMetadataInvalid: 'errors.auditInvalid',
  statisticsWindowInvalid: 'errors.statisticsWindowInvalid',
  statisticsWindowTooLarge: 'errors.statisticsWindowTooLarge',
  statisticsLimitInvalid: 'errors.statisticsLimitInvalid',
  statisticsFilterWindowInvalid: 'errors.statisticsFilterWindowInvalid',
  statisticsThresholdInvalid: 'errors.statisticsThresholdInvalid',
  // Both codes are thrown only from `backfillOrganizationCounters`, an
  // `internalMutation` no web client can call — there is no UI surface for
  // them to describe, so they fall back to the generic message rather than
  // getting copy nobody will ever read.
  statisticsBackfillCursorInvalid: 'errors.generic',
  statisticsBackfillPhaseComplete: 'errors.generic',
};

function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(errorCodeMessageKeys, code);
}

/**
 * Reads only the structured payload. Unknown throws and malformed payloads remain
 * generic so the UI stays safe during network or unexpected runtime failures.
 */
export function presentConvexError(error: unknown): ConvexErrorPresentation {
  if (!(error instanceof ConvexError)) return 'errors.generic';

  const data: unknown = error.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return 'errors.generic';

  const code = data.code;
  if (typeof code !== 'string' || !isErrorCode(code)) {
    return 'errors.generic';
  }

  return errorCodeMessageKeys[code];
}

export function errorMessageKey(presentation: ConvexErrorPresentation): ConvexErrorMessageKey {
  return presentation;
}
