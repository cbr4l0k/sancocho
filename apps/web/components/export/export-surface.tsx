'use client';

import { useConvex, useMutation, usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { toSheetCell } from '@/lib/export-cells';
import { drainPages, exportIsRunning, failedSheet, type ExportProgress } from '@/lib/export-run';
import {
  eventsSheet,
  locationsSheet,
  projectsSheet,
  serviceKindsSheet,
  servicesSheet,
  sheetCells,
  type ExportLookups,
  type ExportSheetData,
  type ExportSheetName,
} from '@/lib/export-sheets';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { roleAtLeast } from '@/lib/roles';
import { serviceFieldColumns } from '@/lib/service-columns';

type OrganizationId = FunctionArgs<typeof api.projects.queries.listProjects>['organizationId'];
type ProjectId = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number]['_id'];

/**
 * Every sheet this cut writes, in the order they appear in the workbook. The commercial
 * sheets (Assignments, Revisions, Providers, Rate Cards) join this list once #98 seeds
 * something to check them against; see docs/export.md "Sheets".
 */
const sheetNames = ['events', 'services', 'projects', 'serviceKinds', 'locations'] as const satisfies readonly ExportSheetName[];

const pageSize = 200;

export function ExportSurface() {
  const t = useTranslations();
  const client = useConvex();
  const { currentOrganization } = useCurrentOrganization();
  const organizationId = currentOrganization?.organization._id;
  const [projectId, setProjectId] = useState<ProjectId | ''>('');
  const [progress, setProgress] = useState<ExportProgress>({ kind: 'idle' });
  const [failure, setFailure] = useState<string | null>(null);
  const recordExportRequest = useMutation(api.audit.mutations.recordExportRequest);
  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    organizationId === undefined ? 'skip' : { organizationId },
    { initialNumItems: 100 },
  );

  if (currentOrganization === null || organizationId === undefined) return null;

  // An affordance, never authorization (I1): `recordExportRequest` re-proves admin, and
  // every query the walk drives refuses a caller who may not read it.
  const isAdmin = roleAtLeast(currentOrganization.role, 'admin');
  const organizationName = currentOrganization.organization.name;
  if (!isAdmin) {
    return (
      <Panel>
        <PanelBody>
          <EmptyState tone="unavailable" title={t('export.adminOnlyTitle')} description={t('export.adminOnlyBody')} />
        </PanelBody>
      </Panel>
    );
  }

  async function generate(): Promise<void> {
    if (organizationId === undefined) return;
    const scope = projectId === '' ? {} : { projectId };
    setFailure(null);
    let sheet: ExportSheetName | undefined;
    try {
      // The gate first, and the audit row with it: an export that is refused must be
      // refused before any of the tenant has been read out. See docs/export.md.
      await recordExportRequest({ organizationId, ...scope, sheets: [...sheetNames] });

      const read = <Row,>(
        name: ExportSheetName,
        query: (cursor: string | null) => Promise<{ page: Row[]; continueCursor: string; isDone: boolean }>,
      ): Promise<Row[]> => {
        sheet = name;
        // The export is the console's only imperative Convex caller. Subscribing to eight
        // datasets through `usePaginatedQuery` to fill a file written once would hold every
        // page live for a screen that renders none of them; a one-shot `client.query` goes
        // through exactly the same authorization and is what makes a real count possible.
        return drainPages(query, (rows) => setProgress({ kind: 'reading', sheet: name, rows }));
      };

      const projectRows = await read('projects', (cursor) =>
        client.query(api.projects.queries.listProjects, {
          organizationId,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );
      const locationRows = await read('locations', (cursor) =>
        client.query(api.locations.queries.listLocations, {
          organizationId,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );
      // Cost Centres and members are not sheets; they are walked so an Event's Cost Centre
      // and accountable person export as names rather than ids. A failure here is reported
      // against the Events sheet, which is the sheet that cannot be written without them —
      // blaming the Locations walk that happens to precede them would be a lie.
      sheet = 'events';
      const costCentreRows = await drainPages((cursor) =>
        client.query(api.costCentres.queries.listCostCentres, {
          organizationId,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );
      const memberRows = await drainPages((cursor) =>
        client.query(api.organizations.queries.listMembers, {
          organizationId,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );
      const serviceKindRows = await read('serviceKinds', (cursor) =>
        client.query(api.serviceKinds.queries.listServiceKinds, {
          organizationId,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );
      const serviceKindDetails = await Promise.all(
        serviceKindRows.map((serviceKind) =>
          client.query(api.serviceKinds.queries.getServiceKind, { serviceKindId: serviceKind._id }),
        ),
      );
      const eventRows = await read('events', (cursor) =>
        client.query(api.events.queries.listOrganizationEvents, {
          organizationId,
          ...scope,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );
      const serviceRows = await read('services', (cursor) =>
        client.query(api.services.queries.listOrganizationServices, {
          organizationId,
          ...scope,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );

      const lookups: ExportLookups = {
        projectNames: new Map(projectRows.map((project) => [project._id, project.name])),
        eventNames: new Map(eventRows.map((event) => [event._id, event.name])),
        locationNames: new Map(locationRows.map((location) => [location._id, location.name])),
        costCentreNames: new Map(costCentreRows.map((costCentre) => [costCentre._id, costCentre.name])),
        userNames: new Map(
          memberRows.map(({ user }) => [user._id, user.name ?? user.email ?? t('common.notAvailable')]),
        ),
        serviceKindNames: new Map(serviceKindRows.map((serviceKind) => [serviceKind._id, serviceKind.name])),
        versionNumbers: new Map(
          serviceKindDetails.flatMap((detail) =>
            detail.versions.map((version) => [version._id, version.versionNumber] as const),
          ),
        ),
      };

      const columns = serviceFieldColumns(serviceRows);
      const sheets: readonly ExportSheetData[] = [
        eventsSheet(eventRows, lookups, t),
        servicesSheet(serviceRows, columns, lookups, t),
        projectsSheet(projectRows, t),
        serviceKindsSheet(
          serviceKindDetails.map(({ serviceKind, versions }) => ({ ...serviceKind, versions })),
          t,
        ),
        locationsSheet(locationRows, t),
      ];

      const rows = sheets.reduce((total, data) => total + data.rows.length, 0);
      setProgress({ kind: 'writing', rows });
      // Imported here rather than at module scope: the writer and its zip dependency are
      // ~1.8MB that only an administrator generating a file ever needs.
      const { default: writeXlsxFile } = await import('write-excel-file/browser');
      await writeXlsxFile(
        sheets.map((data) => ({ data: sheetCells(data).map((row) => row.map(toSheetCell)), sheet: data.name })),
      ).toFile(fileName(organizationName));
      setProgress({ kind: 'done', rows });
    } catch (error) {
      // No file is written in this state: a partial workbook that looks complete is the
      // one outcome worth preventing. A refusal carries no sheet — the gate runs before
      // the first page, so there is none to blame.
      setProgress(sheet === undefined ? { kind: 'refused' } : { kind: 'failed', sheet });
      setFailure(t(errorMessageKey(presentConvexError(error))));
    }
  }

  const running = exportIsRunning(progress);

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader>
          <PanelTitle>{t('export.title')}</PanelTitle>
          <PanelDescription>{t('export.description')}</PanelDescription>
        </PanelHeader>
        <PanelBody>
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
                {t('export.projectFilter')}
                <select
                  className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
                  value={projectId}
                  disabled={running}
                  onChange={(event) =>
                    setProjectId(projects.results.find((item) => item._id === event.target.value)?._id ?? '')
                  }
                >
                  <option value="">{t('export.allProjects')}</option>
                  {projects.results.map((project) => (
                    <option key={project._id} value={project._id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="primary" disabled={running} onClick={() => void generate()}>
                {running ? t('export.generating') : t('export.generate')}
              </Button>
            </div>
            <Sheets label={t('export.sheetsTitle')}>
              {sheetNames.map((name) => (
                <li key={name} className="rounded-pill bg-ground-2 px-3 py-1 text-sm text-ink-2">
                  {t(`export.sheetNames.${name}`)}
                </li>
              ))}
            </Sheets>
            <p className="text-sm text-ink-2">{t('export.projectScopeNotice')}</p>
            <p className="text-sm text-ink-2">{t('export.verbatimNotice')}</p>
            <Progress progress={progress} />
            {failure === null ? null : <Failure progress={progress} message={failure} />}
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}

function Failure({ progress, message }: { progress: ExportProgress; message: string }) {
  const t = useTranslations();
  const sheet = failedSheet(progress);
  return (
    <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">
      {sheet === undefined ? message : `${t('export.failedBody', { sheet: t(`export.sheetNames.${sheet}`) })} ${message}`}
    </p>
  );
}

function Sheets({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">{label}</span>
      <ul className="flex flex-wrap gap-2">{children}</ul>
    </div>
  );
}

function Progress({ progress }: { progress: ExportProgress }) {
  const t = useTranslations();
  if (progress.kind === 'idle') return null;
  if (progress.kind === 'reading') {
    return (
      <p aria-live="polite" className="text-sm text-ink-2">
        {t('export.progress', { sheet: t(`export.sheetNames.${progress.sheet}`), count: progress.rows })}
      </p>
    );
  }
  if (progress.kind === 'writing') {
    return (
      <p aria-live="polite" className="text-sm text-ink-2">
        {t('export.writing')}
      </p>
    );
  }
  if (progress.kind === 'done') {
    return (
      <p aria-live="polite" className="text-sm text-tone-go">
        {t('export.done', { count: progress.rows })}
      </p>
    );
  }
  return (
    <p aria-live="polite" className="text-sm text-tone-stop">
      {t('export.failedTitle')}
    </p>
  );
}

/** `priamo-<organization>-<date>.xlsx`, with the organization's own name kept verbatim. */
function fileName(organizationName: string): string {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return `priamo-${organizationName.trim().replace(/\s+/gu, '-').toLowerCase()}-${date}.xlsx`;
}
