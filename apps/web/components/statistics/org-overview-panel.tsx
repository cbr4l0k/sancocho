'use client';

import { useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { Panel, PanelBody, PanelHeader, PanelMetric, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { maxCount, orderProjectStatusCounts } from '@/lib/statistics-status-series';

import { StatusBarList } from './status-bar-list';
import type { OrganizationId } from './statistics-types';

/**
 * Project status counts, active recipe count, and location count — all
 * organization-wide, ALL-time, and deliberately unaffected by the filter bar.
 * `docs/statistics.md` explains why each was left out of the filtered-read
 * family: a recipe has no project, neither a recipe nor a location has a
 * `startsAt`, and filtering "count of projects by status" by a `projectId`
 * would be asking to filter projects by project. This module says so, rather
 * than leaving an operator to wonder why changing the filter bar never moves
 * these numbers.
 */
export function OrgOverviewPanel({ organizationId }: { organizationId: OrganizationId }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const projectCounts = useQuery(api.statistics.queries.getProjectStatusCounts, { organizationId });
  const activeRecipes = useQuery(api.statistics.queries.getActiveRecipeCount, { organizationId });
  const locations = useQuery(api.statistics.queries.getLocationCount, { organizationId });
  const rows =
    projectCounts === undefined
      ? undefined
      : orderProjectStatusCounts(projectCounts).map((row) => ({
          key: row.status,
          selection: { kind: 'project' as const, status: row.status },
          label: t(`projects.statuses.${row.status}`),
          count: { value: row.count, isTruncated: false },
        }));

  return (
    <Panel className="h-full">
      <PanelHeader>
        <PanelTitle>{t('statistics.projectStatusTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody className="gap-5">
        {projectCounts === undefined || rows === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <StatusBarList rows={rows} max={maxCount(projectCounts)} />
        )}
        <div className="grid grid-cols-2 gap-4 border-t border-line pt-4">
          <PanelMetric
            label={t('statistics.activeRecipes')}
            value={activeRecipes === undefined ? <Skeleton className="h-8 w-12" /> : formatNumber(locale, activeRecipes)}
          />
          <PanelMetric
            label={t('statistics.locations')}
            value={locations === undefined ? <Skeleton className="h-8 w-12" /> : formatNumber(locale, locations)}
          />
        </div>
        <p className="text-xs text-ink-3">{t('statistics.orgWideNotice')}</p>
      </PanelBody>
    </Panel>
  );
}
