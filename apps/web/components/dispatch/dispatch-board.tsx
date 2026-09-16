'use client';

import { usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';
import { executionStatuses } from '@priamo/convex/assignments/execution';

import { DispatchDayNavigation, DispatchExecutionEditor, useBrowserDispatchDay } from '@/components/dispatch/dispatch-controls';
import { CostCentrePicker } from '@/components/events/cost-centre-picker';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ProviderPicker } from '@/components/providers/provider-picker';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableLoadMore, TableRow, TableRowHeaderCell, TableSkeletonRows } from '@/components/ui/table';
import { formatClockTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { assignmentSummary, type AssignmentPanelRow } from '@/lib/assignment-summary';
import {
  coordinatorDispatchArgs,
  dispatchDayReadinessArgs,
  dispatchSheetCompleteness,
  readinessDisplay,
  visibleCoordinatorDispatchEntries,
} from '@/lib/dispatch-board';
import { formatMoneyParts } from '@/lib/money';

type Project = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number];
type DispatchEntry = FunctionReturnType<typeof api.assignments.queries.listDispatchDay>['page'][number];
type DispatchArgs = Parameters<typeof coordinatorDispatchArgs>;
type EventId = NonNullable<DispatchArgs[2]['eventId']>;
type ProviderId = NonNullable<DispatchArgs[2]['providerId']>;
type CostCentreId = NonNullable<DispatchArgs[2]['costCentreId']>;
type ExecutionStatus = NonNullable<DispatchArgs[2]['status']>;

