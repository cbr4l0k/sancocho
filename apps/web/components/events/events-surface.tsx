'use client';

import { usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { api } from '@priamo/convex/api';

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
import { LocaleLink } from '@/i18n/locale-link';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { formatEventWindow } from '@/lib/event-window';
import { moneyDisplay } from '@/lib/money';
import { roleAtLeast } from '@/lib/roles';
import { eventStatuses, type EventStatus } from '@/lib/status';

type EventRow = FunctionReturnType<typeof api.events.queries.listOrganizationEvents>['page'][number];
type ProjectId = EventRow['projectId'];

export function EventsSurface() {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const [status, setStatus] = useState<EventStatus | ''>('');
  const [projectId, setProjectId] = useState<ProjectId | ''>('');
  const organizationId = currentOrganization?.organization._id;
  const events = usePaginatedQuery(
    api.events.queries.listOrganizationEvents,
    organizationId === undefined
      ? 'skip'
      : {
          organizationId,
          ...(status === '' ? {} : { status }),
          ...(projectId === '' ? {} : { projectId }),
        },
    { initialNumItems: 25 },
  );
  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    organizationId === undefined
      ? 'skip'
      : {
          organizationId,
        },
    { initialNumItems: 100 },
  );
  if (currentOrganization === null) return null;
  const filtered = status !== '' || projectId !== '';
  const canManage = roleAtLeast(currentOrganization.role, 'planner');
  return (
    <div className="flex flex-col gap-6">
      {canManage ? (
        <PageHeader
          actions={
            <Button variant="primary" render={<LocaleLink to="/events/new" />}>
              {t('events.create')}
            </Button>
          }
        />
      ) : null}
      <Panel>
        <PanelHeader>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <PanelTitle>{t('events.listTitle')}</PanelTitle>
            <div className="flex flex-wrap gap-3">
              <Filter
                label={t('events.statusFilter')}
                value={status}
                onChange={(value) => setStatus(eventStatuses.find((item) => item === value) ?? '')}
              >
                <option value="">{t('events.allStatuses')}</option>
                {eventStatuses.map((item) => (
                  <option key={item} value={item}>
                    {t(`events.statuses.${item}`)}
                  </option>
                ))}
              </Filter>
              <Filter
                label={t('events.projectFilter')}
                value={projectId}
                onChange={(value) => setProjectId(projects.results.find((item) => item._id === value)?._id ?? '')}
              >
                <option value="">{t('events.allProjects')}</option>
                {projects.results.map((project) => (
                  <option key={project._id} value={project._id}>
                    {project.name}
                  </option>
                ))}
              </Filter>
              {projects.status === 'CanLoadMore' ? (
                <Button size="sm" onClick={() => projects.loadMore(100)}>
                  {t('table.loadMore')}
                </Button>
              ) : null}
            </div>
          </div>
        </PanelHeader>
        {events.status === 'Exhausted' && events.results.length === 0 ? (
          <PanelBody>
            <EmptyState
              tone={filtered ? 'filtered' : 'empty'}
              title={t(filtered ? 'events.noMatchesTitle' : 'events.emptyTitle')}
              description={t(filtered ? 'events.noMatchesBody' : 'events.emptyBody')}
              action={
                filtered ? (
                  <Button
                    onClick={() => {
                      setStatus('');
                      setProjectId('');
                    }}
                  >
                    {t('events.clearFilters')}
                  </Button>
                ) : canManage ? (
                  <Button variant="primary" render={<LocaleLink to="/events/new" />}>
                    {t('events.create')}
                  </Button>
                ) : undefined
              }
            />
          </PanelBody>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('events.name')}</TableHeaderCell>
                <TableHeaderCell>{t('events.status')}</TableHeaderCell>
                <TableHeaderCell>{t('events.window')}</TableHeaderCell>
                <TableHeaderCell align="end">{t('events.budget')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            {events.status === 'LoadingFirstPage' ? (
              <TableSkeletonRows columns={4} />
            ) : (
              <TableBody>
                {events.results.map((event) => (
                  <EventTableRow key={event._id} event={event} />
                ))}
              </TableBody>
            )}
          </Table>
        )}
      </Panel>
      <TableLoadMore loadedCount={events.results.length} status={events.status} onLoadMore={events.loadMore} />
    </div>
  );
}

function EventTableRow({ event }: { event: EventRow }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const display = moneyDisplay(locale, event.budgetAmount, event.budgetCurrency);
  const budget =
    display.kind === 'unset'
      ? t('events.notSet')
      : t('common.moneyValue', { amount: display.amount, currency: display.currency });
  return (
    <TableRow>
      <TableRowHeaderCell>
        <LocaleLink
          className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
          to={`/events/${event._id}`}
        >
          {event.name}
        </LocaleLink>
      </TableRowHeaderCell>
      <TableCell>
        <StatusChip kind="event" status={event.status} />
      </TableCell>
      <TableCell mono>{formatEventWindow(locale, event.startsAt, event.endsAt)}</TableCell>
      <TableCell align="end" mono>
        {budget}
      </TableCell>
    </TableRow>
  );
}

function Filter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
      {label}
      <select
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}
