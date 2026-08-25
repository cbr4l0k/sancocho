'use client';

import { useQuery, usePaginatedQuery } from 'convex/react';
import type { FunctionReference } from 'convex/server';
import { useTranslations } from 'next-intl';

import { api } from '@sancocho/convex/api';

import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableLoadMore, TableRow, TableRowHeaderCell } from '@/components/ui/table';
import { formatNumber } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import type { EventStatus } from '@/lib/status';

import { StatusBarList, type StatusBarRow } from './status-bar-list';
import type { OrganizationId } from './statistics-types';

type ByProjectQuery = typeof api.statistics.queries.getPassengerTotalsByProject | typeof api.statistics.queries.getAccessibilityByProject;
type ByStatusQuery = typeof api.statistics.queries.getPassengerTotalsByStatus | typeof api.statistics.queries.getAccessibilityByStatus;

/**
 * Passenger/accessibility totals by project — an EXACT, maintained-counter
 * breakdown (`docs/statistics.md`: the `project` dimension is updated
 * wherever `eventFieldValues` is written), never truncated and never
 * affected by the filter bar above. Rendered as a table rather than a chart:
 * unlike the project/recipe breakdown bars, this needs two numbers per row
 * (a sum AND an event count) that a single bar length cannot honestly convey
 * at once.
 */
export function SemanticByProjectPanel({
  query,
  title,
  organizationId,
}: {
  query: ByProjectQuery & FunctionReference<'query'>;
  title: string;
  organizationId: OrganizationId;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const breakdown = usePaginatedQuery(query, { organizationId }, { initialNumItems: 10 });

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {breakdown.status === 'LoadingFirstPage' ? (
        <Skeleton className="h-32 w-full" />
      ) : breakdown.results.length === 0 ? (
        <EmptyState tone="empty" title={t('statistics.notConfiguredTitle')} description={t('statistics.notConfiguredBody')} />
      ) : (
        <>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('statistics.byProjectColumn')}</TableHeaderCell>
                <TableHeaderCell align="end">{t('statistics.totalLabel')}</TableHeaderCell>
                <TableHeaderCell align="end">{t('services.title')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {breakdown.results.map((row) => (
                <TableRow key={row.project._id}>
                  <TableRowHeaderCell>{row.project.name}</TableRowHeaderCell>
                  <TableCell align="end" mono>
                    {formatNumber(locale, row.sum)}
                  </TableCell>
                  <TableCell align="end" mono>
                    {formatNumber(locale, row.count)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TableLoadMore status={breakdown.status} loadedCount={breakdown.results.length} onLoadMore={breakdown.loadMore} pageSize={10} />
        </>
      )}
    </div>
  );
}

/**
 * Passenger/accessibility totals by status — also exact and unfiltered
 * (maintained via `moveSemanticStatusBuckets` on every status transition).
 * Rendered with the same status-tone bar list as the headline service-status
 * panel, for the same reason: this IS a status-keyed chart, so the shape
 * channel belongs here too, not a generic palette.
 */
export function SemanticByStatusPanel({
  query,
  title,
  organizationId,
}: {
  query: ByStatusQuery & FunctionReference<'query'>;
  title: string;
  organizationId: OrganizationId;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const rows: readonly { status: EventStatus; sum: number; count: number }[] | undefined = useQuery(query, { organizationId });
  const barRows: StatusBarRow[] | undefined = rows?.map((row) => ({
    key: row.status,
    selection: { kind: 'service' as const, status: row.status },
    label: t('statistics.byStatusRowLabel', { status: t(`services.statuses.${row.status}`), count: formatNumber(locale, row.count) }),
    count: { value: row.sum, isTruncated: false },
  }));

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {rows === undefined || barRows === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState tone="empty" title={t('statistics.notConfiguredTitle')} description={t('statistics.notConfiguredBody')} />
      ) : (
        <StatusBarList rows={barRows} max={Math.max(1, ...rows.map((row) => row.sum))} />
      )}
    </div>
  );
}
