import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import type { PaginationStatus } from 'convex/react';

import { api } from '@priamo/convex/api';

type CoordinatorArgs = Omit<FunctionArgs<typeof api.assignments.queries.listDispatchDay>, 'paginationOpts'>;
type ProviderArgs = Omit<FunctionArgs<typeof api.assignments.queries.listProviderDispatchDay>, 'paginationOpts'>;
type CoordinatorFilterValues = Pick<CoordinatorArgs, 'eventId' | 'status' | 'providerId' | 'costCentreId'>;
type CoordinatorFilters = { [Key in keyof CoordinatorFilterValues]?: CoordinatorFilterValues[Key] | undefined };
type ProviderFilters = { status?: ProviderArgs['status'] | undefined };
type ReadinessArgs = FunctionArgs<typeof api.assignments.queries.dispatchDayReadiness>;
type ReadinessFilters = { eventId?: ReadinessArgs['eventId'] | undefined };
export type ProviderDispatchEntry = FunctionReturnType<
  typeof api.assignments.queries.listProviderDispatchDay
>['page'][number];

export function coordinatorDispatchArgs(
  projectId: CoordinatorArgs['projectId'],
  day: Pick<CoordinatorArgs, 'from' | 'to'>,
  filters: CoordinatorFilters,
): CoordinatorArgs {
  return {
    projectId,
    from: day.from,
    to: day.to,
    ...(filters.eventId === undefined ? {} : { eventId: filters.eventId }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.providerId === undefined ? {} : { providerId: filters.providerId }),
    ...(filters.costCentreId === undefined ? {} : { costCentreId: filters.costCentreId }),
  };
}

export function providerDispatchArgs(
  projectId: ProviderArgs['projectId'],
  day: Pick<ProviderArgs, 'from' | 'to'>,
  filters: ProviderFilters,
): ProviderArgs {
  return {
    projectId,
    from: day.from,
    to: day.to,
    ...(filters.status === undefined ? {} : { status: filters.status }),
  };
}

export function dispatchDayReadinessArgs(
  projectId: ReadinessArgs['projectId'],
  day: Pick<ReadinessArgs, 'from' | 'to'>,
  filters: ReadinessFilters,
): ReadinessArgs {
  return {
    projectId,
    from: day.from,
    to: day.to,
    ...(filters.eventId === undefined ? {} : { eventId: filters.eventId }),
  };
}

export function visibleCoordinatorDispatchEntries<Entry extends { rows: readonly unknown[] }>(
  entries: readonly Entry[],
): Entry[] {
  return entries.filter((entry) => entry.rows.length > 0);
}

export type DispatchSheetCompleteness = { kind: 'complete' } | { kind: 'loadedOnly' };

export function dispatchSheetCompleteness(status: PaginationStatus): DispatchSheetCompleteness {
  return status === 'Exhausted' ? { kind: 'complete' } : { kind: 'loadedOnly' };
}

export type ReadinessDisplay = { kind: 'exact' | 'atLeast'; count: number };

export function readinessDisplay(readiness: { unassigned: number; complete: boolean }): ReadinessDisplay {
  return readiness.complete
    ? { kind: 'exact', count: readiness.unassigned }
    : { kind: 'atLeast', count: readiness.unassigned };
}

export type ProviderDispatchGroup = {
  service: ProviderDispatchEntry['service'];
  serviceProjection: ProviderDispatchEntry['serviceProjection'];
  entries: ProviderDispatchEntry[];
};

/** Merges flat accumulated pages, retaining assignment order inside each Service. */
export function groupProviderDispatch(entries: readonly ProviderDispatchEntry[]): ProviderDispatchGroup[] {
  const groups = new Map<string, ProviderDispatchGroup>();
  for (const entry of entries) {
    const key = String(entry.service._id);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        service: entry.service,
        serviceProjection: entry.serviceProjection,
        entries: [entry],
      });
    } else {
      existing.entries.push(entry);
    }
  }
  return [...groups.values()].sort((left, right) => left.service.startsAt - right.service.startsAt);
}
