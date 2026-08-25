import { projectStatuses, serviceStatuses, type EventStatus, type ProjectStatus } from '@/lib/status';

/**
 * Orders a backend status-count breakdown into the fixed, exhaustive display
 * order `lib/status.ts` already defines for status vocabulary elsewhere (from
 * least to most settled), and fills in any status the backend happened not to
 * return with a real zero row rather than letting it silently vanish from the
 * chart.
 *
 * The return type is built from a `Record<EventStatus, …>` / `Record<ProjectStatus,
 * …>` literal, so — mirroring the exhaustive `Record`s this backend and
 * `lib/status.ts` already require — a status added to the backend union
 * without a corresponding branch here fails `tsc`, instead of silently
 * missing from the dashboard.
 */
export type ServiceStatusCount = { status: EventStatus; count: number; isTruncated: boolean };
export type OrderedServiceStatusRow = { status: EventStatus; count: number; isTruncated: boolean };

export function orderServiceStatusCounts(rows: readonly ServiceStatusCount[]): OrderedServiceStatusRow[] {
  const byStatus = new Map(rows.map((row) => [row.status, row]));
  const table: Record<EventStatus, { count: number; isTruncated: boolean }> = {
    draft: byStatus.get('draft') ?? { count: 0, isTruncated: false },
    planned: byStatus.get('planned') ?? { count: 0, isTruncated: false },
    confirmed: byStatus.get('confirmed') ?? { count: 0, isTruncated: false },
    active: byStatus.get('active') ?? { count: 0, isTruncated: false },
    completed: byStatus.get('completed') ?? { count: 0, isTruncated: false },
    cancelled: byStatus.get('cancelled') ?? { count: 0, isTruncated: false },
  };
  return serviceStatuses.map((status) => ({ status, ...table[status] }));
}

export type ProjectStatusCount = { status: ProjectStatus; count: number };
export type OrderedProjectStatusRow = { status: ProjectStatus; count: number };

export function orderProjectStatusCounts(rows: readonly ProjectStatusCount[]): OrderedProjectStatusRow[] {
  const byStatus = new Map(rows.map((row) => [row.status, row.count]));
  const table: Record<ProjectStatus, number> = {
    draft: byStatus.get('draft') ?? 0,
    active: byStatus.get('active') ?? 0,
    completed: byStatus.get('completed') ?? 0,
    archived: byStatus.get('archived') ?? 0,
  };
  return projectStatuses.map((status) => ({ status, count: table[status] }));
}

/** The largest count in a row set, floored at 1 so a proportional bar never divides by zero. */
export function maxCount(rows: readonly { count: number }[]): number {
  return Math.max(1, ...rows.map((row) => row.count));
}
