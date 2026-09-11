'use client';

import { UserButton } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { AuthenticatedOrganizationGate } from '@/components/application/app-shell';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { LocaleSwitcher } from '@/app/[locale]/locale-switcher';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody } from '@/components/ui/panel';
import { LocaleLink } from '@/i18n/locale-link';

export function PortalShell({ children }: { children: ReactNode }) {
  return (
    <AuthenticatedOrganizationGate>
      <PortalFrame>{children}</PortalFrame>
    </AuthenticatedOrganizationGate>
  );
}

function PortalFrame({ children }: { children: ReactNode }) {
  const { currentOrganization, organizations, selectOrganization } = useCurrentOrganization();
  const t = useTranslations('portal');

  return (
    <div className="min-h-dvh bg-ground-0">
      <header className="border-b border-line bg-ground-0">
        <div className="mx-auto flex min-h-20 w-full max-w-[72rem] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
          <LocaleLink
            to="/portal"
            className="flex shrink-0 items-center gap-3 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <span aria-hidden="true" className="size-2.5 rounded-full bg-accent" />
            <span className="flex flex-col">
              <span className="text-lg font-extrabold">{t('application')}</span>
              <span className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{t('standing')}</span>
            </span>
          </LocaleLink>
          <label className="ml-auto flex min-w-52 flex-col gap-1 text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
            {t('actingFirm')}
            <select
              aria-label={t('firmSelectorLabel')}
              className="h-9 rounded-input border border-line bg-ground-1 px-3 text-sm font-semibold normal-case tracking-normal text-ink"
              value={currentOrganization?.organization._id ?? ''}
              onChange={(event) => {
                const selected = organizations.find(({ organization }) => organization._id === event.target.value);
                if (selected !== undefined) selectOrganization(selected);
              }}
            >
              <option value="" disabled>{t('chooseFirm')}</option>
              {organizations.map(({ organization }) => (
                <option key={organization._id} value={organization._id}>{organization.name}</option>
              ))}
            </select>
          </label>
          <div className="flex shrink-0 items-center gap-3">
            <LocaleSwitcher />
            <UserButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[72rem] px-6 py-8 pb-12">
        {currentOrganization === null ? (
          <Panel emphasis="focal">
            <PanelBody>
              <EmptyState title={t('chooseFirm')} description={t('chooseFirmBody')} />
            </PanelBody>
          </Panel>
        ) : children}
      </main>
    </div>
  );
}
