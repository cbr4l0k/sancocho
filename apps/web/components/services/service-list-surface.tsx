'use client';

import Link from 'next/link';
import { usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@sancocho/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody, PanelBodyFlush, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableLoadMore,
  TableRow,
  TableRowHeaderCell,
  TableSkeletonRows,
} from '@/components/ui/table';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { roleAtLeast } from '@/lib/roles';
import { serviceStatuses, type EventStatus } from '@/lib/status';

type ProjectId = FunctionArgs<typeof api.projects.queries.getProject>['projectId'];
type Project = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number];
type Service = FunctionReturnType<typeof api.events.queries.listProjectEvents>['page'][number];

export function ServiceListSurface({ locale, initialProjectId }: { locale: string; initialProjectId?: string }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    currentOrganization === null ? 'skip' : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );
  const [projectId, setProjectId] = useState<ProjectId | undefined>();
  if (currentOrganization === null) return null;
  const selectedProject = projects.results.find((project) => project._id === (projectId ?? initialProjectId));
  return (
    <div className="flex flex-col gap-8">
      <header className="flex max-w-3xl flex-col gap-2">
        <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{t('services.eyebrow')}</p>
        <h1 className="text-display font-extrabold tracking-[-0.025em] text-ink">{t('services.title')}</h1>
        <p className="text-sm text-ink-2">{t('services.listLead')}</p>
      </header>
      <ProjectPicker
        projects={projects.results}
        selectedProject={selectedProject}
        onSelect={setProjectId}
        canLoadMore={projects.status !== 'Exhausted'}
        onLoadMore={() => projects.loadMore(25)}
      />
      {selectedProject === undefined ? null : <ProjectServicesPanel locale={locale} project={selectedProject} />}
    </div>
  );
}

export function ProjectServicesPanel({ locale, project }: { locale: string; project: Project }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const canCreate = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');
  return (
    <div className="flex flex-col gap-3">
      {canCreate && project.status !== 'archived' && project.status !== 'completed' ? (
        <Button
          className="self-start"
          variant="primary"
          render={<Link href={`/${locale}/services/new?projectId=${project._id}`} />}
        >
          {t('services.create')}
        </Button>
      ) : null}
      <ServiceTable projectId={project._id} locale={locale} />
    </div>
  );
}

function ProjectPicker({
  projects,
  selectedProject,
  onSelect,
  canLoadMore,
  onLoadMore,
}: {
  projects: readonly Project[];
  selectedProject: Project | undefined;
  onSelect: (projectId: ProjectId) => void;
  canLoadMore: boolean;
  onLoadMore: () => void;
}) {
  const t = useTranslations();
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('services.chooseProject')}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <div className="flex flex-wrap gap-2">
          {projects.map((project) => (
            <Button
              key={project._id}
              size="sm"
              selected={project._id === selectedProject?._id}
              onClick={() => onSelect(project._id)}
            >
              {project.name}
            </Button>
          ))}
        </div>
        {canLoadMore ? (
          <Button size="sm" onClick={onLoadMore}>
            {t('services.loadMore')}
          </Button>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function ServiceTable({ projectId, locale }: { projectId: ProjectId; locale: string }) {
  const t = useTranslations();
  const canonicalLocale = useCanonicalLocale();
  const events = usePaginatedQuery(api.events.queries.listProjectEvents, { projectId }, { initialNumItems: 25 });
  const [status, setStatus] = useState<EventStatus | 'all'>('all');
  const visible = status === 'all' ? events.results : events.results.filter((event) => event.status === status);
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>{t('services.listTitle')}</PanelTitle>
          <PanelDescription>{t('services.loadedFilterNotice')}</PanelDescription>
        </div>
        <label className="flex flex-col gap-1 text-sm text-ink-2">
          {t('services.statusFilter')}
          <select
            value={status}
            onChange={(event) => setStatus(serviceStatuses.find((item) => item === event.target.value) ?? 'all')}
          >
            <option value="all">{t('services.allStatuses')}</option>
            {serviceStatuses.map((item) => (
              <option key={item} value={item}>
                {t(`services.statuses.${item}`)}
              </option>
            ))}
          </select>
        </label>
      </PanelHeader>
      <PanelBodyFlush>
        {events.status === 'Exhausted' && events.results.length === 0 ? (
          <div className="p-5">
            <EmptyState title={t('services.emptyTitle')} description={t('services.emptyBody')} />
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('services.name')}</TableHeaderCell>
                <TableHeaderCell>{t('services.startsAt')}</TableHeaderCell>
                <TableHeaderCell>{t('services.endsAt')}</TableHeaderCell>
                <TableHeaderCell>{t('services.status')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            {events.status === 'LoadingFirstPage' ? (
              <TableSkeletonRows columns={4} />
            ) : (
              <TableBody>
                {visible.map((event) => (
                  <ServiceRow key={event._id} event={event} locale={locale} canonicalLocale={canonicalLocale} />
                ))}
              </TableBody>
            )}
          </Table>
        )}
      </PanelBodyFlush>
      <PanelBody>
        <TableLoadMore status={events.status} loadedCount={events.results.length} onLoadMore={events.loadMore} />
      </PanelBody>
    </Panel>
  );
}

function ServiceRow({
  event,
  locale,
  canonicalLocale,
}: {
  event: Service;
  locale: string;
  canonicalLocale: ReturnType<typeof useCanonicalLocale>;
}) {
  const t = useTranslations();
  return (
    <TableRow>
      <TableRowHeaderCell>
        <Link
          className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
          href={`/${locale}/services/${event._id}`}
        >
          {event.name}
        </Link>
      </TableRowHeaderCell>
      <TableCell mono>{formatDateTime(canonicalLocale, event.startsAt)}</TableCell>
      <TableCell mono>
        {event.endsAt === undefined ? t('services.notSet') : formatDateTime(canonicalLocale, event.endsAt)}
      </TableCell>
      <TableCell>
        <StatusChip kind="service" status={event.status} />
      </TableCell>
    </TableRow>
  );
}
