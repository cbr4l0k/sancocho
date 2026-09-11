'use client';

import { usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { EmptyState } from '@/components/ui/empty-state';
import {
  Panel, PanelBody, PanelDescription, PanelEyebrow, PanelHeader, PanelTitle,
} from '@/components/ui/panel';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { StatusChip } from '@/components/ui/status-chip';
import {
  Table, TableBody, TableCell, TableHead, TableHeaderCell, TableLoadMore,
  TableRow, TableRowHeaderCell, TableSkeletonRows,
} from '@/components/ui/table';
import { formatDateTime, formatNumber } from '@/i18n/formats';
import { LocaleLink } from '@/i18n/locale-link';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { formatProjectionValue, prepareProjectionGroups } from '@/lib/portal-projection';

type AssignmentDetail = FunctionReturnType<typeof api.assignments.queries.getAssignmentDetail>;
type AssignmentId = AssignmentDetail['assignment']['_id'];
type Revision = FunctionReturnType<typeof api.assignments.queries.listAssignmentRevisions>['page'][number];

export function AssignmentDetailSurface({ assignmentId }: { assignmentId: AssignmentId }) {
  const t = useTranslations('portal');
  const rootT = useTranslations();
  const locale = useCanonicalLocale();
  const detail = useQuery(api.assignments.queries.getAssignmentDetail, { assignmentId });
  const revisions = usePaginatedQuery(
    api.assignments.queries.listAssignmentRevisions,
    { assignmentId },
    { initialNumItems: 25 },
  );
  // The Assignment carries its own `projectId` — the Provider arm's narrowed view
  // keeps it — and the engagement route is keyed on exactly that. So the back
  // link needs no lookup: finding the matching engagement row meant paging the
  // whole grant list client-side to build one href.

  if (detail === undefined) {
    return (
      <Panel emphasis="focal" aria-busy="true">
        <PanelHeader><Skeleton className="h-6 w-52" /></PanelHeader>
        <PanelBody><SkeletonText /></PanelBody>
      </Panel>
    );
  }

  const groups = prepareProjectionGroups(detail.serviceProjection);
  return (
    <div className="flex flex-col gap-4">
      <LocaleLink className="text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink" to={`/portal/engagements/${detail.assignment.projectId}`}>
        {t('backToAssignments')}
      </LocaleLink>
      <Panel emphasis="focal">
        <PanelHeader>
          <div>
            <PanelEyebrow>{t('assignment')}</PanelEyebrow>
            <PanelTitle>{t('assignmentLabel', { number: detail.assignment.position + 1 })}</PanelTitle>
            <PanelDescription>{t('assignmentDetailDescription')}</PanelDescription>
          </div>
          <StatusChip kind="execution" status={detail.assignment.executionStatus} emphasis="loud" />
        </PanelHeader>
        <PanelBody>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Readout term={t('driver')} value={detail.assignment.driverName ?? t('notSet')} />
            <Readout term={t('driverPhone')} value={detail.assignment.driverPhone ?? t('notSet')} />
            <Readout term={t('vehicle')} value={detail.assignment.fleetVehicleId === undefined ? t('notSet') : t('vehicleAssigned')} />
            <Readout term={t('vehiclePlate')} value={detail.assignment.vehiclePlateOverride ?? t('notSet')} mono />
            <Readout term={t('dispatchedAt')} value={detail.assignment.dispatchedAt === undefined ? t('notSet') : formatDateTime(locale, detail.assignment.dispatchedAt)} mono />
            <Readout term={t('completedAt')} value={detail.assignment.completedAt === undefined ? t('notSet') : formatDateTime(locale, detail.assignment.completedAt)} mono />
            <Readout term={t('notes')} value={detail.assignment.notes ?? t('notSet')} />
            {detail.assignment.notExecutedReason === undefined ? null : <Readout term={t('notExecutedReason')} value={detail.assignment.notExecutedReason} />}
          </dl>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader><div><PanelTitle>{t('serviceProjectionTitle')}</PanelTitle><PanelDescription>{t('serviceProjectionDescription')}</PanelDescription></div></PanelHeader>
        <PanelBody>
          {groups.length === 0 ? <EmptyState title={t('projectionEmpty')} description={t('projectionEmptyBody')} /> : (
            <div className="flex flex-col gap-5">
              {groups.map((group, groupIndex) => (
                <section key={`${group.group}-${groupIndex}`} className="flex flex-col gap-3">
                  <h3 className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{t(`projectionGroups.${group.group}`)}</h3>
                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {group.entries.map((entry, entryIndex) => (
                      <div key={`${entry.semanticType}-${entryIndex}`} className="rounded-input border border-line bg-ground-2 px-4 py-3">
                        <dt className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-xs font-semibold text-ink">{rootT(`fields.semanticTypes.${entry.semanticLabelKey}.label`)}</span>
                          <span className="text-xs text-ink-3">({entry.label})</span>
                        </dt>
                        <dd className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{formatProjectionValue(locale, entry, t('notSet'))}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader><div><PanelTitle>{t('revisionsTitle')}</PanelTitle><PanelDescription>{t('revisionsDescription')}</PanelDescription></div></PanelHeader>
        {revisions.status === 'Exhausted' && revisions.results.length === 0 ? (
          <PanelBody><EmptyState title={t('revisionsEmpty')} description={t('revisionsEmptyBody')} /></PanelBody>
        ) : (
          <>
            <Table>
              <TableHead><TableRow>
                <TableHeaderCell>{t('revision')}</TableHeaderCell><TableHeaderCell>{t('termsStatus')}</TableHeaderCell>
                <TableHeaderCell align="end">{t('quantity')}</TableHeaderCell><TableHeaderCell align="end">{t('unitAmount')}</TableHeaderCell>
                <TableHeaderCell align="end">{t('lineTotal')}</TableHeaderCell><TableHeaderCell>{t('modality')}</TableHeaderCell>
                <TableHeaderCell>{t('recordedAt')}</TableHeaderCell><TableHeaderCell>{t('revisionDetail')}</TableHeaderCell>
              </TableRow></TableHead>
              {revisions.status === 'LoadingFirstPage' ? <TableSkeletonRows columns={8} /> : (
                <TableBody>{revisions.results.map((revision) => <RevisionRow key={revision._id} revision={revision} />)}</TableBody>
              )}
            </Table>
            <TableLoadMore loadedCount={revisions.results.length} status={revisions.status} onLoadMore={revisions.loadMore} />
          </>
        )}
      </Panel>
    </div>
  );
}

function Readout({ term, value, mono = false }: { term: string; value: string; mono?: boolean | undefined }) {
  return <div><dt className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{term}</dt><dd className={mono ? 'mt-1 font-mono text-xs text-ink' : 'mt-1 text-sm text-ink'}>{value}</dd></div>;
}

function RevisionRow({ revision }: { revision: Revision }) {
  const t = useTranslations('portal');
  const locale = useCanonicalLocale();
  return <TableRow>
    <TableRowHeaderCell>{t('revisionLabel', { number: revision.revisionNumber })}</TableRowHeaderCell>
    <TableCell><StatusChip kind="assignmentRevision" status={revision.status} /></TableCell>
    <TableCell align="end" mono>{formatNumber(locale, revision.quantity)}</TableCell>
    <TableCell align="end" mono>{t('moneyValue', { amount: formatNumber(locale, revision.unitAmount / 100), currency: revision.currency })}</TableCell>
    <TableCell align="end" mono>{t('moneyValue', { amount: formatNumber(locale, revision.lineTotal / 100), currency: revision.currency })}</TableCell>
    <TableCell>{t(`modalities.${revision.modality}`)}</TableCell>
    <TableCell mono>{formatDateTime(locale, revision._creationTime)}</TableCell>
    <TableCell>{revision.declinedReason ?? (revision.acceptedAt === undefined ? t('notSet') : t('acceptedAt', { value: formatDateTime(locale, revision.acceptedAt) }))}</TableCell>
  </TableRow>;
}
