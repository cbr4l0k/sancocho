'use client';

import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';

import { OccupancyCard } from './occupancy-card';
import { SemanticByProjectPanel, SemanticByStatusPanel } from './semantic-breakdown-panels';
import { SemanticTotalCard } from './semantic-total-card';
import type { OrganizationId, ResolvedStatisticsFilters } from './statistics-types';

/**
 * The domain metrics the semantic registry unlocks — the reason this stage
 * exists (`docs/statistics.md` "Semantic aggregation"): `passenger.count`
 * carries `passengerTotals` + `occupancyMetrics`, `accessibility.wheelchairCount`
 * carries `accessibilityRequirements`. Nothing here reads a field key or
 * label; every number below comes straight from a query keyed on the
 * capability, computed by the backend's semantic registry.
 *
 * Two truncation samples live in this one panel and are kept visually
 * distinct per section, never captioned together: the totals and occupancy
 * cards share ONE combined 500-event scan across every status
 * (`scanEventsForFilter`), while the by-project/by-status breakdowns below
 * them are exact maintained counters with no cap at all. Each section's own
 * caption says which is which — see `docs/statistics.md:340-344`.
 */
/*
 * The panels below deliberately do NOT set `h-full`, unlike the single-panel
 * modules elsewhere on this screen. There `h-full` equalises a panel against
 * its neighbour in the same bento row. Here three panels are stacked inside one
 * `BentoItem`, so `h-full` asked each sibling to be the full height of the box
 * all three share — which pinned the panel's height independently of its
 * content and let `Panel`'s `overflow-hidden` clip the occupancy column's last
 * lines once the threshold caption appeared.
 */
export function SemanticMetricsPanel({
  organizationId,
  filters,
}: {
  organizationId: OrganizationId;
  filters: ResolvedStatisticsFilters;
}) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader>
          <PanelTitle>{t('statistics.semanticTitle')}</PanelTitle>
          <PanelDescription>{t('statistics.semanticSampleNotice', { limit: 500 })}</PanelDescription>
        </PanelHeader>
        <PanelBody className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <SemanticTotalCard query={api.statistics.queries.getPassengerTotals} title={t('fields.semanticTypes.passenger_count.label')} filters={filters} />
          <SemanticTotalCard
            query={api.statistics.queries.getAccessibilityRequirements}
            title={t('fields.semanticTypes.accessibility_wheelchairCount.label')}
            filters={filters}
          />
          <OccupancyCard filters={filters} />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>{t('statistics.byProjectTitle')}</PanelTitle>
          <PanelDescription>{t('statistics.orgWideNotice')}</PanelDescription>
        </PanelHeader>
        <PanelBody className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <SemanticByProjectPanel
            query={api.statistics.queries.getPassengerTotalsByProject}
            title={t('fields.semanticTypes.passenger_count.label')}
            organizationId={organizationId}
          />
          <SemanticByProjectPanel
            query={api.statistics.queries.getAccessibilityByProject}
            title={t('fields.semanticTypes.accessibility_wheelchairCount.label')}
            organizationId={organizationId}
          />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>{t('statistics.byStatusTitle')}</PanelTitle>
          <PanelDescription>{t('statistics.orgWideNotice')}</PanelDescription>
        </PanelHeader>
        <PanelBody className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <SemanticByStatusPanel
            query={api.statistics.queries.getPassengerTotalsByStatus}
            title={t('fields.semanticTypes.passenger_count.label')}
            organizationId={organizationId}
          />
          <SemanticByStatusPanel
            query={api.statistics.queries.getAccessibilityByStatus}
            title={t('fields.semanticTypes.accessibility_wheelchairCount.label')}
            organizationId={organizationId}
          />
        </PanelBody>
      </Panel>
    </div>
  );
}
