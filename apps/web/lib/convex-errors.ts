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
  | 'errors.projectDescriptionTooLong'
  | 'errors.projectArchived'
  | 'errors.projectArchiveRequired'
  | 'errors.projectDatesInvalid'
  | 'errors.eventArchiveRequired'
  | 'errors.eventDeleteRequiresArchive'
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
  projectDescriptionTooLong: 'errors.projectDescriptionTooLong',
  projectArchived: 'errors.projectArchived',
  projectArchiveRequired: 'errors.projectArchiveRequired',
  projectStartInvalid: 'errors.projectDatesInvalid',
  projectEndInvalid: 'errors.projectDatesInvalid',
  projectDateRangeInvalid: 'errors.projectDatesInvalid',
  eventStartInvalid: 'errors.generic',
  eventEndInvalid: 'errors.generic',
  eventDateRangeInvalid: 'errors.generic',
  eventBeforeProjectWindow: 'errors.generic',
  eventAfterProjectWindow: 'errors.generic',
  eventProjectUnavailable: 'errors.generic',
  eventProjectReadOnly: 'errors.generic',
  eventArchived: 'errors.generic',
  eventArchiveRequired: 'errors.eventArchiveRequired',
  eventDeleteRequiresArchive: 'errors.eventDeleteRequiresArchive',
  eventTerminal: 'errors.generic',
  eventStatusTransitionInvalid: 'errors.generic',
  eventDeleteBlocked: 'errors.generic',
  eventVenueLocationTypeInvalid: 'errors.generic',
  eventBudgetIncomplete: 'errors.generic',
  // No console surface inputs money yet (#85 budget, #73 rate cards). These are
  // arithmetic/validation guards; promote to specific messages when a money input exists.
  moneyAmountNotFinite: 'errors.generic',
  moneyAmountNotInteger: 'errors.generic',
  moneyAmountNegative: 'errors.generic',
  moneyAmountOutOfRange: 'errors.generic',
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
  // No provider console surface yet (#87); keep grant failures opaque.
  providerGrantRequiresClaim: 'errors.generic',
  providerGrantSelfReference: 'errors.generic',
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
