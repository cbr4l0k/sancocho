import { redirect } from 'next/navigation';

import { localeHref } from '@/i18n/locale-href';
import { canonicalLocaleForSegment, defaultLocale, isLocaleSegment } from '@/i18n/locales';

/**
 * Fallback for the locale root. `proxy.ts` normally redirects `/{locale}` to the
 * landing view before this renders — a real 307, where a `redirect()` here can
 * only be a soft client-side one because the application layout has already
 * begun streaming its client shell. This exists so the route still resolves to
 * the same place if the proxy ever stops matching, rather than rendering
 * nothing.
 */
export default async function ApplicationIndexPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const canonical = isLocaleSegment(locale) ? canonicalLocaleForSegment(locale) : defaultLocale;
  redirect(localeHref(canonical, '/chat'));
}
