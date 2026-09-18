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
import {
  drainPages,
  exportFileName,
  exportIsRunning,
  failedSheet,
  mapInBatches,
  type ExportProgress,
} from '@/lib/export-run';
import {
  assignmentRevisionsSheet,
  assignmentsSheet,
  eventsSheet,
  locationsSheet,
  projectsSheet,
  providersSheet,
  rateCardsSheet,
  serviceKindsSheet,
  servicesSheet,
  sheetCells,
  type ExportableAssignment,
  type ExportableAssignmentRevision,
  type ExportableProvider,
  type ExportableRateCard,
  type ExportLookups,
  type ExportSheetData,
  type ExportSheetName,
} from '@/lib/export-sheets';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { parseExportWindow, withinExportWindow } from '@/lib/export-window';
import { roleAtLeast } from '@/lib/roles';
import { serviceFieldColumns } from '@/lib/service-columns';

type OrganizationId = FunctionArgs<typeof api.projects.queries.listProjects>['organizationId'];
type ProjectId = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number]['_id'];

/**
 * Every sheet the workbook writes, operational first then configuration. The gate
 * mutation records this list; see docs/export.md "Sheets".
 */
const sheetNames = [
  'events',
  'services',
  'assignments',
  'assignmentRevisions',
  'projects',
  'serviceKinds',
  'locations',
  'providers',
  'rateCards',
] as const satisfies readonly ExportSheetName[];

const pageSize = 200;
/** Per-Service and per-Assignment reads are N+1; keep this many in flight, not thousands. */
const walkConcurrency = 8;

