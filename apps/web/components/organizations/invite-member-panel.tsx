'use client';

import { useMutation, usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldLabel } from '@/components/ui/field';
import { Panel, PanelBody, PanelBodyFlush, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
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
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError, type ConvexErrorPresentation } from '@/lib/convex-errors';
import { type Role, roleAtLeast, roleLabelKey } from '@/lib/roles';

type PendingInvitation = FunctionReturnType<typeof api.invitations.queries.listPendingInvitations>['page'][number];
type OrganizationId = FunctionReturnType<typeof api.organizations.mutations.createOrganization>;

// An admin may invite anyone except as owner (canAssignRole's rule, restated
// here only as a UI affordance — the backend is the sole authority, I1).
const invitableRoles: readonly Role[] = ['admin', 'planner', 'operator', 'viewer'];
const ownerInvitableRoles: readonly Role[] = ['owner', ...invitableRoles];

/**
 * Invite-by-email plus the pending-invitation list with revoke, for an
 * organization's admins. Deliberately does not say or imply an email was
 * sent: sending mail is out of scope, so the copy tells the admin they still
 * need to reach the person some other way.
 */
export function InviteMemberPanel({
  organizationId,
  callerRole,
}: {
  organizationId: OrganizationId;
  callerRole: Role;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const createInvitation = useMutation(api.invitations.mutations.createInvitation);
  const revokeInvitation = useMutation(api.invitations.mutations.revokeInvitation);
  const invitations = usePaginatedQuery(
    api.invitations.queries.listPendingInvitations,
    { organizationId },
    { initialNumItems: 25 },
  );

  const availableRoles = roleAtLeast(callerRole, 'owner') ? ownerInvitableRoles : invitableRoles;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [inviteError, setInviteError] = useState<ConvexErrorPresentation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revoking, setRevoking] = useState<PendingInvitation | null>(null);
  const [revokeError, setRevokeError] = useState<ConvexErrorPresentation | null>(null);
  // `Date.now()` is an impure call and may not run in the render body
  // directly (React's purity rule) — capturing it once via a `useState` lazy
  // initializer keeps "now" stable across re-renders instead of drifting.
  const [now] = useState(() => Date.now());

  async function submitInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setInviteError(null);
    try {
      await createInvitation({ organizationId, email, role });
      setEmail('');
    } catch (caught: unknown) {
      setInviteError(presentConvexError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmRevoke() {
    if (revoking === null) return;
    setRevokeError(null);
    try {
      await revokeInvitation({ invitationId: revoking._id });
      setRevoking(null);
    } catch (caught: unknown) {
      setRevokeError(presentConvexError(caught));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>{t('invitations.inviteTitle')}</PanelTitle>
            <PanelDescription>{t('invitations.inviteDescription')}</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody>
          <form className="flex flex-wrap items-end gap-4" onSubmit={submitInvite}>
            <Field className="min-w-0 flex-1 basis-64">
              <FieldLabel required>{t('invitations.emailLabel')}</FieldLabel>
              <FieldControl
                type="email"
                required
                placeholder={t('invitations.emailPlaceholder')}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field className="w-full sm:w-48">
              <FieldLabel required>{t('invitations.roleLabel')}</FieldLabel>
              <FieldControl render={<select />} value={role} onChange={(event) => setRole(event.target.value as Role)}>
                {availableRoles.map((option) => (
                  <option key={option} value={option}>
                    {t(roleLabelKey[option])}
                  </option>
                ))}
              </FieldControl>
            </Field>
            <div>
              <Button variant="primary" type="submit" disabled={submitting}>
                {t('invitations.inviteAction')}
              </Button>
            </div>
          </form>
          {inviteError === null ? null : <p className="text-xs text-tone-stop">{t(errorMessageKey(inviteError))}</p>}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>{t('invitations.pendingListTitle')}</PanelTitle>
        </PanelHeader>
        <PanelBodyFlush>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('invitations.pendingEmail')}</TableHeaderCell>
                <TableHeaderCell>{t('invitations.pendingRole')}</TableHeaderCell>
                <TableHeaderCell>{t('invitations.pendingExpires')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            {invitations.status === 'LoadingFirstPage' ? (
              <TableSkeletonRows columns={4} />
            ) : (
              <TableBody>
                {invitations.results.map((invitation) => {
                  const expired = invitation.expiresAt <= now;
                  return (
                    <TableRow key={invitation._id}>
                      <TableRowHeaderCell>{invitation.email}</TableRowHeaderCell>
                      <TableCell>
                        <span className="inline-flex h-6 items-center rounded-pill bg-ground-2 px-2.5 text-micro font-semibold text-ink-2">
                          {t(roleLabelKey[invitation.role])}
                        </span>
                      </TableCell>
                      <TableCell mono>
                        {expired ? (
                          <span className="text-tone-stop">{t('invitations.expiredBadge')}</span>
                        ) : (
                          formatDateTime(locale, invitation.expiresAt)
                        )}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={() => setRevoking(invitation)}>
                          {t('invitations.revoke')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            )}
          </Table>
          {invitations.status === 'Exhausted' && invitations.results.length === 0 ? (
            <EmptyState title={t('invitations.pendingEmpty')} description={t('invitations.pendingEmptyBody')} />
          ) : (
            <TableLoadMore
              status={invitations.status}
              loadedCount={invitations.results.length}
              onLoadMore={invitations.loadMore}
            />
          )}
        </PanelBodyFlush>
      </Panel>

      {revoking === null ? null : (
        <Panel emphasis="focal">
          <PanelHeader>
            <div>
              <PanelTitle>{t('invitations.revokeTitle')}</PanelTitle>
              <PanelDescription>{t('invitations.revokeWarning')}</PanelDescription>
            </div>
          </PanelHeader>
          <PanelBody className="flex-row flex-wrap">
            <Button variant="danger" onClick={confirmRevoke}>
              {t('invitations.revokeConfirm')}
            </Button>
            <Button onClick={() => setRevoking(null)}>{t('common.cancel')}</Button>
          </PanelBody>
          {revokeError === null ? null : (
            <p role="alert" className="px-5 pb-5 text-xs text-tone-stop sm:px-6">
              {t(errorMessageKey(revokeError))}
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
