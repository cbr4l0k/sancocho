import type { CanonicalLocale } from './locales';
import { messagesForLocale } from './messages';

/** Tenant-authored labels are never translated; only known built-in keys use this catalogue. */
export function builtinFieldLabel(locale: CanonicalLocale, key: string, storedLabel: string): string {
  const semanticTypes = messagesForLocale(locale).fields.semanticTypes;
  const entry = Object.entries(semanticTypes).find(([semanticKey]) => semanticKey === key);
  return entry?.[1].label ?? storedLabel;
}
