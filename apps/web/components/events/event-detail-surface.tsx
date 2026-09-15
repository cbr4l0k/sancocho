'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableLoadMore, TableRow, TableRowHeaderCell, TableSkeletonRows } from '@/components/ui/table';
import { LocaleLink } from '@/i18n/locale-link';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { formatEventWindow } from '@/lib/event-window';
import { moneyDisplay } from '@/lib/money';
import { roleAtLeast } from '@/lib/roles';
import type { EventStatus } from '@/lib/status';

import { EventForm } from './event-form';

type EventId = FunctionArgs<typeof api.events.queries.getEventDetail>['eventId'];
type NextStatus = Exclude<EventStatus, 'archived'>;

const nextStatuses: Readonly<Record<EventStatus, readonly NextStatus[]>> = {
  draft: ['active'],
  active: ['completed'],
  completed: [],
  archived: [],
};

export function EventDetailSurface({ eventId }: { eventId: EventId }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const detail = useQuery(api.events.queries.getEventDetail, { eventId });
  const services = usePaginatedQuery(api.services.queries.listEventServices, { eventId }, { initialNumItems: 25 });
  const changeStatus = useMutation(api.events.mutations.changeEventStatus);
  const archive = useMutation(api.events.mutations.archiveEvent);
  const [editing, setEditing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (detail === undefined || currentOrganization === null) return null;
  const canManage = roleAtLeast(currentOrganization.role, 'planner') && detail.event.status !== 'archived' && detail.project.status !== 'archived';
  const budgetDisplay = moneyDisplay(locale, detail.event.budgetAmount, detail.event.budgetCurrency);
  const budget = budgetDisplay.kind === 'unset'
    ? t('events.notSet')
    : t('common.moneyValue', { amount: budgetDisplay.amount, currency: budgetDisplay.currency });

  async function transition(status: NextStatus): Promise<void> {
    try { await changeStatus({ eventId, status }); }
    catch (error) { setMessage(t(errorMessageKey(presentConvexError(error)))); }
  }
  async function confirmArchive(): Promise<void> {
    try { await archive({ eventId }); setConfirmingArchive(false); }
    catch (error) { setMessage(t(errorMessageKey(presentConvexError(error)))); }
  }

  return <div className="flex flex-col gap-6">
    <PageHeader badge={<StatusChip emphasis="loud" kind="event" status={detail.event.status} />} actions={canManage && !editing ? <>
      <Button onClick={() => setEditing(true)}>{t('events.edit')}</Button>
      {nextStatuses[detail.event.status].map((status) => <Button key={status} onClick={() => transition(status)}>{t('events.advanceTo', { status: t(`events.statuses.${status}`) })}</Button>)}
      <Button variant="danger" onClick={() => setConfirmingArchive(true)}>{t('events.archive')}</Button>
    </> : undefined} />
    {message === null ? null : <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">{message}</p>}
    {confirmingArchive ? <Panel emphasis="focal"><PanelHeader><div><PanelTitle>{t('events.archiveTitle')}</PanelTitle><PanelDescription>{t('events.archiveWarning')}</PanelDescription></div></PanelHeader><PanelBody className="flex-row flex-wrap"><Button variant="danger" onClick={confirmArchive}>{t('events.archiveConfirm')}</Button><Button onClick={() => setConfirmingArchive(false)}>{t('events.cancel')}</Button></PanelBody></Panel> : null}
    {editing ? <EventForm detail={detail} onCancel={() => setEditing(false)} /> : <Panel emphasis="focal">
      <PanelHeader><PanelTitle>{detail.event.name}</PanelTitle></PanelHeader>
      <PanelBody><dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Readout label={t('events.project')} value={detail.project.name} />
        <Readout label={t('events.window')} value={formatEventWindow(locale, detail.event.startsAt, detail.event.endsAt)} mono />
        <Readout label={t('events.venue')} value={detail.venue?.name ?? t('events.notSet')} />
        <Readout label={t('events.costCentre')} value={detail.clientCostCentre === null ? t('events.notSet') : `${detail.clientCostCentre.name} · ${detail.clientCostCentre.key}`} />
        <Readout label={t('events.budget')} value={budget} mono />
        <Readout label={t('events.accountable')} value={detail.accountable?.name ?? detail.accountable?.email ?? t('events.notSet')} />
      </dl></PanelBody>
    </Panel>}
    {detail.event.status === 'archived' ? <p className="rounded-input border border-line px-4 py-3 text-sm text-ink-2">{t('events.archivedNotice')}</p> : null}
    {!canManage && detail.event.status !== 'archived' ? <p className="text-xs text-ink-3">{t('events.permissionNotice')}</p> : null}
    <Panel><PanelHeader><PanelTitle>{t('events.servicesTitle')}</PanelTitle></PanelHeader>
      {services.status === 'Exhausted' && services.results.length === 0 ? <PanelBody><EmptyState title={t('events.servicesEmptyTitle')} description={t('events.servicesEmptyBody')} /></PanelBody> : <Table>
        <TableHead><TableRow><TableHeaderCell>{t('services.name')}</TableHeaderCell><TableHeaderCell>{t('services.status')}</TableHeaderCell><TableHeaderCell>{t('services.startsAt')}</TableHeaderCell></TableRow></TableHead>
        {services.status === 'LoadingFirstPage' ? <TableSkeletonRows columns={3} /> : <TableBody>{services.results.map((service) => <TableRow key={service._id}><TableRowHeaderCell><LocaleLink className="text-ink underline decoration-line-strong underline-offset-4" to={`/services/${service._id}`}>{service.name}</LocaleLink></TableRowHeaderCell><TableCell><StatusChip kind="service" status={service.status} /></TableCell><TableCell mono>{formatDateTime(locale, service.startsAt)}</TableCell></TableRow>)}</TableBody>}
      </Table>}
    </Panel>
    <TableLoadMore loadedCount={services.results.length} status={services.status} onLoadMore={services.loadMore} />
  </div>;
}

function Readout({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{label}</dt><dd className={mono ? 'mt-1 font-mono text-xs text-ink' : 'mt-1 text-sm text-ink'}>{value}</dd></div>;
}