export function DispatchBoard({ initialDayKey }: { initialDayKey?: string | undefined }) {
  const t = useTranslations('dispatch');
  const rootT = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const day = useBrowserDispatchDay(initialDayKey);
  const [projectId, setProjectId] = useState<Project['_id'] | ''>('');
  const [eventId, setEventId] = useState<EventId | undefined>();
  const [status, setStatus] = useState<ExecutionStatus | undefined>();
  const [providerId, setProviderId] = useState<ProviderId | undefined>();
  const [costCentreId, setCostCentreId] = useState<CostCentreId | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const organizationId = currentOrganization?.organization._id;
  const projects = usePaginatedQuery(api.projects.queries.listProjects, organizationId === undefined ? 'skip' : { organizationId }, { initialNumItems: 100 });
  const selectedProjectId = projectId === '' ? projects.results[0]?._id : projectId;
  const selectedProject = projects.results.find((project) => project._id === selectedProjectId);
  const events = usePaginatedQuery(api.events.queries.listProjectEvents, selectedProjectId === undefined ? 'skip' : { projectId: selectedProjectId }, { initialNumItems: 100 });
  const queryArgs = selectedProjectId === undefined || day === undefined ? 'skip' : coordinatorDispatchArgs(selectedProjectId, day, { eventId, status, providerId, costCentreId });
  const board = usePaginatedQuery(api.assignments.queries.listDispatchDay, queryArgs, { initialNumItems: 25 });
  const readiness = useQuery(api.assignments.queries.dispatchDayReadiness, selectedProjectId === undefined || day === undefined ? 'skip' : dispatchDayReadinessArgs(selectedProjectId, day, { eventId }));
  const selectedProvider = useQuery(api.providers.queries.getProvider, providerId === undefined ? 'skip' : { providerId });
  const selectedCostCentre = useQuery(api.costCentres.queries.getCostCentre, costCentreId === undefined ? 'skip' : { costCentreId });
  const visibleEntries = visibleCoordinatorDispatchEntries(board.results);
  const sheetCompleteness = dispatchSheetCompleteness(board.status);
  const activeFilters = [
    eventId === undefined ? null : events.results.find((event) => event._id === eventId)?.name,
    status === undefined ? null : rootT(`vocab.executionStatuses.${status}`),
    providerId === undefined ? null : selectedProvider?.name ?? t('providerFilterActive'),
    costCentreId === undefined ? null : selectedCostCentre === undefined ? t('costCentreFilterActive') : `${selectedCostCentre.key} · ${selectedCostCentre.name}`,
  ].filter((value): value is string => value !== null && value !== undefined);

  if (currentOrganization === null || day === undefined) return null;
  const actor = { kind: 'member', role: currentOrganization.role } as const;
  const readinessValue = readiness === undefined ? undefined : readinessDisplay(readiness);
  return (
    <div className="dispatch-sheet flex min-w-0 flex-col gap-5">
      <div className="dispatch-print-header">
        <h1>{t('printTitle')}</h1>
        <p>{selectedProject?.name ?? t('chooseProject')} · {day.key}</p>
        <p>{activeFilters.length === 0 ? t('noActiveFilters') : activeFilters.join(' · ')}</p>
        <p>{sheetCompleteness.kind === 'complete' ? t('printComplete') : t('printLoadedOnly', { count: board.results.length })}</p>
      </div>
      <Panel emphasis="focal">
        <PanelHeader className="dispatch-no-print">
          <div><PanelTitle>{t('title')}</PanelTitle><PanelDescription>{t('description')}</PanelDescription></div>
          <DispatchDayNavigation day={day} path="/dispatch" />
        </PanelHeader>
        <PanelBody className="dispatch-no-print border-t border-line">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="flex flex-col gap-2 text-xs font-medium text-ink">{t('project')}
              <select className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" value={selectedProjectId ?? ''} onChange={(event) => { const selected = projects.results.find((project) => project._id === event.target.value); setProjectId(selected?._id ?? ''); setEventId(undefined); }}>
                {projects.results.length === 0 ? <option value="">{t('chooseProject')}</option> : null}
                {projects.results.map((project) => <option key={project._id} value={project._id}>{project.name}</option>)}
              </select>
              {projects.status === 'CanLoadMore' ? <Button size="sm" variant="ghost" onClick={() => projects.loadMore(100)}>{rootT('table.loadMore')}</Button> : null}
            </label>
            <label className="flex flex-col gap-2 text-xs font-medium text-ink">{t('event')}
              <select className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" value={eventId ?? ''} disabled={selectedProjectId === undefined} onChange={(event) => setEventId(events.results.find((item) => item._id === event.target.value)?._id)}>
                <option value="">{t('allEvents')}</option>{events.results.map((event) => <option key={event._id} value={event._id}>{event.name}</option>)}
              </select>
              {events.status === 'CanLoadMore' ? <Button size="sm" variant="ghost" onClick={() => events.loadMore(100)}>{rootT('table.loadMore')}</Button> : null}
            </label>
            <label className="flex flex-col gap-2 text-xs font-medium text-ink">{t('executionStatus')}
              <select className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" value={status ?? ''} onChange={(event) => setStatus(executionStatuses.find((item) => item === event.target.value))}>
                <option value="">{t('allStatuses')}</option>{executionStatuses.map((item) => <option key={item} value={item}>{rootT(`vocab.executionStatuses.${item}`)}</option>)}
              </select>
            </label>
            <div className="flex items-end"><Button size="sm" variant="secondary" onClick={() => { setEventId(undefined); setStatus(undefined); setProviderId(undefined); setCostCentreId(undefined); }}>{t('clearFilters')}</Button></div>
          </div>
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div><p className="mb-2 text-xs font-medium text-ink">{t('provider')}</p><ProviderPicker value={providerId} onChange={setProviderId} />{providerId === undefined ? null : <Button className="mt-2" size="sm" variant="ghost" onClick={() => setProviderId(undefined)}>{t('clearProvider')}</Button>}</div>
            <div><p className="mb-2 text-xs font-medium text-ink">{t('costCentre')}</p><CostCentrePicker organizationId={currentOrganization.organization._id} value={costCentreId} onChange={setCostCentreId} />{costCentreId === undefined ? null : <Button className="mt-2" size="sm" variant="ghost" onClick={() => setCostCentreId(undefined)}>{t('clearCostCentre')}</Button>}</div>
          </div>
        </PanelBody>
        {readinessValue === undefined ? null : <div className="border-t border-line px-5 py-3 text-sm sm:px-6"><span className="mr-2 inline-flex rounded-pill border border-tone-hold/60 px-2.5 py-1 text-micro font-semibold uppercase text-tone-hold">{t('pending')}</span>{readinessValue.kind === 'atLeast' ? t('readinessAtLeast', { count: readinessValue.count }) : t('readinessExact', { count: readinessValue.count })}</div>}
        {message === null ? null : <div role="alert" className="dispatch-no-print border-t border-line px-5 py-3 text-sm text-tone-stop sm:px-6">{message}</div>}
        {board.status === 'Exhausted' && board.results.length === 0 ? <PanelBody><EmptyState title={t('emptyTitle')} description={t('emptyBody')} /></PanelBody> : (
          <>
            <CoordinatorDesktopTable entries={visibleEntries} loading={board.status === 'LoadingFirstPage'} actor={actor} onMessage={setMessage} />
            <div className="dispatch-mobile-cards flex flex-col gap-4 p-4 md:hidden">{visibleEntries.map((entry) => <CoordinatorCards key={entry.service._id} entry={entry} actor={actor} onMessage={setMessage} />)}</div>
            {board.status !== 'LoadingFirstPage' && visibleEntries.length === 0 && board.results.length > 0 ? <PanelBody><EmptyState tone="filtered" title={t('filteredEmptyTitle')} description={t('filteredEmptyBody')} /></PanelBody> : null}
            <div className="dispatch-load-more"><TableLoadMore status={board.status} loadedCount={board.results.length} pageSize={25} onLoadMore={board.loadMore} /></div>
          </>
        )}
      </Panel>
    </div>
  );
}

