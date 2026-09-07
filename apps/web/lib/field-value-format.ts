import type { fieldConfigValidator } from '@priamo/convex/validators';

import { formatDate, formatDateTime, formatNumber, formatTime } from '@/i18n/formats';
import type { CanonicalLocale } from '@/i18n/locales';
import type { ServiceFieldValue } from '@/lib/field-value-form';

type FieldConfig = typeof fieldConfigValidator.type;

/**
 * Renders one stored field value as plain text.
 *
 * It lives here rather than inside a surface because two surfaces now render
 * the same values — the detail screen's value list and the Services table's
 * service-kind-driven columns — and because the table uses this string as the
 * column's accessor value, so searching and sorting a column agree with what
 * the cell displays instead of operating on a discriminated union nobody can
 * compare.
 *
 * `config` is the service's IMMUTABLE service kind snapshot, which is what resolves a
 * select's option ids to labels: an option renamed in the live field definition
 * must not silently retitle a historical value (I3). Option labels and location
 * names are tenant-authored text, rendered exactly as stored and never
 * translated.
 */
export function formatFieldValue(
  locale: CanonicalLocale,
  config: FieldConfig,
  value: ServiceFieldValue,
  /** Shown when a reference cannot be named — the id itself is not information. */
  fallback: string,
  locationName?: string | undefined,
): string {
  switch (value.kind) {
    case 'text':
    case 'longText':
      return value.value;
    case 'number':
      return formatNumber(locale, value.value);
    case 'boolean':
      return value.value ? '✓' : '—';
    case 'date':
      return formatDate(locale, value.value);
    case 'datetime':
      return formatDateTime(locale, value.value);
    case 'time':
      return formatTime(locale, value.value);
    case 'select':
      return config.kind === 'select'
        ? (config.options.find((option) => option.id === value.optionId)?.label ?? fallback)
        : fallback;
    case 'multiSelect':
      return config.kind === 'multiSelect'
        ? value.optionIds.map((id) => config.options.find((option) => option.id === id)?.label ?? fallback).join(', ')
        : fallback;
    case 'location':
      return locationName ?? fallback;
  }
}
