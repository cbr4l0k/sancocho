'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { localeHref } from '@/i18n/locale-href';
import { localeCookieName, type CanonicalLocale } from '@/i18n/locales';

/**
 * A segmented control built from the shared primitives.
 *
 * `nativeLabel={false}` on the label: the group's control is two buttons, not a
 * single form element, so a real `<label>` would try to forward its clicks.
 */
export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();

  function selectLocale(nextLocale: CanonicalLocale) {
    document.cookie = `${localeCookieName}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    const pathWithoutLocale = pathname.replace(/^\/(?:es|en)(?=\/|$)/, '');
    router.replace(localeHref(nextLocale, pathWithoutLocale));
  }

  return (
    <div
      role="group"
      aria-label={t('common.language')}
      className="flex rounded-pill bg-ground-1 p-1"
    >
      <Button
        variant="ghost"
        size="sm"
        selected={locale === 'es-CO'}
        aria-label={t('common.spanish')}
        aria-pressed={locale === 'es-CO'}
        onClick={() => selectLocale('es-CO')}
      >
        ES
      </Button>
      <Button
        variant="ghost"
        size="sm"
        selected={locale === 'en-US'}
        aria-label={t('common.english')}
        aria-pressed={locale === 'en-US'}
        onClick={() => selectLocale('en-US')}
      >
        EN
      </Button>
    </div>
  );
}