function CoordinatorDesktopTable({ entries, loading, actor, onMessage }: { entries: readonly DispatchEntry[]; loading: boolean; actor: Parameters<typeof DispatchExecutionEditor>[0]['actor']; onMessage: (message: string | null) => void }) {
  const t = useTranslations('dispatch');
  const locale = useCanonicalLocale();
  return <div className="dispatch-desktop-table hidden md:block"><Table className="min-w-[92rem]"><TableHead><TableRow><TableHeaderCell>{t('time')}</TableHeaderCell><TableHeaderCell>{t('service')}</TableHeaderCell><TableHeaderCell>{t('provider')}</TableHeaderCell><TableHeaderCell>{t('vehicleClass')}</TableHeaderCell><TableHeaderCell align="end">{t('quantity')}</TableHeaderCell><TableHeaderCell align="end">{t('unitRate')}</TableHeaderCell><TableHeaderCell align="end">{t('lineTotal')}</TableHeaderCell><TableHeaderCell>{t('costCentre')}</TableHeaderCell><TableHeaderCell>{t('driver')}</TableHeaderCell><TableHeaderCell>{t('plate')}</TableHeaderCell><TableHeaderCell>{t('executionStatus')}</TableHeaderCell></TableRow></TableHead>{loading ? <TableSkeletonRows columns={11} rows={3} /> : entries.map((entry) => <TableBody key={entry.service._id} className="dispatch-service-group">{entry.rows.map((row, index) => <CoordinatorRow key={row.assignment._id} entry={entry} row={row} first={index === 0} actor={actor} locale={locale} onMessage={onMessage} />)}</TableBody>)}</Table></div>;
}

