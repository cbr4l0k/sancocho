'use client';

import { usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { EmptyState } from '@/components/ui/empty-state';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import {
  Table, TableBody, TableCell, TableHead, TableHeaderCell, TableLoadMore,
  TableRow, TableRowHeaderCell, TableSkeletonRows,
} from '@/components/ui/table';
import { LocaleLink } from '@/i18n/locale-link';

type Engagement = FunctionReturnType<typeof api.providers.queries.listMyProviderEngagements>['page'][number];
type Assignment = FunctionReturnType<typeof api.assignments.queries.listProjectAssignments>['page'][number];

export function AssignmentsSurface({
  projectId,
  showBackLink = true,
}: {
  projectId: Engagement['projectId'];
  showBackLink?: boolean;
}) {
  const { currentOrganization } = useCurrentOrganization();
  const t = useTranslations('portal');
  // No client-side resolution step. The backend re-proves the grant on this very
  // call — an unauthorized or revoked Project is refused there — so asking it
  // directly is both simpler and the only authority that counts. A refusal
  // surfaces through the route error boundary as UnavailableState, exactly as
  // an id that never existed would (I9).
  const assignments = usePaginatedQuery(
    api.assignments.queries.listProjectAssignments,
    currentOrganization === null ? 'skip' : { projectId },
    { initialNumItems: 25 },
  );

  if (currentOrganization === null) return null;

  return (
    <div className="flex flex-col gap-4">
      {showBackLink ? (
        <LocaleLink className="text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink" to="/portal">
          {t('backToEngagements')}
        </LocaleLink>
      ) : null}
      <Panel emphasis="focal">
        <PanelHeader>
          <div>
            <PanelTitle>{t('assignmentsTitle')}</PanelTitle>
            <PanelDescription>{t('assignmentsDescription')}</PanelDescription>
          </div>
        </PanelHeader>
        {assignments.status === 'Exhausted' && assignments.results.length === 0 ? (
          <PanelBody><EmptyState title={t('assignmentsEmpty')} description={t('assignmentsEmptyBody')} /></PanelBody>
        ) : (
          <>
            <Table>
              <TableHead><TableRow>
                <TableHeaderCell>{t('assignment')}</TableHeaderCell>
                <TableHeaderCell>{t('executionStatus')}</TableHeaderCell>
                <TableHeaderCell>{t('driver')}</TableHeaderCell>
                <TableHeaderCell>{t('vehiclePlate')}</TableHeaderCell>
              </TableRow></TableHead>
              {assignments.status === 'LoadingFirstPage' ? <TableSkeletonRows columns={4} /> : (
                <TableBody>{assignments.results.map((assignment) => <AssignmentRow key={assignment._id} assignment={assignment} />)}</TableBody>
              )}
            </Table>
            <TableLoadMore loadedCount={assignments.results.length} status={assignments.status} onLoadMore={assignments.loadMore} />
          </>
        )}
      </Panel>
    </div>
  );
}

function AssignmentRow({ assignment }: { assignment: Assignment }) {
  const t = useTranslations('portal');
  return (
    <TableRow>
      <TableRowHeaderCell>
        <LocaleLink className="underline decoration-line-strong underline-offset-4 hover:decoration-accent" to={`/portal/assignments/${assignment._id}`}>
          {t('assignmentLabel', { number: assignment.position + 1 })}
        </LocaleLink>
      </TableRowHeaderCell>
      <TableCell><StatusChip kind="execution" status={assignment.executionStatus} /></TableCell>
      <TableCell>{assignment.driverName ?? t('notSet')}</TableCell>
      <TableCell mono>{assignment.vehiclePlateOverride ?? t('notSet')}</TableCell>
    </TableRow>
  );
}
