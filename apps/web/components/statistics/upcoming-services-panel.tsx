'use client';

import { useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@sancocho/convex/api';

import { Field, FieldControl, FieldLabel } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody, PanelBodyFlush, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeaderCell, TableSkeletonRows } from '@/components/ui/table';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { LocaleLink } from '@/i18n/locale-link';
import { resolveUpcomingWindow } from '@/lib/statistics-date-range';
import { defaultUpcomingWindowDays, upcomingWindowOptions, type UpcomingWindowDays } from '@/lib/statistics-upcoming-window';

import type { OrganizationId } from './statistics-types';

const upcomingLimit = 50;
const columnCount = 3;

/**
 * Upcoming services in a bounded window, ordered by `startsAt`.
 *
 * Deliberately independent of the project/date filter bar above: the backend
 * query has its own status contract (excludes cancelled and completed — see
 * "Upcoming is a status contract, not just a time window" in
 * `docs/statistics.md`) and its own hard-capped window/limit, and was never
 * folded into the filtered-read family (`docs/statistics.md`, "Which existing
 * queries did NOT get a filter"). Its own window control (7/14/31 days) is
 * therefore a separate, smaller control local to this panel.
 */
export function UpcomingServicesPanel({ organizationId }: { organizationId: OrganizationId }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const [windowDays, setWindowDays] = useState<UpcomingWindowDays>(defaultUpcomingWindowDays);
  // `Date.now()` is an impure call and may not run in the render body
  // directly (React's purity rule) — capturing it once via a `useState` lazy
  // initializer is the sanctioned way to seed one-time impure state, and
  // keeps "now" stable across re-renders instead of drifting on every one.
  const [now] = useState(() => Date.now());
  const window = resolveUpcomingWindow(windowDays, now);

  const services = useQuery(api.statistics.queries.getUpcomingServices, {
    organizationId,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    limit: upcomingLimit,
  });

  return (
    <Panel className="h-full">
      <PanelHeader>
        <PanelTitle>{t('statistics.upcomingTitle')}</PanelTitle>
        <Field className="w-40">
          <FieldLabel className="sr-only">{t('statistics.upcomingWindowLabel')}</FieldLabel>
          <FieldControl
            render={<select />}
            value={windowDays}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              const next = upcomingWindowOptions.find((option) => option === parsed);
              if (next !== undefined) setWindowDays(next);
            }}
          >
            {upcomingWindowOptions.map((days) => (
              <option key={days} value={days}>
                {t('statistics.upcomingWindowOption', { days })}
              </option>
            ))}
          </FieldControl>
        </Field>
      </PanelHeader>
      <PanelBodyFlush>
        <p className="px-5 pb-2 text-xs text-ink-3 sm:px-6">{t('statistics.upcomingStatusNotice')}</p>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('statistics.upcomingName')}</TableHeaderCell>
              <TableHeaderCell>{t('statistics.upcomingStartsAt')}</TableHeaderCell>
              <TableHeaderCell align="end">{t('services.status')}</TableHeaderCell>
            </TableRow>
          </TableHead>
          {services === undefined ? (
            <TableSkeletonRows columns={columnCount} />
          ) : (
            <TableBody>
              {services.map((service) => (
                <TableRow key={service._id}>
                  <TableRowHeaderCell>
                    <LocaleLink
                      className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
                      to={`/services/${service._id}`}
                    >
                      {service.name}
                    </LocaleLink>
                  </TableRowHeaderCell>
                  <TableCell mono>{formatDateTime(locale, service.startsAt)}</TableCell>
                  <TableCell align="end">
                    <StatusChip kind="service" status={service.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          )}
        </Table>
        {services !== undefined && services.length === 0 ? (
          <div className="p-5">
            <EmptyState tone="empty" title={t('statistics.upcomingEmptyTitle')} description={t('statistics.upcomingEmptyBody')} />
          </div>
        ) : null}
      </PanelBodyFlush>
    </Panel>
  );
}
