'use client';

import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ServiceTable } from '@/components/services/service-table';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { LocaleLink } from '@/i18n/locale-link';
import { roleAtLeast } from '@/lib/roles';

type ProjectId = FunctionArgs<typeof api.projects.queries.getProject>['projectId'];
type Project = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number];

/** Carries the chosen project into the create screen so it opens pre-filled. */
function newServiceHref(projectId: ProjectId | undefined): string {
  return projectId === undefined ? '/services/new' : `/services/new?projectId=${projectId}`;
}

/**
 * The Services screen: every project's services, in one ordered, editable table.
 *
 * It used to open on an empty panel beside a rail of projects, and showed
 * nothing at all until you picked one — a whole column spent on a choice the
 * Projects screen already answers, on the one screen whose job is to show what
 * is happening across all of them. The project is a filter in the toolbar now,
 * defaulting to "all", and the table is what the screen is made of.
 */
export function ServiceListSurface({ initialProjectId }: { initialProjectId?: string }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  if (currentOrganization === null) return null;
  const canCreate = roleAtLeast(currentOrganization.role, 'planner');
  /* `initialProjectId` arrives from the query string. It is handed to the table
   * as a seed for its filter, and the filter only ever emits ids the server
   * already returned for this organization, so an id from elsewhere selects
   * nothing rather than being trusted. */
  const seed = initialProjectId as ProjectId | undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={
          canCreate ? (
            <Button variant="primary" render={<LocaleLink to={newServiceHref(seed)} />}>
              {t('services.create')}
            </Button>
          ) : undefined
        }
      />
      <ServiceTable organizationId={currentOrganization.organization._id} initialProjectId={seed} />
    </div>
  );
}

/** The project detail screen's services block: the same table, project fixed. */
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
      <ServiceTable organizationId={project.organizationId} fixedProjectId={project._id} />
    </div>
  );
}
