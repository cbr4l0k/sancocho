'use client';

import { useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@sancocho/convex/api';

import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldLabel } from '@/components/ui/field';
import { PanelMetric } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { hasOccupancySample } from '@/lib/statistics-truncation';

import { filterQueryArgs, type ResolvedStatisticsFilters } from './statistics-types';

/**
 * Occupancy is a distribution of `passenger.count` across matching services
 * (mean/median/max, and — given a threshold — how many services met it), NOT
 * a chart: the backend hands back four summary numbers, not a full
 * distribution, so plotting a histogram here would be inventing a shape the
 * data does not have. `docs/statistics.md` is explicit this is the one
 * statistic that is never a maintained counter and always a bounded, capped
 * scan sharing the SAME combined 500-event sample as the passenger/
 * accessibility totals beside it.
 */
export function OccupancyCard({ filters }: { filters: ResolvedStatisticsFilters }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const [thresholdInput, setThresholdInput] = useState('');
  const threshold = parseThreshold(thresholdInput);

  const result = useQuery(api.statistics.queries.getOccupancyMetrics, {
    ...filterQueryArgs(filters),
    ...(threshold === undefined ? {} : { threshold }),
  });

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-ink">{t('statistics.occupancyTitle')}</h3>
      {result === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : hasOccupancySample(result.sampleSize) ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <PanelMetric label={t('statistics.occupancyMean')} value={formatMaybeNumber(locale, result.mean, t('common.notAvailable'))} />
            <PanelMetric label={t('statistics.occupancyMedian')} value={formatMaybeNumber(locale, result.median, t('common.notAvailable'))} />
            <PanelMetric label={t('statistics.occupancyMax')} value={formatMaybeNumber(locale, result.max, t('common.notAvailable'))} />
          </div>
          <Field className="w-40">
            <FieldLabel>{t('statistics.occupancyThresholdLabel')}</FieldLabel>
            <FieldControl
              type="number"
              min={0}
              step={1}
              value={thresholdInput}
              onChange={(event) => setThresholdInput(event.target.value)}
            />
          </Field>
          {threshold !== undefined ? (
            <p className="text-sm text-ink-2">
              {t('statistics.occupancyThresholdCount', {
                count: formatMaybeNumber(locale, result.countAtOrAboveThreshold, t('common.notAvailable')),
              })}
            </p>
          ) : null}
          <p className="text-xs text-ink-3">
            {t('statistics.occupancySampleSize', { count: formatNumber(locale, result.sampleSize) })}
          </p>
          {result.isTruncated ? <p className="text-xs text-ink-3">{t('statistics.truncatedHintSample', { limit: 500 })}</p> : null}
        </>
      ) : (
        <EmptyState tone="empty" title={t('statistics.notConfiguredTitle')} description={t('statistics.notConfiguredBody')} />
      )}
    </div>
  );
}

function parseThreshold(input: string): number | undefined {
  if (input.trim() === '') return undefined;
  const parsed = Number(input);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatMaybeNumber(locale: Parameters<typeof formatNumber>[0], value: number | null, notAvailable: string): string {
  return value === null ? notAvailable : formatNumber(locale, value);
}
