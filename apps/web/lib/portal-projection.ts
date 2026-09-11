import type { FunctionReturnType } from 'convex/server';

import type { api } from '@priamo/convex/api';

import { formatDate, formatDateTime, formatNumber, formatTime } from '@/i18n/formats';
import type { CanonicalLocale } from '@/i18n/locales';
import { semanticTypeMessageKey } from '@/i18n/vocab-keys';

type AssignmentDetail = FunctionReturnType<typeof api.assignments.queries.getAssignmentDetail>;
export type ProjectionEntry = AssignmentDetail['serviceProjection'][number];
type ProjectionSemanticType = ProjectionEntry['semanticType'];

export type ProjectionGroup = 'service' | 'route' | 'passengers' | 'aviation' | 'contact';

const projectionGroupBySemanticType = {
  serviceName: 'service',
  serviceDate: 'service',
  serviceTime: 'service',
  serviceLocation: 'service',
  'transport.origin': 'route',
  'transport.destination': 'route',
  'passenger.count': 'passengers',
  'aviation.flightNumber': 'aviation',
  'aviation.terminal': 'aviation',
  'contact.primary': 'contact',
  'general.notes': 'contact',
} as const satisfies Record<ProjectionSemanticType, ProjectionGroup>;

export type PreparedProjectionEntry = ProjectionEntry & {
  semanticLabelKey: (typeof semanticTypeMessageKey)[ProjectionSemanticType];
};

export type ProjectionEntryGroup = {
  group: ProjectionGroup;
  entries: PreparedProjectionEntry[];
};

/**
 * Adds code-owned labels and groups only adjacent fields. This preserves the
 * backend's service-kind position order exactly, even when a tenant interleaves
 * semantic categories; a category may therefore occur more than once.
 */
export function prepareProjectionGroups(entries: readonly ProjectionEntry[]): ProjectionEntryGroup[] {
  const groups: ProjectionEntryGroup[] = [];
  for (const entry of entries) {
    const group = projectionGroupBySemanticType[entry.semanticType];
    const prepared: PreparedProjectionEntry = {
      ...entry,
      semanticLabelKey: semanticTypeMessageKey[entry.semanticType],
    };
    const current = groups.at(-1);
    if (current?.group === group) current.entries.push(prepared);
    else groups.push({ group, entries: [prepared] });
  }
  return groups;
}

export function formatProjectionValue(
  locale: CanonicalLocale,
  entry: ProjectionEntry,
  fallback: string,
): string {
  switch (entry.value.kind) {
    case 'text':
    case 'longText':
      return entry.value.value;
    case 'number':
      return formatNumber(locale, entry.value.value);
    case 'boolean':
      return entry.value.value ? '✓' : '—';
    case 'date':
      return formatDate(locale, entry.value.value);
    case 'datetime':
      return formatDateTime(locale, entry.value.value);
    case 'time':
      return formatTime(locale, entry.value.value);
    case 'location':
      return projectionLocationLabel(entry.locationName, fallback);
    // No projected semantic currently permits either select kind, and the
    // response intentionally carries no catalogue labels to resolve them.
    case 'select':
    case 'multiSelect':
      return fallback;
  }
}

export function projectionLocationLabel(locationName: string | undefined, fallback: string): string {
  return locationName ?? fallback;
}
