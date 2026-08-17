'use client';

import { useMutation, usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { api } from '@sancocho/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
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
import { LocaleLink } from '@/i18n/locale-link';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { projectDateRangeFromParts, type ProjectTimestampParts } from '@/lib/project-timestamps';
import { roleAtLeast } from '@/lib/roles';
import type { ProjectStatus } from '@/lib/status';

type Project = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number];
type CreateProjectArgs = FunctionArgs<typeof api.projects.mutations.createProject>;

const projectStatuses: readonly ProjectStatus[] = ['draft', 'active', 'completed', 'archived'];

export function ProjectsSurface() {
  const { currentOrganization } = useCurrentOrganization();
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | ''>('');
  const hasActiveFilter = statusFilter !== '';
  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    currentOrganization === null
      ? 'skip'
      : {
          organizationId: currentOrganization.organization._id,
          ...(statusFilter === '' ? {} : { status: statusFilter }),
        },
    { initialNumItems: 25 },
  );
  const createProject = useMutation(api.projects.mutations.createProject);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canManage = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');

  if (currentOrganization === null) return null;

  const organizationId = currentOrganization.organization._id;

  async function create(args: Omit<CreateProjectArgs, 'organizationId'>): Promise<void> {
    try {
      await createProject({ organizationId, ...args });
      setCreating(false);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('projects.title')}
        actions={
          canManage && !creating ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('projects.create')}
            </Button>
          ) : undefined
        }
      />
      {message === null ? null : <AlertMessage>{message}</AlertMessage>}
      {creating ? <ProjectForm onClose={() => setCreating(false)} onSubmit={create} /> : null}
      <Panel>
        <PanelHeader>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <PanelTitle>{t('projects.listTitle')}</PanelTitle>
            <label className="flex max-w-full flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
              {t('projects.statusFilter')}
              <select
                className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
                value={statusFilter}
                onChange={(event) => {
                  const candidate = projectStatuses.find((status) => status === event.target.value);
                  setStatusFilter(candidate ?? '');
                }}
              >
                <option value="">{t('projects.allStatuses')}</option>
                {projectStatuses.map((status) => (
                  <option key={status} value={status}>
                    {t(`projects.statuses.${status}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </PanelHeader>
        {projects.status === 'Exhausted' && projects.results.length === 0 ? (
          <PanelBody>
            <EmptyState
              tone={hasActiveFilter ? 'filtered' : 'empty'}
              title={t(hasActiveFilter ? 'projects.noMatchesTitle' : 'projects.emptyTitle')}
              description={t(hasActiveFilter ? 'projects.noMatchesBody' : 'projects.emptyBody')}
            />
          </PanelBody>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('projects.name')}</TableHeaderCell>
                <TableHeaderCell>{t('projects.status')}</TableHeaderCell>
                <TableHeaderCell>{t('projects.dateRange')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            {projects.status === 'LoadingFirstPage' ? (
              <TableSkeletonRows columns={3} />
            ) : (
              <TableBody>
                {projects.results.map((project) => (
                  <ProjectRow key={project._id} locale={locale} project={project} />
                ))}
              </TableBody>
            )}
          </Table>
        )}
      </Panel>
      <TableLoadMore loadedCount={projects.results.length} status={projects.status} onLoadMore={projects.loadMore} />
    </div>
  );
}

function ProjectRow({ project, locale }: { project: Project; locale: string }) {
  const t = useTranslations();
  return (
    <TableRow>
      <TableRowHeaderCell>
        <div className="flex flex-col gap-1">
          <LocaleLink
            className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
            to={`/projects/${project._id}`}
          >
            {project.name}
          </LocaleLink>
          {project.description === undefined ? null : (
            <span className="text-xs font-normal text-ink-3">{project.description}</span>
          )}
        </div>
      </TableRowHeaderCell>
      <TableCell>
        <StatusChip kind="project" status={project.status} />
      </TableCell>
      <TableCell className="font-mono text-xs text-ink-2">
        {projectDateRangeLabel(project, locale, t('projects.noDates'))}
      </TableCell>
    </TableRow>
  );
}

function projectDateRangeLabel(project: Project, locale: string, missing: string): string {
  if (project.startsAt === undefined && project.endsAt === undefined) return missing;
  return [
    project.startsAt === undefined ? missing : formatDateTime(locale === 'es-CO' ? 'es-CO' : 'en-US', project.startsAt),
    project.endsAt === undefined ? missing : formatDateTime(locale === 'es-CO' ? 'es-CO' : 'en-US', project.endsAt),
  ].join(' – ');
}

function ProjectForm({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (args: Omit<CreateProjectArgs, 'organizationId'>) => Promise<void>;
}) {
  const t = useTranslations();
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const range = projectDateRangeFromParts(dateTimeParts(form, 'startsAt'), dateTimeParts(form, 'endsAt'));
    if (range === undefined) {
      setError(t('errors.projectDatesInvalid'));
      return;
    }
    await onSubmit({
      name: String(form.get('name') ?? ''),
      ...(String(form.get('description') ?? '') === '' ? {} : { description: String(form.get('description')) }),
      ...range,
    });
  }

  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <PanelTitle>{t('projects.createTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <ProjectInputs />
          {error === null ? null : (
            <p role="alert" className="text-sm text-tone-stop">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary">
              {t('projects.save')}
            </Button>
            <Button type="button" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </PanelBody>
    </Panel>
  );
}

export function ProjectInputs({ project }: { project?: Project }) {
  const t = useTranslations();
  const start = project?.startsAt === undefined ? undefined : new Date(project.startsAt);
  const end = project?.endsAt === undefined ? undefined : new Date(project.endsAt);
  const startParts = start === undefined ? undefined : localDateTimeParts(start);
  const endParts = end === undefined ? undefined : localDateTimeParts(end);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <EditorInput label={t('projects.name')} name="name" defaultValue={project?.name} required />
      <EditorInput label={t('projects.description')} name="description" defaultValue={project?.description} />
      <EditorInput label={t('projects.startDate')} name="startsAt-date" type="date" defaultValue={startParts?.date} />
      <EditorInput label={t('projects.startTime')} name="startsAt-time" type="time" defaultValue={startParts?.time} />
      <EditorInput label={t('projects.endDate')} name="endsAt-date" type="date" defaultValue={endParts?.date} />
      <EditorInput label={t('projects.endTime')} name="endsAt-time" type="time" defaultValue={endParts?.time} />
    </div>
  );
}

function localDateTimeParts(date: Date): ProjectTimestampParts {
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
  };
}

export function dateTimeParts(form: FormData, prefix: 'startsAt' | 'endsAt'): ProjectTimestampParts {
  return { date: String(form.get(`${prefix}-date`) ?? ''), time: String(form.get(`${prefix}-time`) ?? '') };
}

function EditorInput({
  label,
  name,
  defaultValue,
  required = false,
  type = 'text',
}: {
  label: string;
  name: string;
  defaultValue?: string | undefined;
  required?: boolean;
  type?: 'date' | 'text' | 'time';
}) {
  return (
    <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
      {label}
      <input
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
        defaultValue={defaultValue}
        name={name}
        required={required}
        type={type}
      />
    </label>
  );
}

function AlertMessage({ children }: { children: string }) {
  return (
    <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">
      {children}
    </p>
  );
}
