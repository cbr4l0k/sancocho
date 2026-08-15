'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect } from 'react';

import { localeCookieName, segmentForCanonicalLocale, type CanonicalLocale } from '@/i18n/locales';

export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations('common');
  const router = useRouter();

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  function selectLocale(nextLocale: CanonicalLocale) {
    document.cookie = `${localeCookieName}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.replace(`/${segmentForCanonicalLocale(nextLocale)}`);
  }

  return (
    <fieldset>
      <legend>{t('language')}</legend>
      <button type="button" aria-pressed={locale === 'es-CO'} onClick={() => selectLocale('es-CO')}>
        {t('spanish')}
      </button>
      <button type="button" aria-pressed={locale === 'en-US'} onClick={() => selectLocale('en-US')}>
        {t('english')}
      </button>
    </fieldset>
  );
}
