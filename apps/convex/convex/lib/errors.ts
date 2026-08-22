import { ConvexError } from 'convex/values';

/** Closed client contract for every error emitted by the backend (I8). */
export const errorCodes = [
  // Shared authorization and mutation outcomes.
  'notFoundOrInaccessible',
  'unauthenticated',
  'conflict',
  'entityNameInvalid',
  'searchTermTooLong',
  'statisticsWindowInvalid',
  'statisticsWindowTooLarge',
  'statisticsLimitInvalid',
  // Organization, project, and relationship input.
  'organizationSlugInvalid',
  'projectDescriptionTooLong',
  'projectArchived',
  'projectArchiveRequired',
  'projectStartInvalid',
  'projectEndInvalid',
  'projectDateRangeInvalid',
  'relationshipSelfReference',
  // Field definition and values.
  'fieldNameInvalid',
  'fieldKeyInvalid',
  'fieldKeyTaken',
  'fieldKeyShadowsBuiltin',
  'fieldDescriptionTooLong',
  'fieldSemanticIncompatible',
  'fieldArchived',
  'fieldHistoricalFrozen',
  'fieldDeleteBlocked',
  'fieldLookupTooLarge',
  'fieldConfigInvalid',
  'fieldSelectOptionsInvalid',
  'fieldValueInvalid',
  'fieldValueKindMismatch',
  'fieldValueOptionInvalid',
  'fieldValueLengthInvalid',
  'fieldValueRangeInvalid',
  // Recipe and recipe-field input.
  'recipeKeyInvalid',
  'recipeDescriptionTooLong',
  'recipeArchived',
  'recipePublishedVersionRequired',
  'recipeVersionNotDraft',
  'recipeVersionEmpty',
  'recipeFieldRequiredHidden',
  'recipeFieldConfigMismatch',
  'recipeFieldConfigNotNarrower',
  'recipeFieldSnapshotOptionInvalid',
  'recipeFieldDuplicateDefinition',
  'recipeFieldDefinitionUnavailable',
  'recipeFieldLimitExceeded',
  'recipeFieldOrderInvalid',
  'recipeFieldPositionInvalid',
  // Event and location input.
  'eventRecipeUnavailable',
  'eventFieldUnknown',
  'eventFieldDuplicate',
  'eventFieldRequired',
  'eventStartInvalid',
  'eventEndInvalid',
  'eventDateRangeInvalid',
  'eventProjectReadOnly',
  'eventProjectUnavailable',
  'eventReadOnly',
  'eventTerminal',
  'eventStatusTransitionInvalid',
  'locationArchived',
  'locationArchiveRequired',
  'locationDeleteBlocked',
  'locationAddressTooLong',
  'locationCoordinatesIncomplete',
  'locationCoordinatesInvalid',
  // Deployment-only seed and audit input.
  'seedDisabled',
  'seedBuiltinFieldMissing',
  'seedDemonstrationOrganizationMissing',
  'seedOrganizationMissing',
  'seedOrganizationOwnerMissing',
  'seedLocationMissing',
  'seedRecipeMissing',
  'seedRecipeVersionMissing',
  'auditEntityIdTooLong',
  'auditMetadataInvalid',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

/** Throws a generic error so authorization failures never disclose existence (I9). */
export function notFoundOrInaccessible(): never {
  throw new ConvexError({ code: 'notFoundOrInaccessible' });
}

/** Throws the stable error used when an operation requires an authenticated identity. */
export function unauthenticated(): never {
  throw new ConvexError({ code: 'unauthenticated' });
}

/** Throws a generic conflict error without disclosing the conflicting record. */
export function conflict(): never {
  throw new ConvexError({ code: 'conflict' });
}

/** Rejects the caller's own malformed input; the message is only for logs and developers. */
export function invalidInput(code: ErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}
