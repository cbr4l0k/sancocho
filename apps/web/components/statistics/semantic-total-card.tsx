'use client';

import { useQuery } from 'convex/react';
import type { FunctionReference } from 'convex/server';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { EmptyState } from '@/components/ui/empty-state';
import { PanelMetric } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { formatTruncatableValue, hasSemanticData } from '@/lib/statistics-truncation';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';

import { filterQueryArgs, type ResolvedStatisticsFilters } from './statistics-types';

type SemanticTotalQuery = typeof api.statistics.queries.getPassengerTotals | typeof api.statistics.queries.getAccessibilityRequirements;

/**
 * One filtered semantic total (passenger count or wheelchair count), shared
 * by both metrics since `getPassengerTotals`/`getAccessibilityRequirements`
 * return the identical `{ total, eventCount }` shape.
 *
 * When `eventCount.value === 0` this renders `statistics.notConfiguredBody`
 * rather than "0" — see `lib/statistics-truncation.ts`'s `hasSemanticData`
 * doc comment for why zero and "not tracked" cannot be told apart from this
 * query alone, and why the honest copy has to stay non-committal about which
 * one it is.
 */
export function SemanticTotalCard({
  query,
  title,
  filters,
}: {
  query: SemanticTotalQuery & FunctionReference<'query'>;
  title: string;
  filters: ResolvedStatisticsFilters;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const result = useQuery(query, filterQueryArgs(filters));

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {result === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : hasSemanticData(result.eventCount) ? (
        <>
          <PanelMetric label={t('statistics.totalLabel')} value={formatTruncatableValue(locale, result.total)} />
          <p className="text-xs text-ink-3">{t('statistics.eventsWithData', { count: formatTruncatableValue(locale, result.eventCount) })}</p>
          {result.total.isTruncated || result.eventCount.isTruncated ? (
            <p className="text-xs text-ink-3">{t('statistics.truncatedHintSample', { limit: 500 })}</p>
          ) : null}
        </>
      ) : (
        <EmptyState tone="empty" title={t('statistics.notConfiguredTitle')} description={t('statistics.notConfiguredBody')} />
      )}
    </div>
  );
}
