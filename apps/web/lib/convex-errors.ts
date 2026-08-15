import { ConvexError } from 'convex/values';

export type ConvexErrorPresentation =
  | 'notFound'
  | 'unauthenticated'
  | 'conflict'
  | 'fieldKeyInvalid'
  | 'fieldKeyTaken'
  | 'fieldKeyBuiltin'
  | 'fieldDescriptionTooLong'
  | 'fieldSemanticIncompatible'
  | 'fieldHistoricalFrozen'
  | 'fieldArchived'
  | 'fieldDeleteBlocked'
  | 'fieldConfigInvalid'
  | 'generic';

/**
 * Coupled to the code-owned invalidInput messages in
 * apps/convex/convex/fields/model.ts. Keep unknown messages generic: rendered
 * server text is never a client contract.
 */
const fieldInvalidInputPresentation: Readonly<Record<string, ConvexErrorPresentation>> = {
  'Field key must be 2–64 lowerCamelCase characters': 'fieldKeyInvalid',
  'A field with this key already exists': 'fieldKeyTaken',
  'Custom field keys cannot shadow built-in field keys': 'fieldKeyBuiltin',
  'Field description must not exceed 2000 characters': 'fieldDescriptionTooLong',
  'Semantic type is incompatible with the field configuration': 'fieldSemanticIncompatible',
  'Fields referenced by published or retired recipe versions may only update label or description': 'fieldHistoricalFrozen',
  'Archived fields cannot be updated': 'fieldArchived',
  'Referenced field definitions cannot be deleted; archive the field instead': 'fieldDeleteBlocked',
  'Field length bounds must be finite numbers': 'fieldConfigInvalid',
  'Field maximum length must not be less than its minimum length': 'fieldConfigInvalid',
  'Field maximum length must not exceed 10000 characters': 'fieldConfigInvalid',
  'Field maximum length must not exceed 100000 characters': 'fieldConfigInvalid',
  'Field numeric bounds must be finite numbers': 'fieldConfigInvalid',
  'Field maximum must not be less than its minimum': 'fieldConfigInvalid',
  'Field date bounds must be YYYY-MM-DD calendar dates': 'fieldConfigInvalid',
  'Field time bounds must be HH:mm wall-clock times': 'fieldConfigInvalid',
  'Select fields must define at least one option': 'fieldConfigInvalid',
  'Select option ids must be unique and non-empty': 'fieldConfigInvalid',
  'Selection bounds must be finite numbers': 'fieldConfigInvalid',
  'Maximum selections must not be less than minimum selections': 'fieldConfigInvalid',
  'Minimum selections must not exceed the number of options': 'fieldConfigInvalid',
  'Maximum selections must not exceed the number of options': 'fieldConfigInvalid',
};

/**
 * The one client-side interpretation of Convex's stable error contract.
 * It reads structured `ConvexError.data`, never a rendered stack/message.
 */
export function presentConvexError(error: unknown): ConvexErrorPresentation {
  if (!(error instanceof ConvexError)) return 'generic';

  switch (error.data) {
    case 'Not found or inaccessible':
      return 'notFound';
    case 'Unauthenticated':
      return 'unauthenticated';
    case 'Conflict':
      return 'conflict';
    default:
      return typeof error.data === 'string'
        ? fieldInvalidInputPresentation[error.data] ?? 'generic'
        : 'generic';
  }
}

export type ConvexErrorMessageKey =
  | 'errors.notFound'
  | 'errors.fieldKeyInvalid'
  | 'errors.fieldKeyTaken'
  | 'errors.fieldKeyBuiltin'
  | 'errors.fieldDescriptionTooLong'
  | 'errors.fieldSemanticIncompatible'
  | 'errors.fieldHistoricalFrozen'
  | 'errors.fieldArchived'
  | 'errors.fieldDeleteBlocked'
  | 'errors.fieldConfigInvalid'
  | 'errors.generic';

export function errorMessageKey(presentation: ConvexErrorPresentation): ConvexErrorMessageKey {
  switch (presentation) {
    case 'notFound': return 'errors.notFound';
    case 'fieldKeyInvalid': return 'errors.fieldKeyInvalid';
    case 'fieldKeyTaken': return 'errors.fieldKeyTaken';
    case 'fieldKeyBuiltin': return 'errors.fieldKeyBuiltin';
    case 'fieldDescriptionTooLong': return 'errors.fieldDescriptionTooLong';
    case 'fieldSemanticIncompatible': return 'errors.fieldSemanticIncompatible';
    case 'fieldHistoricalFrozen': return 'errors.fieldHistoricalFrozen';
    case 'fieldArchived': return 'errors.fieldArchived';
    case 'fieldDeleteBlocked': return 'errors.fieldDeleteBlocked';
    case 'fieldConfigInvalid': return 'errors.fieldConfigInvalid';
    default: return 'errors.generic';
  }
}
