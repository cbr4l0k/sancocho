import { ConvexError } from 'convex/values';

/** Closed client contract for every error emitted by the backend (I8). */
export const errorCodes = [
  // Shared authorization and mutation outcomes.
  'notFoundOrInaccessible',
  'unauthenticated',
  'conflict',
  'entityNameInvalid',
  'searchTermTooLong',
  // Money input and checked arithmetic.
  'moneyAmountNotFinite',
  'moneyAmountNotInteger',
  'moneyAmountNegative',
  'moneyAmountOutOfRange',
  'moneyQuantityInvalid',
  'moneyArithmeticOverflow',
  // Organization, project, and relationship input.
  'organizationSlugInvalid',
  'invitationEmailInvalid',
  'invitationNotPending',
  'invitationExpired',
  'projectDescriptionTooLong',
  'projectArchived',
  'projectArchiveRequired',
  'projectStartInvalid',
  'projectEndInvalid',
  'projectDateRangeInvalid',
  'eventStartInvalid',
  'eventEndInvalid',
  'eventDateRangeInvalid',
  'eventBeforeProjectWindow',
  'eventAfterProjectWindow',
  'eventProjectUnavailable',
  'eventProjectReadOnly',
  'eventArchived',
  'eventArchiveRequired',
  'eventDeleteRequiresArchive',
  'eventTerminal',
  'eventStatusTransitionInvalid',
  'eventDeleteBlocked',
  'eventVenueLocationTypeInvalid',
  'eventBudgetIncomplete',
  'relationshipSelfReference',
  // Field definition and values.
  'fieldNameInvalid',
  'fieldKeyInvalid',
  'fieldKeyTaken',
  'fieldKeyShadowsBuiltin',
  'fieldDescriptionTooLong',
  'fieldSemanticIncompatible',
  'fieldSemanticTypeLimitExceeded',
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
  // ServiceKind and serviceKind-field input.
  'serviceKindKeyInvalid',
  'serviceKindDescriptionTooLong',
  'serviceKindArchived',
  'serviceKindPublishedVersionRequired',
  'serviceKindVersionNotDraft',
  'serviceKindVersionEmpty',
  'serviceKindFieldRequiredHidden',
  'serviceKindFieldConfigMismatch',
  'serviceKindFieldConfigNotNarrower',
  'serviceKindFieldSnapshotOptionInvalid',
  'serviceKindFieldDuplicateDefinition',
  'serviceKindFieldDefinitionUnavailable',
  'serviceKindFieldLimitExceeded',
  'serviceKindFieldOrderInvalid',
  'serviceKindFieldPositionInvalid',
  // Service and location input.
  'serviceKindUnavailable',
  'serviceFieldUnknown',
  'serviceFieldDuplicate',
  'serviceFieldRequired',
  'serviceStartInvalid',
  'serviceEndInvalid',
  'serviceDateRangeInvalid',
  'serviceBeforeProjectWindow',
  'serviceAfterProjectWindow',
  'serviceProjectReadOnly',
  'serviceProjectUnavailable',
  'serviceEventUnavailable',
  'serviceReadOnly',
  'serviceTerminal',
  'serviceStatusTransitionInvalid',
  'locationArchived',
  'locationArchiveRequired',
  'locationDeleteBlocked',
  'locationTypeChangeBlocked',
  'locationAddressTooLong',
  'locationCoordinatesIncomplete',
  'locationCoordinatesInvalid',
  'costCentreKeyInvalid',
  'costCentreDescriptionTooLong',
  'costCentreArchived',
  'costCentreArchiveRequired',
  'costCentreDeleteBlocked',
  'providerDetailTooLong',
  'providerNotesTooLong',
  'providerArchived',
  'providerArchiveRequired',
  'providerDeleteBlocked',
  // Deployment-only seed and audit input.
  'seedDisabled',
  'seedBuiltinFieldMissing',
  'seedDemonstrationOrganizationMissing',
  'seedOrganizationMissing',
  'seedOrganizationOwnerMissing',
  'seedLocationMissing',
  'seedServiceKindMissing',
  'seedServiceKindVersionMissing',
  'seedServiceMissing',
  'seedFieldConflict',
  'seedServiceKindConflict',
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
