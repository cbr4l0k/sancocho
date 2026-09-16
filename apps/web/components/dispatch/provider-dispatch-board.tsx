'use client';

import { usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';
import { executionStatuses } from '@priamo/convex/assignments/execution';

import { DispatchDayNavigation, DispatchExecutionEditor, useBrowserDispatchDay } from '@/components/dispatch/dispatch-controls';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableLoadMore, TableRow, TableRowHeaderCell, TableSkeletonRows } from '@/components/ui/table';
import { formatClockTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import {
  dispatchSheetCompleteness,
  groupProviderDispatch,
  providerDispatchArgs,
  type ProviderDispatchGroup,
} from '@/lib/dispatch-board';
import { engagementDisplayNumber } from '@/lib/portal-engagement';
import { formatProjectionValue, type ProjectionEntry } from '@/lib/portal-projection';
import { semanticTypeMessageKey } from '@/i18n/vocab-keys';

type Engagement = FunctionReturnType<typeof api.providers.queries.listMyProviderEngagements>['page'][number];
type ProviderArgs = Parameters<typeof providerDispatchArgs>;
type ExecutionStatus = NonNullable<ProviderArgs[2]['status']>;

export function ProviderDispatchBoard({ initialDayKey }: { initialDayKey?: string | undefined }) {
  const t = useTranslations('dispatch');
  const rootT = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const day = useBrowserDispatchDay(initialDayKey);
  const [projectId, setProjectId] = useState<Engagement['projectId'] | ''>('');
  const [status, setStatus] = useState<ExecutionStatus | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const engagements = usePaginatedQuery(
    api.providers.queries.listMyProviderEngagements,
    currentOrganization === null ? 'skip' : { providerOrganizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );
  const selectedProjectId = projectId === '' ? engagements.results[0]?.projectId : projectId;
  const selectedIndex = engagements.results.findIndex((engagement) => engagement.projectId === selectedProjectId);
  const board = usePaginatedQuery(
    api.assignments.queries.listProviderDispatchDay,
    selectedProjectId === undefined || day === undefined ? 'skip' : providerDispatchArgs(selectedProjectId, day, { status }),
    { initialNumItems: 50 },
  );
  const groups = groupProviderDispatch(board.results);
  const sheetCompleteness = dispatchSheetCompleteness(board.status);
  const engagementLabel = selectedIndex < 0 ? t('chooseEngagement') : t('engagementProject', { number: engagementDisplayNumber(selectedIndex) });

  if (currentOrganization === null || day === undefined) return null;
  return (
    <div className="dispatch-sheet flex min-w-0 flex-col gap-5">
      <div className="dispatch-print-header">
        <h1>{t('providerPrintTitle')}</h1>
        <p>{engagementLabel} · {day.key}</p>
        <p>{status === undefined ? t('noActiveFilters') : rootT(`vocab.executionStatuses.${status}`)}</p>
        <p>{sheetCompleteness.kind === 'complete' ? t('printComplete') : t('printLoadedAssignmentsOnly', { count: board.results.length })}</p>
      </div>
      <Panel emphasis="focal">
        <PanelHeader className="dispatch-no-print">
          <div><PanelTitle>{t('providerTitle')}</PanelTitle><PanelDescription>{t('providerDescription')}</PanelDescription></div>
          <DispatchDayNavigation day={day} path="/portal/dispatch" />
        </PanelHeader>
        <PanelBody className="dispatch-no-print border-t border-line">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2 text-xs font-medium text-ink">{t('engagement')}
              <select className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" value={selectedProjectId ?? ''} onChange={(event) => setProjectId(engagements.results.find((item) => item.projectId === event.target.value)?.projectId ?? '')}>
                {engagements.results.length === 0 ? <option value="">{t('chooseEngagement')}</option> : null}
                {engagements.results.map((engagement, index) => <option key={engagement._id} value={engagement.projectId}>{t('engagementProject', { number: engagementDisplayNumber(index) })}</option>)}
              </select>
              {engagements.status === 'CanLoadMore' ? <Button size="sm" variant="ghost" onClick={() => engagements.loadMore(25)}>{rootT('table.loadMore')}</Button> : null}
            </label>
            <label className="flex flex-col gap-2 text-xs font-medium text-ink">{t('executionStatus')}
              <select className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" value={status ?? ''} onChange={(event) => setStatus(executionStatuses.find((item) => item === event.target.value))}>
                <option value="">{t('allStatuses')}</option>{executionStatuses.map((item) => <option key={item} value={item}>{rootT(`vocab.executionStatuses.${item}`)}</option>)}
              </select>
            </label>
          </div>
          <p className="mt-4 text-xs text-ink-3">{sheetCompleteness.kind === 'complete' ? t('providerOrderComplete') : t('providerOrderPartial')}</p>
        </PanelBody>
        {message === null ? null : <div role="alert" className="dispatch-no-print border-t border-line px-5 py-3 text-sm text-tone-stop sm:px-6">{message}</div>}
        {board.status === 'Exhausted' && groups.length === 0 ? <PanelBody><EmptyState title={t('emptyTitle')} description={t('providerEmptyBody')} /></PanelBody> : (
          <>
            <ProviderDesktopTable groups={groups} loading={board.status === 'LoadingFirstPage'} onMessage={setMessage} />
            <div className="dispatch-mobile-cards flex flex-col gap-4 p-4 md:hidden">{groups.map((group) => <ProviderCards key={group.service._id} group={group} onMessage={setMessage} />)}</div>
            <div className="dispatch-load-more"><TableLoadMore status={board.status} loadedCount={board.results.length} pageSize={50} onLoadMore={board.loadMore} /></div>
          </>
        )}
      </Panel>
    </div>
  );
}

function ProviderDesktopTable({ groups, loading, onMessage }: { groups: readonly ProviderDispatchGroup[]; loading: boolean; onMessage: (message: string | null) => void }) {
  const t = useTranslations('dispatch'); const locale = useCanonicalLocale();
  return <div className="dispatch-desktop-table hidden md:block"><Table className="min-w-[64rem]"><TableHead><TableRow><TableHeaderCell>{t('time')}</TableHeaderCell><TableHeaderCell>{t('assignmentPosition')}</TableHeaderCell><TableHeaderCell>{t('serviceContext')}</TableHeaderCell><TableHeaderCell>{t('driver')}</TableHeaderCell><TableHeaderCell>{t('plate')}</TableHeaderCell><TableHeaderCell>{t('executionStatus')}</TableHeaderCell></TableRow></TableHead>{loading ? <TableSkeletonRows columns={6} rows={3} /> : groups.map((group) => <TableBody key={group.service._id} className="dispatch-service-group">{group.entries.map((entry, index) => <TableRow key={entry.assignment._id}><TableCell mono>{index === 0 ? formatClockTime(locale, group.service.startsAt) : ''}</TableCell><TableRowHeaderCell>{entry.assignment.position + 1}</TableRowHeaderCell><TableCell>{index === 0 ? <Projection entries={group.serviceProjection} /> : null}</TableCell><TableCell>{entry.assignment.driverName ?? t('notSet')}</TableCell><TableCell mono>{entry.assignment.vehiclePlateOverride ?? (entry.assignment.fleetVehicleId === undefined ? t('notSet') : t('assignedVehicle'))}</TableCell><TableCell><StatusChip kind="execution" status={entry.assignment.executionStatus} /><DispatchExecutionEditor actor={{ kind: 'provider' }} assignment={entry.assignment} onMessage={onMessage} /></TableCell></TableRow>)}</TableBody>)}</Table></div>;
}

function ProviderCards({ group, onMessage }: { group: ProviderDispatchGroup; onMessage: (message: string | null) => void }) {
  const t = useTranslations('dispatch'); const locale = useCanonicalLocale();
  return <section className="dispatch-service-group rounded-input border border-line bg-ground-2 p-4"><header className="mb-3"><dl><CardField label={t('time')} value={formatClockTime(locale, group.service.startsAt)} /></dl><div className="mt-2"><Projection entries={group.serviceProjection} /></div></header><div className="flex flex-col gap-3">{group.entries.map((entry) => <article key={entry.assignment._id} className="rounded-input border border-line bg-ground-1 p-3"><dl className="grid grid-cols-2 gap-3"><CardField label={t('assignmentPosition')} value={String(entry.assignment.position + 1)} /><CardField label={t('driver')} value={entry.assignment.driverName ?? t('notSet')} /><CardField label={t('plate')} value={entry.assignment.vehiclePlateOverride ?? (entry.assignment.fleetVehicleId === undefined ? t('notSet') : t('assignedVehicle'))} /></dl><div className="mt-3"><StatusChip kind="execution" status={entry.assignment.executionStatus} /><DispatchExecutionEditor actor={{ kind: 'provider' }} assignment={entry.assignment} onMessage={onMessage} /></div></article>)}</div></section>;
}

function Projection({ entries }: { entries: readonly ProjectionEntry[] }) {
  const t = useTranslations('dispatch'); const rootT = useTranslations(); const locale = useCanonicalLocale();
  if (entries.length === 0) return <span className="text-xs text-ink-3">{t('projectionEmpty')}</span>;
  return <dl className="grid gap-2">{entries.map((entry, index) => <div key={`${entry.semanticType}-${index}`}><dt className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{rootT(`fields.semanticTypes.${semanticTypeMessageKey[entry.semanticType]}.label`)} <span className="normal-case tracking-normal">({entry.label})</span></dt><dd className="whitespace-pre-wrap text-sm text-ink">{formatProjectionValue(locale, entry, t('notSet'))}</dd></div>)}</dl>;
}

function CardField({ label, value }: { label: string; value: string }) { return <div><dt className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{label}</dt><dd className="mt-1 text-sm text-ink">{value}</dd></div>; }
