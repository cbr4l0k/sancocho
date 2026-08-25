'use client';

import { usePaginatedQuery } from 'convex/react';
import { useTranslations } from 'next-intl';

import { api } from '@sancocho/convex/api';

import { Button } from '@/components/ui/button';
import { Field, FieldControl, FieldLabel } from '@/components/ui/field';
import { Panel, PanelBody } from '@/components/ui/panel';

import type { OrganizationId, ProjectId } from './statistics-types';

export type DateRangeInputState = { from: string; to: string };

export type StatisticsFilterState = {
  projectId: ProjectId | undefined;
  dateRange: DateRangeInputState;
};

/**
 * The project + date-range filter bar. Applies to every panel with a real
 * project/date dimension — an explicit product decision recorded in the
 * issue — but NOT to the organization-wide tiles (project status counts,
 * active recipes, locations, the project/recipe breakdowns): those have no
 * project or date axis on the backend (see `docs/statistics.md`, "Which
 * existing queries did NOT get a filter, and why"), and each panel that stays
 * unfiltered says so explicitly rather than leaving it ambiguous.
 */
export function StatisticsFilters({
  organizationId,
  state,
  onChange,
  dateRangeInvalid,
}: {
  organizationId: OrganizationId;
  state: StatisticsFilterState;
  onChange: (next: StatisticsFilterState) => void;
  dateRangeInvalid: boolean;
}) {
  const t = useTranslations();
  const projects = usePaginatedQuery(api.projects.queries.listProjects, { organizationId }, { initialNumItems: 50 });

  const hasFilters = state.projectId !== undefined || state.dateRange.from !== '' || state.dateRange.to !== '';

  return (
    <Panel>
      <PanelBody className="flex-row flex-wrap items-end gap-4 py-4 sm:py-4">
        <Field className="w-full sm:w-56">
          <FieldLabel>{t('statistics.projectFilterLabel')}</FieldLabel>
          <FieldControl
            render={<select />}
            value={state.projectId ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              const next = projects.results.find((project) => project._id === value);
              onChange({ ...state, projectId: next?._id });
            }}
          >
            <option value="">{t('statistics.allProjects')}</option>
            {projects.results.map((project) => (
              <option key={project._id} value={project._id}>
                {project.name}
              </option>
            ))}
          </FieldControl>
          {projects.status === 'CanLoadMore' ? (
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => projects.loadMore(50)}>
              {t('statistics.loadMoreProjects')}
            </Button>
          ) : null}
        </Field>

        <Field className="w-full sm:w-44">
          <FieldLabel>{t('statistics.fromLabel')}</FieldLabel>
          <FieldControl
            type="date"
            value={state.dateRange.from}
            onChange={(event) => onChange({ ...state, dateRange: { ...state.dateRange, from: event.target.value } })}
          />
        </Field>

        <Field className="w-full sm:w-44">
          <FieldLabel>{t('statistics.toLabel')}</FieldLabel>
          <FieldControl
            type="date"
            value={state.dateRange.to}
            onChange={(event) => onChange({ ...state, dateRange: { ...state.dateRange, to: event.target.value } })}
          />
          {dateRangeInvalid ? <p className="text-xs text-tone-stop">{t('statistics.dateRangeInvalid')}</p> : null}
        </Field>

        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ projectId: undefined, dateRange: { from: '', to: '' } })}
          >
            {t('statistics.clearFilters')}
          </Button>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
