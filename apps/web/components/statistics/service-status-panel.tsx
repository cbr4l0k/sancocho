'use client';

import { useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';

import { api } from '@sancocho/convex/api';

import { Panel, PanelBody, PanelHeader, PanelMetric, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { maxCount, orderServiceStatusCounts } from '@/lib/statistics-status-series';
import { formatNumber } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';

import { StatusBarList } from './status-bar-list';
import { filterQueryArgs, type ResolvedStatisticsFilters } from './statistics-types';

/**
 * The screen's one focal panel: services by status, scoped to the active
 * filter. This is the query family that caps EACH status independently at
 * 500 (`getFilteredServiceStatusCounts` — `docs/statistics.md`), so a heavily
 * filtered organization can legitimately report close to 3,000 services
 * combined here. That sample shape is DIFFERENT from the semantic metrics
 * panel below (one combined 500-event cap across every status), which is why
 * the two live in visually separate panels with their own, differently
 * worded truncation captions rather than a single shared note.
 */
export function ServiceStatusPanel({ filters }: { filters: ResolvedStatisticsFilters }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const counts = useQuery(api.statistics.queries.getFilteredServiceStatusCounts, filterQueryArgs(filters));
  const rows =
    counts === undefined
      ? undefined
      : orderServiceStatusCounts(counts).map((row) => ({
          key: row.status,
          selection: { kind: 'service' as const, status: row.status },
          label: t(`services.statuses.${row.status}`),
          count: { value: row.count, isTruncated: row.isTruncated },
        }));

  return (
    <Panel emphasis="focal" className="h-full">
      <PanelHeader>
        <PanelTitle>{t('statistics.serviceStatusTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        {counts === undefined || rows === undefined ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <PanelMetric
              label={t('statistics.serviceStatusTotal')}
              value={formatNumber(
                locale,
                counts.reduce((sum, row) => sum + row.count, 0),
              )}
            />
            <StatusBarList rows={rows} max={maxCount(counts)} className="mt-2" />
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
