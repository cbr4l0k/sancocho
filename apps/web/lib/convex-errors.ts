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
  | 'errors.invitationEmailInvalid'
  | 'errors.invitationNotPending'
  | 'errors.invitationExpired'
  | 'errors.invitationKindMismatch'
  | 'errors.providerClaimAlreadyClaimed'
  | 'errors.providerClaimOrganizationConflict'
  | 'errors.projectDescriptionTooLong'
  | 'errors.projectArchived'
  | 'errors.projectArchiveRequired'
  | 'errors.projectDatesInvalid'
  | 'errors.eventArchiveRequired'
  | 'errors.eventDeleteRequiresArchive'
  | 'errors.eventDatesInvalid'
  | 'errors.eventBeforeProjectWindow'
  | 'errors.eventAfterProjectWindow'
  | 'errors.eventProjectUnavailable'
  | 'errors.eventProjectReadOnly'
  | 'errors.eventArchived'
  | 'errors.eventStatusTransitionInvalid'
  | 'errors.eventVenueLocationTypeInvalid'
  | 'errors.eventBudgetIncomplete'
  | 'errors.moneyAmountInvalid'
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
  | 'errors.serviceKindKeyInvalid'
  | 'errors.serviceKindDescriptionTooLong'
  | 'errors.serviceKindArchived'
  | 'errors.serviceKindPublishedVersionRequired'
  | 'errors.serviceKindVersionNotDraft'
  | 'errors.serviceKindDraftInvalid'
  | 'errors.serviceKindUnavailable'
  | 'errors.serviceFieldsInvalid'
  | 'errors.serviceDatesInvalid'
  | 'errors.serviceBeforeProjectWindow'
  | 'errors.serviceAfterProjectWindow'
  | 'errors.serviceProjectReadOnly'
  | 'errors.serviceProjectUnavailable'
  | 'errors.serviceReadOnly'
  | 'errors.serviceTerminal'
  | 'errors.serviceStatusTransitionInvalid'
  | 'errors.locationArchived'
  | 'errors.locationArchiveRequired'
  | 'errors.locationDeleteBlocked'
  | 'errors.locationAddressTooLong'
  | 'errors.locationCoordinatesInvalid'
  | 'errors.auditInvalid';

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
  invitationEmailInvalid: 'errors.invitationEmailInvalid',
  invitationNotPending: 'errors.invitationNotPending',
  invitationExpired: 'errors.invitationExpired',
  invitationKindMismatch: 'errors.invitationKindMismatch',
  projectDescriptionTooLong: 'errors.projectDescriptionTooLong',
  projectArchived: 'errors.projectArchived',
  projectArchiveRequired: 'errors.projectArchiveRequired',
  projectStartInvalid: 'errors.projectDatesInvalid',
  projectEndInvalid: 'errors.projectDatesInvalid',
  projectDateRangeInvalid: 'errors.projectDatesInvalid',
  eventStartInvalid: 'errors.eventDatesInvalid',
  eventEndInvalid: 'errors.eventDatesInvalid',
  eventDateRangeInvalid: 'errors.eventDatesInvalid',
  eventBeforeProjectWindow: 'errors.eventBeforeProjectWindow',
  eventAfterProjectWindow: 'errors.eventAfterProjectWindow',
  eventProjectUnavailable: 'errors.eventProjectUnavailable',
  eventProjectReadOnly: 'errors.eventProjectReadOnly',
  eventArchived: 'errors.eventArchived',
  eventArchiveRequired: 'errors.eventArchiveRequired',
  eventDeleteRequiresArchive: 'errors.eventDeleteRequiresArchive',
  eventTerminal: 'errors.eventStatusTransitionInvalid',
  eventStatusTransitionInvalid: 'errors.eventStatusTransitionInvalid',
  eventDeleteBlocked: 'errors.generic',
  eventVenueLocationTypeInvalid: 'errors.eventVenueLocationTypeInvalid',
  eventBudgetIncomplete: 'errors.eventBudgetIncomplete',
  moneyAmountNotFinite: 'errors.moneyAmountInvalid',
  moneyAmountNotInteger: 'errors.moneyAmountInvalid',
  moneyAmountNegative: 'errors.moneyAmountInvalid',
  moneyAmountOutOfRange: 'errors.moneyAmountInvalid',
  moneyQuantityInvalid: 'errors.generic',
  moneyArithmeticOverflow: 'errors.generic',
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
  serviceKindKeyInvalid: 'errors.serviceKindKeyInvalid',
  serviceKindDescriptionTooLong: 'errors.serviceKindDescriptionTooLong',
  serviceKindArchived: 'errors.serviceKindArchived',
  serviceKindPublishedVersionRequired: 'errors.serviceKindPublishedVersionRequired',
  serviceKindVersionNotDraft: 'errors.serviceKindVersionNotDraft',
  serviceKindVersionEmpty: 'errors.serviceKindDraftInvalid',
  serviceKindFieldRequiredHidden: 'errors.serviceKindDraftInvalid',
  serviceKindFieldConfigMismatch: 'errors.serviceKindDraftInvalid',
  serviceKindFieldConfigNotNarrower: 'errors.serviceKindDraftInvalid',
  serviceKindFieldSnapshotOptionInvalid: 'errors.serviceKindDraftInvalid',
  serviceKindFieldDuplicateDefinition: 'errors.serviceKindDraftInvalid',
  serviceKindFieldDefinitionUnavailable: 'errors.serviceKindDraftInvalid',
  serviceKindFieldLimitExceeded: 'errors.serviceKindDraftInvalid',
  serviceKindFieldOrderInvalid: 'errors.serviceKindDraftInvalid',
  serviceKindFieldPositionInvalid: 'errors.serviceKindDraftInvalid',
  serviceKindUnavailable: 'errors.serviceKindUnavailable',
  serviceFieldUnknown: 'errors.serviceFieldsInvalid',
  serviceFieldDuplicate: 'errors.serviceFieldsInvalid',
  serviceFieldRequired: 'errors.serviceFieldsInvalid',
  serviceStartInvalid: 'errors.serviceDatesInvalid',
  serviceEndInvalid: 'errors.serviceDatesInvalid',
  serviceDateRangeInvalid: 'errors.serviceDatesInvalid',
  // Named separately from the generic date error: "outside the project's
  // window" is a different mistake from "these two times are inverted", and
  // collapsing them makes the fix unguessable.
  serviceBeforeProjectWindow: 'errors.serviceBeforeProjectWindow',
  serviceAfterProjectWindow: 'errors.serviceAfterProjectWindow',
  serviceProjectReadOnly: 'errors.serviceProjectReadOnly',
  serviceProjectUnavailable: 'errors.serviceProjectUnavailable',
  serviceEventUnavailable: 'errors.generic',
  serviceReadOnly: 'errors.serviceReadOnly',
  serviceTerminal: 'errors.serviceTerminal',
  serviceStatusTransitionInvalid: 'errors.serviceStatusTransitionInvalid',
  locationArchived: 'errors.locationArchived',
  locationArchiveRequired: 'errors.locationArchiveRequired',
  locationDeleteBlocked: 'errors.locationDeleteBlocked',
  locationTypeChangeBlocked: 'errors.generic',
  locationAddressTooLong: 'errors.locationAddressTooLong',
  locationCoordinatesIncomplete: 'errors.locationCoordinatesInvalid',
  locationCoordinatesInvalid: 'errors.locationCoordinatesInvalid',
  // There is no Cost Centre console surface yet; keep these opaque until one exists.
  costCentreKeyInvalid: 'errors.generic',
  costCentreDescriptionTooLong: 'errors.generic',
  costCentreArchived: 'errors.generic',
  costCentreArchiveRequired: 'errors.generic',
  costCentreDeleteBlocked: 'errors.generic',
  // #72 owns the Providers console surface and does not exist yet; these stay
  // generic until there is a screen whose input they could actually explain.
  providerDetailTooLong: 'errors.generic',
  providerNotesTooLong: 'errors.generic',
  providerArchived: 'errors.generic',
  providerArchiveRequired: 'errors.generic',
  providerDeleteBlocked: 'errors.generic',
  providerClaimAlreadyClaimed: 'errors.providerClaimAlreadyClaimed',
  providerClaimOrganizationConflict: 'errors.providerClaimOrganizationConflict',
  // No provider console surface yet (#87); keep grant failures opaque.
  providerGrantRequiresClaim: 'errors.generic',
  providerGrantSelfReference: 'errors.generic',
  // #73 owns the Rate Card console surface; keep this backend vocabulary
  // generic until there is a screen whose inputs can render specific guidance.
  rateCardArchived: 'errors.generic',
  rateCardPublishedVersionRequired: 'errors.generic',
  rateCardVersionNotDraft: 'errors.generic',
  rateCardVersionNotPublished: 'errors.generic',
  rateCardVersionEmpty: 'errors.generic',
  rateCardProviderUnavailable: 'errors.generic',
  rateLineVehicleClassUnavailable: 'errors.generic',
  rateLineDuplicateCell: 'errors.generic',
  rateLineLimitExceeded: 'errors.generic',
  // #74 owns the Assignment console; keep backend lifecycle details opaque here.
  assignmentPositionInvalid: 'errors.generic',
  assignmentNotesTooLong: 'errors.generic',
  assignmentLimitExceeded: 'errors.generic',
  assignmentRemoveBlocked: 'errors.generic',
  assignmentRevisionQuantityInvalid: 'errors.generic',
  assignmentRevisionNotDraft: 'errors.generic',
  assignmentRevisionNotDeclinable: 'errors.generic',
  assignmentRevisionProviderAcceptanceForbidden: 'errors.generic',
  assignmentRevisionOutdated: 'errors.generic',
  assignmentRevisionLimitReached: 'errors.generic',
  assignmentCheckpointLimitReached: 'errors.generic',
  assignmentDeclinedReasonRequired: 'errors.generic',
  assignmentDeclinedReasonTooLong: 'errors.generic',
  assignmentCheckpointOccurredAtInvalid: 'errors.generic',
  assignmentCheckpointNoteTooLong: 'errors.generic',
  assignmentExecutionTerminal: 'errors.generic',
  assignmentExecutionStatusTransitionInvalid: 'errors.generic',
  assignmentExecutionVehicleInvalid: 'errors.generic',
  assignmentExecutionDriverRequired: 'errors.generic',
  assignmentExecutionDriverPhoneInvalid: 'errors.generic',
  paginationNumItemsInvalid: 'errors.generic',
  assignmentExecutionServiceNotConfirmed: 'errors.generic',
  assignmentNotExecutedReasonInvalid: 'errors.generic',
  assignmentVehiclePlateOverrideInvalid: 'errors.generic',
  assignmentAcceptedRevisionRequired: 'errors.generic',
  // #72 owns the fleet console surface and does not exist yet, so every Vehicle
  // Class and Fleet Vehicle refusal stays generic: inventing message keys for a
  // screen with no inputs would ship copy nothing can render in context.
  vehicleClassKeyInvalid: 'errors.generic',
  vehicleClassDescriptionTooLong: 'errors.generic',
  vehicleClassCapacityInvalid: 'errors.generic',
  vehicleClassCargoNoteTooLong: 'errors.generic',
  vehicleClassArchived: 'errors.generic',
  vehicleClassArchiveRequired: 'errors.generic',
  vehicleClassDeleteBlocked: 'errors.generic',
  fleetVehiclePlateInvalid: 'errors.generic',
  fleetVehicleLabelInvalid: 'errors.generic',
  fleetVehicleYearInvalid: 'errors.generic',
  fleetVehicleNotesTooLong: 'errors.generic',
  fleetVehicleArchived: 'errors.generic',
  fleetVehicleArchiveRequired: 'errors.generic',
  fleetVehicleDeleteBlocked: 'errors.generic',
  seedDisabled: 'errors.generic',
  seedBuiltinFieldMissing: 'errors.generic',
  seedDemonstrationOrganizationMissing: 'errors.generic',
  seedOrganizationMissing: 'errors.generic',
  seedOrganizationOwnerMissing: 'errors.generic',
  seedLocationMissing: 'errors.generic',
  seedServiceKindMissing: 'errors.generic',
  seedServiceKindVersionMissing: 'errors.generic',
  seedServiceMissing: 'errors.generic',
  seedFieldConflict: 'errors.generic',
  seedServiceKindConflict: 'errors.generic',
  auditEntityIdTooLong: 'errors.auditInvalid',
  auditMetadataInvalid: 'errors.auditInvalid',
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