export function ExportSurface() {
  const t = useTranslations();
  const client = useConvex();
  const { currentOrganization } = useCurrentOrganization();
  const organizationId = currentOrganization?.organization._id;
  const [projectId, setProjectId] = useState<ProjectId | ''>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
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
    const exportWindow = parseExportWindow(fromDate, toDate);
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
      const providerRows = await read('providers', (cursor) =>
        client.query(api.providers.queries.listProviders, {
          organizationId,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );
      // Vehicle classes are not a sheet; they are walked so rate lines and revisions
      // export a class name rather than an id. A failure here is reported against
      // the Rate Cards sheet, which is the sheet that cannot be written without them.
      sheet = 'rateCards';
      const vehicleClassRows = await drainPages((cursor) =>
        client.query(api.vehicles.queries.listVehicleClasses, {
          organizationId,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );
      const providerNames = new Map<string, string>(
        providerRows.map((provider) => [provider._id, provider.name]),
      );
      const vehicleClassNames = new Map<string, string>(
        vehicleClassRows.map((vehicleClass) => [vehicleClass._id, vehicleClass.name]),
      );
      const rateCardRows = await read('rateCards', (cursor) =>
        client.query(api.rateCards.queries.listRateCards, {
          organizationId,
          paginationOpts: { numItems: pageSize, cursor },
        }),
      );
      let rateCardProgress = rateCardRows.length;
      const exportableRateCards = await mapInBatches(rateCardRows, walkConcurrency, async (card) => {
        const versions = await drainPages((cursor) =>
          client.query(api.rateCards.queries.listRateCardVersions, {
            rateCardId: card._id,
            paginationOpts: { numItems: pageSize, cursor },
          }),
        );
        const exportableVersions: ExportableRateCard['versions'][number][] = [];
        for (const version of versions) {
          const detail = await client.query(api.rateCards.queries.getRateCardVersion, {
            rateCardVersionId: version._id,
          });
          exportableVersions.push(toExportableRateCardVersion(detail, vehicleClassNames));
          rateCardProgress += 1;
          setProgress({ kind: 'reading', sheet: 'rateCards', rows: rateCardProgress });
        }
        if (versions.length === 0) {
          rateCardProgress += 1;
          setProgress({ kind: 'reading', sheet: 'rateCards', rows: rateCardProgress });
        }
        return toExportableRateCard(card, exportableVersions, providerNames);
      });
      // The window narrows the file, not the walk: no organization-scoped query
      // accepts from/to. Events and Services drop by startsAt after they are
      // read; the assignment fan-out then follows the Services that remain.
      // Configuration catalogues stay whole — a Service still names a Location
      // that must be in the file. The audit row does not record the window:
      // everything was still read out of the tenant.
      const exportedEvents = eventRows.filter((event) =>
        withinExportWindow(event.startsAt, exportWindow),
      );
      const exportedServices = serviceRows.filter((row) =>
        withinExportWindow(row.service.startsAt, exportWindow),
      );
      sheet = 'assignments';
      setProgress({ kind: 'reading', sheet: 'assignments', rows: 0 });
      let assignmentCount = 0;
      const assignmentWalks = (
        await mapInBatches(exportedServices, walkConcurrency, async (serviceRow) => {
          const rows = await client.query(api.assignments.queries.listServiceAssignmentRows, {
            serviceId: serviceRow.service._id,
          });
          assignmentCount += rows.length;
          setProgress({ kind: 'reading', sheet: 'assignments', rows: assignmentCount });
          return rows.map((row) => ({
            assignmentId: row.assignment._id,
            serviceName: serviceRow.service.name,
            providerName: row.provider === null ? '' : row.provider.name,
            exportable: toExportableAssignment(serviceRow.service, row),
          }));
        })
      ).flat();
      sheet = 'assignmentRevisions';
      setProgress({ kind: 'reading', sheet: 'assignmentRevisions', rows: 0 });
      let revisionCount = 0;
      const exportableRevisions = (
        await mapInBatches(assignmentWalks, walkConcurrency, async (walk) => {
          let seen = 0;
          const revisions = await drainPages(
            (cursor) =>
              client.query(api.assignments.queries.listAssignmentRevisions, {
                assignmentId: walk.assignmentId,
                paginationOpts: { numItems: pageSize, cursor },
              }),
            (total) => {
              revisionCount += total - seen;
              seen = total;
              setProgress({ kind: 'reading', sheet: 'assignmentRevisions', rows: revisionCount });
            },
          );
          return revisions.map((revision) =>
            toExportableAssignmentRevision(walk, revision, vehicleClassNames),
          );
        })
      ).flat();

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

      const columns = serviceFieldColumns(exportedServices);
      const sheets: readonly ExportSheetData[] = [
        eventsSheet(exportedEvents, lookups, t),
        servicesSheet(exportedServices, columns, lookups, t),
        assignmentsSheet(
          assignmentWalks.map((walk) => walk.exportable),
          lookups,
          t,
        ),
        assignmentRevisionsSheet(exportableRevisions, t),
        projectsSheet(projectRows, t),
        serviceKindsSheet(
          serviceKindDetails.map(({ serviceKind, versions }) => ({ ...serviceKind, versions })),
          t,
        ),
        locationsSheet(locationRows, t),
        providersSheet(providerRows.map(toExportableProvider), t),
        rateCardsSheet(exportableRateCards, t),
      ];

      const rows = sheets.reduce((total, data) => total + data.rows.length, 0);
      setProgress({ kind: 'writing', rows });
      // Imported here rather than at module scope: the writer and its zip dependency are
      // ~1.8MB that only an administrator generating a file ever needs.
      const { default: writeXlsxFile } = await import('write-excel-file/browser');
      await writeXlsxFile(
        sheets.map((data) => ({ data: sheetCells(data).map((row) => row.map(toSheetCell)), sheet: data.name })),
      ).toFile(exportFileName(organizationName, new Date()));
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
              <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
                {t('export.windowFrom')}
                <input
                  type="date"
                  className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
                  value={fromDate}
                  disabled={running}
                  onChange={(event) => setFromDate(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
                {t('export.windowTo')}
                <input
                  type="date"
                  className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
                  value={toDate}
                  disabled={running}
                  onChange={(event) => setToDate(event.target.value)}
                />
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
            <p className="text-sm text-ink-2">{t('export.windowNotice')}</p>
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


type ProviderRow = FunctionReturnType<typeof api.providers.queries.listProviders>['page'][number];
type RateCardRow = FunctionReturnType<typeof api.rateCards.queries.listRateCards>['page'][number];
type RateCardVersionDetail = FunctionReturnType<typeof api.rateCards.queries.getRateCardVersion>;
type ServiceDoc = FunctionReturnType<typeof api.services.queries.listOrganizationServices>['page'][number]['service'];
type ServiceAssignmentRow = FunctionReturnType<typeof api.assignments.queries.listServiceAssignmentRows>[number];
type AssignmentRevisionRow = FunctionReturnType<
  typeof api.assignments.queries.listAssignmentRevisions
>['page'][number];

function toExportableProvider(provider: ProviderRow): ExportableProvider {
  return {
    name: provider.name,
    status: provider.status,
    ...(provider.legalName === undefined ? {} : { legalName: provider.legalName }),
    ...(provider.taxId === undefined ? {} : { taxId: provider.taxId }),
    ...(provider.contactName === undefined ? {} : { contactName: provider.contactName }),
    ...(provider.contactEmail === undefined ? {} : { contactEmail: provider.contactEmail }),
    ...(provider.contactPhone === undefined ? {} : { contactPhone: provider.contactPhone }),
    ...(provider.notes === undefined ? {} : { notes: provider.notes }),
  };
}

function toExportableRateCard(
  card: RateCardRow,
  versions: ExportableRateCard['versions'],
  providerNames: ReadonlyMap<string, string>,
): ExportableRateCard {
  return {
    providerName: providerNames.get(card.providerId) ?? '',
    name: card.name,
    status: card.status,
    versions,
  };
}

function toExportableRateCardVersion(
  detail: RateCardVersionDetail,
  vehicleClassNames: ReadonlyMap<string, string>,
): ExportableRateCard['versions'][number] {
  return {
    versionNumber: detail.version.versionNumber,
    status: detail.version.status,
    currency: detail.version.currency,
    lines: detail.rateLines.map((line) => ({
      vehicleClassName: vehicleClassNames.get(line.vehicleClassId) ?? '',
      modality: line.modality,
      unitAmount: line.unitAmount,
    })),
    ...(detail.version.publishedAt === undefined ? {} : { publishedAt: detail.version.publishedAt }),
  };
}

function toExportableAssignment(service: ServiceDoc, row: ServiceAssignmentRow): ExportableAssignment {
  const assignment = row.assignment;
  return {
    serviceName: service.name,
    eventId: service.eventId,
    projectId: assignment.projectId,
    provider: row.provider === null ? null : { name: row.provider.name },
    vehicleClass: row.vehicleClass === null ? null : { name: row.vehicleClass.name },
    costCentre:
      row.costCentre === null ? null : { name: row.costCentre.name, key: row.costCentre.key },
    executionStatus: assignment.executionStatus,
    currentRevision:
      row.currentRevision === null
        ? null
        : {
            quantity: row.currentRevision.quantity,
            unitAmount: row.currentRevision.unitAmount,
            currency: row.currentRevision.currency,
            lineTotal: row.currentRevision.lineTotal,
          },
    ...(assignment.driverName === undefined ? {} : { driverName: assignment.driverName }),
    ...(assignment.vehiclePlateOverride === undefined
      ? {}
      : { vehiclePlateOverride: assignment.vehiclePlateOverride }),
    ...(assignment.dispatchedAt === undefined ? {} : { dispatchedAt: assignment.dispatchedAt }),
    ...(assignment.completedAt === undefined ? {} : { completedAt: assignment.completedAt }),
    ...(assignment.notes === undefined ? {} : { notes: assignment.notes }),
  };
}

function toExportableAssignmentRevision(
  walk: { readonly serviceName: string; readonly providerName: string },
  revision: AssignmentRevisionRow,
  vehicleClassNames: ReadonlyMap<string, string>,
): ExportableAssignmentRevision {
  return {
    serviceName: walk.serviceName,
    providerName: walk.providerName,
    vehicleClassName: vehicleClassNames.get(revision.vehicleClassId) ?? '',
    modality: revision.modality,
    revisionNumber: revision.revisionNumber,
    status: revision.status,
    quantity: revision.quantity,
    unitAmount: revision.unitAmount,
    currency: revision.currency,
    lineTotal: revision.lineTotal,
    ...(revision.acceptedAt === undefined ? {} : { acceptedAt: revision.acceptedAt }),
    ...(revision.declinedReason === undefined ? {} : { declinedReason: revision.declinedReason }),
  };
}
