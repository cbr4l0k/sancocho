'use client';

import { useMutation, usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';

import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError, type ConvexErrorPresentation } from '@/lib/convex-errors';
import { roleLabelKey } from '@/lib/roles';

import { useCurrentOrganization } from './current-organization';

type PendingInvitationEntry = FunctionReturnType<typeof api.invitations.queries.listMyPendingInvitations>['page'][number];

/**
 * Every invitation addressed to the signed-in caller's own verified email —
 * this is the accept surface the issue calls for, mounted where it is always
 * reachable regardless of whether the caller has zero organizations (the
 * create-organization screen) or already belongs to others (the ordinary
 * shell). No email was ever sent for any of these; this panel IS how the
 * recipient finds out.
 */
export function PendingInvitationsPanel() {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const invitations = usePaginatedQuery(api.invitations.queries.listMyPendingInvitations, {}, { initialNumItems: 10 });
  const acceptInvitation = useMutation(api.invitations.mutations.acceptInvitation);
  const { selectCreatedOrganization } = useCurrentOrganization();
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [error, setError] = useState<ConvexErrorPresentation | null>(null);
  // `Date.now()` is an impure call and may not run in the render body
  // directly (React's purity rule) — capturing it once via a `useState` lazy
  // initializer keeps "now" stable across re-renders instead of drifting.
  const [now] = useState(() => Date.now());

  if (invitations.status === 'LoadingFirstPage' || invitations.results.length === 0) {
    return null;
  }

  async function accept(entry: PendingInvitationEntry) {
    setAcceptingId(entry.invitation._id);
    setError(null);
    try {
      await acceptInvitation({ invitationId: entry.invitation._id });
      selectCreatedOrganization(entry.organization._id);
    } catch (caught: unknown) {
      setError(presentConvexError(caught));
    } finally {
      setAcceptingId(null);
    }
  }

  return (
    <Panel emphasis="module" className="mb-6">
      <PanelHeader>
        <div>
          <PanelTitle>{t('invitations.myPendingTitle')}</PanelTitle>
          <PanelDescription>{t('invitations.myPendingDescription')}</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="gap-3">
        {invitations.results.map((entry) => {
          const { invitation, organization } = entry;
          const expired = invitation.expiresAt <= now;
          return (
            <div
              key={invitation._id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-input border border-line bg-ground-2 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm font-semibold text-ink">{organization.name}</p>
                <p className="text-xs text-ink-3">
                  {t('invitations.invitedAs')} {t(roleLabelKey[invitation.role])}
                </p>
                {expired ? null : (
                  <p className="text-xs text-ink-3">
                    {t('invitations.pendingExpires')} {formatDateTime(locale, invitation.expiresAt)}
                  </p>
                )}
              </div>
              {expired ? (
                <span className="inline-flex h-6 shrink-0 items-center rounded-pill bg-ground-3 px-2.5 text-micro font-semibold text-tone-stop">
                  {t('invitations.expiredBadge')}
                </span>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  className="shrink-0"
                  disabled={acceptingId === invitation._id}
                  onClick={() => accept(entry)}
                >
                  {t('invitations.accept')}
                </Button>
              )}
            </div>
          );
        })}
        {invitations.status === 'CanLoadMore' ? (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => invitations.loadMore(10)}>
            {t('table.loadMore')}
          </Button>
        ) : null}
        {error === null ? null : <p className="text-xs text-tone-stop">{t(errorMessageKey(error))}</p>}
      </PanelBody>
    </Panel>
  );
}
