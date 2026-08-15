import type { SemanticType } from '@sancocho/convex/validators';

import type { CanonicalLocale } from './locales';
import { messagesForLocale } from './messages';

/**
 * Only the code-owned semantic type may select a localized built-in label.
 * Tenant-authored keys and labels are always rendered as entered.
 */
export function builtinFieldLabel(locale: CanonicalLocale, semanticType: SemanticType | undefined, storedLabel: string): string {
  if (semanticType === undefined) return storedLabel;
  const semanticTypes = messagesForLocale(locale).fields.semanticTypes;
  return semanticTypes[semanticType]?.label ?? storedLabel;
}
