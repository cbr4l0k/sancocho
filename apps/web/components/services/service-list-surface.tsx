'use client';

import { usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import {
  createDataTableColumnHelper,
  DataTableContent,
  DataTableToolbar,
  selectionColumn,
  useDataTable,
  type DataTableColumn,
} from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelBodyFlush, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { TableLoadMore } from '@/components/ui/table';
import { formatDateTime } from '@/i18n/formats';
import { LocaleLink } from '@/i18n/locale-link';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { roleAtLeast } from '@/lib/roles';
import { serviceStatuses, type EventStatus } from '@/lib/status';
import { cn } from '@/lib/utils';

type ProjectId = FunctionArgs<typeof api.projects.queries.getProject>['projectId'];
type Project = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number];
type Service = FunctionReturnType<typeof api.events.queries.listProjectEvents>['page'][number];

/** Carries the chosen project into the create screen so it opens pre-filled. */
function newServiceHref(projectId: ProjectId | undefined): string {
  return projectId === undefined ? '/services/new' : `/services/new?projectId=${projectId}`;
}

export function ServiceListSurface({ initialProjectId }: { initialProjectId?: string }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    currentOrganization === null ? 'skip' : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );
  const [projectId, setProjectId] = useState<ProjectId | undefined>();
  const canCreate = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');
  if (currentOrganization === null) return null;
  const selectedProject = projects.results.find((project) => project._id === (projectId ?? initialProjectId));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={
          canCreate ? (
            <Button variant="primary" render={<LocaleLink to={newServiceHref(selectedProject?._id)} />}>
              {t('services.create')}
            </Button>
          ) : undefined
        }
      />
      {/* Projects are a standing choice, not a step: they sit in a rail beside
       * the table rather than in a panel stacked above it, so switching project
       * never pushes the services you came to read further down the page. */}
      <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <ProjectRail
          projects={projects.results}
          selectedProjectId={selectedProject?._id}
          onSelect={setProjectId}
          canLoadMore={projects.status === 'CanLoadMore'}
          onLoadMore={() => projects.loadMore(25)}
        />
        <div className="min-w-0">
          {selectedProject === undefined ? (
            <Panel>
              <PanelBody>
                <EmptyState title={t('services.chooseProject')} description={t('services.chooseProjectHint')} />
              </PanelBody>
            </Panel>
          ) : (
            <ServiceTable projectId={selectedProject._id} />
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectRail({
  projects,
  selectedProjectId,
  onSelect,
  canLoadMore,
  onLoadMore,
}: {
  projects: readonly Project[];
  selectedProjectId: ProjectId | undefined;
  onSelect: (projectId: ProjectId) => void;
  canLoadMore: boolean;
  onLoadMore: () => void;
}) {
  const t = useTranslations();

  return (
    <Panel className="lg:sticky lg:top-6 lg:self-start">
      <PanelHeader>
        <PanelTitle>{t('services.chooseProject')}</PanelTitle>
      </PanelHeader>
      <PanelBody className="gap-1 py-3">
        <ul className="flex max-h-[28rem] flex-col gap-0.5 overflow-y-auto">
          {projects.map((project) => {
            const selected = project._id === selectedProjectId;
            return (
              <li key={project._id}>
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(project._id)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2 rounded-input px-3 py-2 text-left text-sm transition-colors duration-150',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    selected ? 'bg-ground-2 font-semibold text-ink' : 'text-ink-2 hover:bg-ground-2 hover:text-ink',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <StatusChip kind="project" status={project.status} />
                </button>
              </li>
            );
          })}
        </ul>
        {canLoadMore ? (
          <Button variant="ghost" size="sm" className="self-start" onClick={onLoadMore}>
            {t('services.loadMore')}
          </Button>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/** The services of one project, as a sortable, filterable, selectable table. */
export function ServiceTable({ projectId }: { projectId: ProjectId }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const events = usePaginatedQuery(api.events.queries.listProjectEvents, { projectId }, { initialNumItems: 25 });

  const columns = useMemo<DataTableColumn<Service>[]>(() => {
    const column = createDataTableColumnHelper<Service>();
    return [
      selectionColumn<Service>({ selectAll: t('dataTable.selectAll'), selectRow: t('dataTable.selectRow') }),
      column.accessor('name', {
        id: 'name',
        header: t('services.name'),
        meta: { label: t('services.name') },
        sortFn: 'text',
        cell: (info) => (
          <LocaleLink
            className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
            to={`/services/${info.row.original._id}`}
          >
            {info.getValue()}
          </LocaleLink>
        ),
      }),
      column.accessor('startsAt', {
        id: 'startsAt',
        header: t('services.startsAt'),
        meta: { label: t('services.startsAt') },
        sortFn: 'basic',
        cell: (info) => <span className="font-mono text-xs tabular-nums text-ink">{formatDateTime(locale, info.getValue())}</span>,
      }),
      column.accessor((row) => row.endsAt, {
        id: 'endsAt',
        header: t('services.endsAt'),
        meta: { label: t('services.endsAt') },
        sortFn: 'basic',
        cell: (info) => {
          const value = info.getValue();
          return (
            <span className="font-mono text-xs tabular-nums text-ink">
              {value === undefined ? t('services.notSet') : formatDateTime(locale, value)}
            </span>
          );
        },
      }),
      column.accessor('status', {
        id: 'status',
        header: t('services.status'),
        meta: { label: t('services.status') },
        sortFn: 'text',
        filterFn: 'includesString',
        cell: (info) => <StatusChip kind="service" status={info.getValue()} />,
      }),
    ] as DataTableColumn<Service>[];
  }, [locale, t]);

  const table = useDataTable<Service>({
    data: events.results,
    columns,
    getRowId: (row) => row._id,
  });
  const statusFilter = table.getColumn('status')?.getFilterValue();

  return (
    <Panel>
      <PanelBodyFlush>
        <DataTableToolbar table={table} searchLabel={t('dataTable.search')} scopeNotice={t('dataTable.loadedScope')}>
          <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
            {t('services.statusFilter')}
            <select
              className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal text-ink"
              value={typeof statusFilter === 'string' ? statusFilter : ''}
              onChange={(event) => {
                const next = serviceStatuses.find((status): status is EventStatus => status === event.target.value);
                table.getColumn('status')?.setFilterValue(next ?? undefined);
              }}
            >
              <option value="">{t('services.allStatuses')}</option>
              {serviceStatuses.map((status) => (
                <option key={status} value={status}>
                  {t(`services.statuses.${status}`)}
                </option>
              ))}
            </select>
          </label>
        </DataTableToolbar>
        <DataTableContent
          table={table}
          loading={events.status === 'LoadingFirstPage'}
          empty={
            <div className="p-5">
              <EmptyState
                tone={events.results.length === 0 ? 'empty' : 'filtered'}
                title={events.results.length === 0 ? t('services.emptyTitle') : t('empty.noMatches')}
                description={events.results.length === 0 ? t('services.emptyBody') : t('empty.noMatchesBody')}
              />
            </div>
          }
        />
        <TableLoadMore status={events.status} loadedCount={events.results.length} onLoadMore={events.loadMore} />
      </PanelBodyFlush>
    </Panel>
  );
}

/** The project detail screen's services block: the same table, no project rail. */
export function ProjectServicesPanel({ project }: { project: Project }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const canCreate = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');

  return (
    <div className="flex flex-col gap-3">
      {canCreate && project.status !== 'archived' && project.status !== 'completed' ? (
        <Button className="self-start" variant="primary" render={<LocaleLink to={newServiceHref(project._id)} />}>
          {t('services.create')}
        </Button>
      ) : null}
      <ServiceTable projectId={project._id} />
    </div>
  );
}
