'use client';

import { useMutation, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { api } from '@sancocho/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ProjectServicesPanel } from '@/components/services/service-list-surface';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { projectDateRangeFromParts } from '@/lib/project-timestamps';
import { roleAtLeast } from '@/lib/roles';
import type { ProjectStatus } from '@/lib/status';

import { dateTimeParts, ProjectInputs } from './projects-surface';

type ProjectId = FunctionArgs<typeof api.projects.queries.getProject>['projectId'];
type Project = FunctionReturnType<typeof api.projects.queries.getProject>;

const editableStatuses: readonly Exclude<ProjectStatus, 'archived'>[] = ['draft', 'active', 'completed'];

export function ProjectDetailSurface({ projectId }: { projectId: ProjectId }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const project = useQuery(api.projects.queries.getProject, { projectId });
  const update = useMutation(api.projects.mutations.updateProject);
  const archive = useMutation(api.projects.mutations.archiveProject);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canManage = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');

  if (project === undefined) return null;
  const loadedProject = project;

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const range = projectDateRangeFromParts(dateTimeParts(form, 'startsAt'), dateTimeParts(form, 'endsAt'));
    if (range === undefined) {
      setMessage(t('errors.projectDatesInvalid'));
      return;
    }
    try {
      const status = editableStatuses.find((candidate) => candidate === form.get('status'));
      await update({
        projectId: loadedProject._id,
        name: String(form.get('name') ?? ''),
        description: String(form.get('description') ?? ''),
        ...(status === undefined ? {} : { status }),
        ...range,
      });
      setEditing(false);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  async function confirmArchive(): Promise<void> {
    try {
      await archive({ projectId: loadedProject._id });
      setConfirming(false);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  return (
    /* Order matters here: the edit form takes the details panel's place at the
     * top of the page rather than appending after the services table, which is
     * long enough to push a form appended below it entirely off-screen — you
     * pressed Edit and nothing appeared to happen. Same reason the archive
     * confirmation sits directly under the header that triggered it. */
    <div className="flex flex-col gap-6">
      <PageHeader
        title={project.name}
        badge={<StatusChip emphasis="loud" kind="project" status={project.status} />}
        actions={
          canManage && project.status !== 'archived' && !editing ? (
            <>
              <Button onClick={() => setEditing(true)}>{t('projects.edit')}</Button>
              <Button variant="danger" onClick={() => setConfirming(true)}>
                {t('projects.archive')}
              </Button>
            </>
          ) : undefined
        }
      />
      {message === null ? null : <AlertMessage>{message}</AlertMessage>}
      {confirming ? <ArchiveConfirmation onCancel={() => setConfirming(false)} onConfirm={confirmArchive} /> : null}
      {editing && project.status !== 'archived' ? (
        <MetadataForm project={project} onClose={() => setEditing(false)} onSubmit={save} />
      ) : (
        <ProjectDetails project={project} />
      )}
      {project.status === 'archived' ? <Notice>{t('projects.archivedNotice')}</Notice> : null}
      <ProjectServicesPanel project={project} />
    </div>
  );
}

function ProjectDetails({ project }: { project: Project }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('projects.detailsTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody className="gap-2 text-sm text-ink-2">
        {/* The description lives here rather than under the page title: it is a
         * property of the project like its dates, not a subtitle for the screen. */}
        {project.description === undefined ? null : <p className="text-ink">{project.description}</p>}
        <p>
          <span className="text-ink-3">{t('projects.start')} </span>
          {project.startsAt === undefined ? t('projects.noDates') : formatDateTime(locale, project.startsAt)}
        </p>
        <p>
          <span className="text-ink-3">{t('projects.end')} </span>
          {project.endsAt === undefined ? t('projects.noDates') : formatDateTime(locale, project.endsAt)}
        </p>
      </PanelBody>
    </Panel>
  );
}

function MetadataForm({
  project,
  onClose,
  onSubmit,
}: {
  project: Project;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const t = useTranslations();
  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <PanelTitle>{t('projects.editTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <ProjectInputs project={project} />
          <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
            {t('projects.status')}
            <select
              className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
              defaultValue={project.status}
              name="status"
            >
              {editableStatuses.map((status) => (
                <option key={status} value={status}>
                  {t(`projects.statuses.${status}`)}
                </option>
              ))}
            </select>
          </label>
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

function ArchiveConfirmation({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => Promise<void> }) {
  const t = useTranslations();
  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>{t('projects.archiveTitle')}</PanelTitle>
          <PanelDescription>{t('projects.archiveWarning')}</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="flex-row flex-wrap">
        <Button variant="danger" onClick={onConfirm}>
          {t('projects.archiveConfirm')}
        </Button>
        <Button onClick={onCancel}>{t('projects.cancelArchive')}</Button>
      </PanelBody>
    </Panel>
  );
}

function Notice({ children }: { children: string }) {
  return <p className="rounded-input border border-line px-4 py-3 text-sm text-ink-2">{children}</p>;
}

function AlertMessage({ children }: { children: string }) {
  return (
    <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">
      {children}
    </p>
  );
}
