'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Bento, BentoItem } from '@/components/ui/bento';
import { PageHeader } from '@/components/ui/page-header';
import { resolveDateRangeFilter } from '@/lib/statistics-date-range';

import { ProjectBreakdownPanel, RecipeBreakdownPanel } from './breakdown-panels';
import { OrgOverviewPanel } from './org-overview-panel';
import { SemanticMetricsPanel } from './semantic-metrics-panel';
import { ServiceStatusPanel } from './service-status-panel';
import { StatisticsFilters, type StatisticsFilterState } from './statistics-filters';
import type { ResolvedStatisticsFilters } from './statistics-types';
import { UpcomingServicesPanel } from './upcoming-services-panel';

const emptyFilterState: StatisticsFilterState = { projectId: undefined, dateRange: { from: '', to: '' } };

/**
 * The statistics screen: an operational overview scoped to the current
 * organization and (per an explicit product decision recorded in the issue)
 * to the active project/date filter for every panel that has a real
 * project/date dimension.
 *
 * Layout follows `docs/web-design.md` §10's bento rules: one focal panel
 * (services by status, the number most likely to be read first), an 8/4 lead
 * row, then 6/6 and 4/4/4 working rows, never more than three modules per row.
 */
export function StatisticsSurface() {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const [filterState, setFilterState] = useState<StatisticsFilterState>(emptyFilterState);

  if (currentOrganization === null) return null;

  const organizationId = currentOrganization.organization._id;
  const resolvedRange = resolveDateRangeFilter(filterState.dateRange);
  const dateRangeInvalid = resolvedRange === 'invalid';
  const filters: ResolvedStatisticsFilters = {
    organizationId,
    projectId: filterState.projectId,
    startsAt: resolvedRange === 'invalid' ? undefined : resolvedRange.startsAt,
    endsAt: resolvedRange === 'invalid' ? undefined : resolvedRange.endsAt,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('statistics.title')} />
      <StatisticsFilters organizationId={organizationId} state={filterState} onChange={setFilterState} dateRangeInvalid={dateRangeInvalid} />

      <Bento>
        <BentoItem span={8}>
          <ServiceStatusPanel filters={filters} />
        </BentoItem>
        <BentoItem span={4}>
          <OrgOverviewPanel organizationId={organizationId} />
        </BentoItem>
        <BentoItem span={12}>
          <UpcomingServicesPanel organizationId={organizationId} />
        </BentoItem>
        <BentoItem span={6}>
          <ProjectBreakdownPanel organizationId={organizationId} />
        </BentoItem>
        <BentoItem span={6}>
          <RecipeBreakdownPanel organizationId={organizationId} />
        </BentoItem>
        <BentoItem span={12}>
          <SemanticMetricsPanel organizationId={organizationId} filters={filters} />
        </BentoItem>
      </Bento>
    </div>
  );
}
