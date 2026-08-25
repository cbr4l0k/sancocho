'use client';

import { usePaginatedQuery } from 'convex/react';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { InviteMemberPanel } from '@/components/organizations/invite-member-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBodyFlush } from '@/components/ui/panel';
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
import { roleAtLeast, roleLabelKey } from '@/lib/roles';

export default function SettingsPage() {
  const { currentOrganization } = useCurrentOrganization();
  const t = useTranslations();
  const members = usePaginatedQuery(
    api.organizations.queries.listMembers,
    currentOrganization === null ? 'skip' : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );

  if (currentOrganization === null) return null;

  // UI role check only — an affordance, never authorization (I1). The
  // backend re-proves admin on every invitations mutation regardless.
  const isAdmin = roleAtLeast(currentOrganization.role, 'admin');

  return (
    <div className="flex flex-col gap-6">
      {isAdmin ? (
        <InviteMemberPanel organizationId={currentOrganization.organization._id} callerRole={currentOrganization.role} />
      ) : null}
      <PageHeader title={t('organizations.rosterTitle')} />
      <Panel>
        <PanelBodyFlush>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('organizations.memberName')}</TableHeaderCell>
                <TableHeaderCell>{t('organizations.memberEmail')}</TableHeaderCell>
                <TableHeaderCell>{t('organizations.memberRole')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            {members.status === 'LoadingFirstPage' ? (
              <TableSkeletonRows columns={3} />
            ) : (
              <TableBody>
                {members.results.map(({ membership, user }) => {
                  return (
                    <TableRow key={membership._id}>
                      <TableRowHeaderCell>{user.name ?? user.email ?? t('common.notAvailable')}</TableRowHeaderCell>
                      <TableCell>{user.email ?? t('common.notAvailable')}</TableCell>
                      <TableCell>
                        <span className="inline-flex h-6 items-center rounded-pill bg-ground-2 px-2.5 text-micro font-semibold text-ink-2">
                          {t(roleLabelKey[membership.role])}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            )}
          </Table>
          {members.status === 'Exhausted' && members.results.length === 0 ? (
            <EmptyState title={t('empty.noRecords')} description={t('empty.noRecordsBody')} />
          ) : (
            <TableLoadMore status={members.status} loadedCount={members.results.length} onLoadMore={members.loadMore} />
          )}
        </PanelBodyFlush>
      </Panel>
    </div>
  );
}
