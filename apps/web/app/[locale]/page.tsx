'use client';

import { Authenticated, AuthLoading, Unauthenticated, useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';

import { api } from '@sancocho/convex/api';

import { LocaleSwitcher } from '@/app/[locale]/locale-switcher';

export default function HomePage() {
  const t = useTranslations('auth');

  return (
    <main>
      <LocaleSwitcher />
      <AuthLoading>
        <p>{t('connecting')}</p>
      </AuthLoading>
      <Unauthenticated>
        <p>{t('signedOut')}</p>
      </Unauthenticated>
      <Authenticated>
        <ConnectionStatus />
      </Authenticated>
    </main>
  );
}

function ConnectionStatus() {
  const t = useTranslations('auth');
  const currentUser = useQuery(api.auth.queries.getCurrentUser);

  if (currentUser === undefined) return <p>{t('connecting')}</p>;
  if (currentUser === null) return <p>{t('profilePending')}</p>;

  return <p>{t('connected')}</p>;
}