function CoordinatorRow({ entry, row, first, actor, locale, onMessage }: { entry: DispatchEntry; row: AssignmentPanelRow; first: boolean; actor: Parameters<typeof DispatchExecutionEditor>[0]['actor']; locale: ReturnType<typeof useCanonicalLocale>; onMessage: (message: string | null) => void }) {
  const t = useTranslations('dispatch');
  const summary = assignmentSummary(row);
  const agreed = summary.kind === 'agreed' ? summary.terms : null;
  return <TableRow><TableCell mono>{first ? formatClockTime(locale, entry.service.startsAt) : ''}</TableCell><TableRowHeaderCell>{first ? entry.service.name : ''}</TableRowHeaderCell><TableCell>{row.provider?.name ?? t('notSet')}</TableCell><TableCell>{agreed?.vehicleClassName ?? t('termsNotReady')}</TableCell><TableCell align="end" mono>{agreed?.quantity ?? t('termsNotReady')}</TableCell><TableCell align="end" mono>{agreed === null ? t('termsNotReady') : money(locale, agreed.unitAmount, agreed.currency)}</TableCell><TableCell align="end" mono>{agreed === null ? t('termsNotReady') : money(locale, agreed.lineTotal, agreed.currency)}</TableCell><TableCell>{agreed === null ? t('termsNotReady') : row.costCentre === null ? t('notSet') : `${row.costCentre.key} · ${row.costCentre.name}`}</TableCell><TableCell>{row.assignment.driverName ?? t('notSet')}</TableCell><TableCell mono>{row.assignment.vehiclePlateOverride ?? (row.assignment.fleetVehicleId === undefined ? t('notSet') : t('assignedVehicle'))}</TableCell><TableCell><StatusChip kind="execution" status={row.assignment.executionStatus} /><DispatchExecutionEditor actor={actor} assignment={row.assignment} onMessage={onMessage} /></TableCell></TableRow>;
}

function CoordinatorCards({ entry, actor, onMessage }: { entry: DispatchEntry; actor: Parameters<typeof DispatchExecutionEditor>[0]['actor']; onMessage: (message: string | null) => void }) {
  const t = useTranslations('dispatch'); const locale = useCanonicalLocale();
  return <section className="dispatch-service-group rounded-input border border-line bg-ground-2 p-4"><dl className="mb-3 grid grid-cols-2 gap-3"><CardField label={t('service')} value={entry.service.name} /><CardField label={t('time')} value={formatClockTime(locale, entry.service.startsAt)} /></dl><div className="flex flex-col gap-3">{entry.rows.map((row) => { const summary = assignmentSummary(row); const terms = summary.kind === 'agreed' ? summary.terms : null; return <article key={row.assignment._id} className="rounded-input border border-line bg-ground-1 p-3"><dl className="grid grid-cols-2 gap-3"><CardField label={t('provider')} value={row.provider?.name ?? t('notSet')} /><CardField label={t('vehicleClass')} value={terms?.vehicleClassName ?? t('termsNotReady')} /><CardField label={t('quantity')} value={terms === null ? t('termsNotReady') : String(terms.quantity)} /><CardField label={t('unitRate')} value={terms === null ? t('termsNotReady') : money(locale, terms.unitAmount, terms.currency)} /><CardField label={t('lineTotal')} value={terms === null ? t('termsNotReady') : money(locale, terms.lineTotal, terms.currency)} /><CardField label={t('costCentre')} value={terms === null ? t('termsNotReady') : row.costCentre === null ? t('notSet') : `${row.costCentre.key} · ${row.costCentre.name}`} /><CardField label={t('driver')} value={row.assignment.driverName ?? t('notSet')} /><CardField label={t('plate')} value={row.assignment.vehiclePlateOverride ?? (row.assignment.fleetVehicleId === undefined ? t('notSet') : t('assignedVehicle'))} /></dl><div className="mt-3"><StatusChip kind="execution" status={row.assignment.executionStatus} /><DispatchExecutionEditor actor={actor} assignment={row.assignment} onMessage={onMessage} /></div></article>; })}</div></section>;
}

function CardField({ label, value }: { label: string; value: string }) { return <div><dt className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{label}</dt><dd className="mt-1 text-sm text-ink">{value}</dd></div>; }
function money(locale: ReturnType<typeof useCanonicalLocale>, amount: number, currency: string): string { return `${currency} ${formatMoneyParts(locale, amount).amount}`; }
