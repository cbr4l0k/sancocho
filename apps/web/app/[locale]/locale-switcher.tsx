'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { localeCookieName, segmentForCanonicalLocale, type CanonicalLocale } from '@/i18n/locales';

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
    router.replace(`/${segmentForCanonicalLocale(nextLocale)}${pathWithoutLocale}`);
  }

  return (
    <Field>
      <FieldLabel nativeLabel={false} render={<span />}>
        {t('common.language')}
      </FieldLabel>
      <div role="group" aria-label={t('common.language')} className="flex flex-wrap gap-1.5">
        <Button variant="secondary" size="sm" selected={locale === 'es-CO'} aria-pressed={locale === 'es-CO'} onClick={() => selectLocale('es-CO')}>
          {t('common.spanish')}
        </Button>
        <Button variant="secondary" size="sm" selected={locale === 'en-US'} aria-pressed={locale === 'en-US'} onClick={() => selectLocale('en-US')}>
          {t('common.english')}
        </Button>
      </div>
      <FieldDescription>{t('common.languageDescription')}</FieldDescription>
    </Field>
  );
}
