'use client';

import { usePaginatedQuery } from 'convex/react';
import { useTranslations } from 'next-intl';

import { api } from '@sancocho/convex/api';

import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBodyFlush, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { TableLoadMore } from '@/components/ui/table';

import { BreakdownBarChart, type BreakdownDatum } from './breakdown-bar-chart';
import type { OrganizationId } from './statistics-types';

const pageSize = 25;

/**
 * Project and recipe breakdowns are organization-wide by design (not part of
 * the filtered family — `docs/statistics.md`), and the chart only ever draws
 * the rows already fetched: exactly the "client-side operations never
 * pretend to have queried the server" rule `docs/web-design.md` §6 states for
 * tables, applied to a chart instead of a table.
 */
export function ProjectBreakdownPanel({ organizationId }: { organizationId: OrganizationId }) {
  const t = useTranslations();
  const breakdown = usePaginatedQuery(api.statistics.queries.getProjectBreakdown, { organizationId }, { initialNumItems: pageSize });

  const data: BreakdownDatum[] = breakdown.results.map((row) => ({ key: row.project._id, label: row.project.name, count: row.count }));

  return (
    <Panel className="h-full">
      <PanelHeader>
        <PanelTitle>{t('statistics.projectBreakdownTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBodyFlush>
        <div className="px-5 py-4 sm:px-6">
          {breakdown.status === 'LoadingFirstPage' ? (
            <Skeleton className="h-40 w-full" />
          ) : data.length === 0 ? (
            <EmptyState tone="empty" title={t('statistics.breakdownEmptyTitle')} description={t('statistics.breakdownEmptyBody')} />
          ) : (
            <BreakdownBarChart data={data} countLabel={t('statistics.breakdownCount')} />
          )}
        </div>
        <TableLoadMore status={breakdown.status} loadedCount={breakdown.results.length} onLoadMore={breakdown.loadMore} />
      </PanelBodyFlush>
    </Panel>
  );
}

export function RecipeBreakdownPanel({ organizationId }: { organizationId: OrganizationId }) {
  const t = useTranslations();
  const breakdown = usePaginatedQuery(api.statistics.queries.getRecipeBreakdown, { organizationId }, { initialNumItems: pageSize });

  const data: BreakdownDatum[] = breakdown.results.map((row) => ({ key: row.recipe._id, label: row.recipe.name, count: row.count }));

  return (
    <Panel className="h-full">
      <PanelHeader>
        <PanelTitle>{t('statistics.recipeBreakdownTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBodyFlush>
        <div className="px-5 py-4 sm:px-6">
          {breakdown.status === 'LoadingFirstPage' ? (
            <Skeleton className="h-40 w-full" />
          ) : data.length === 0 ? (
            <EmptyState tone="empty" title={t('statistics.breakdownEmptyTitle')} description={t('statistics.breakdownEmptyBody')} />
          ) : (
            <BreakdownBarChart data={data} countLabel={t('statistics.breakdownCount')} />
          )}
        </div>
        <TableLoadMore status={breakdown.status} loadedCount={breakdown.results.length} onLoadMore={breakdown.loadMore} />
      </PanelBodyFlush>
    </Panel>
  );
}
