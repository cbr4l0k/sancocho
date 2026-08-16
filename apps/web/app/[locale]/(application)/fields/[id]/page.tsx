import { notFound, redirect } from 'next/navigation';

import { localeHref } from '@/i18n/locale-href';
import { canonicalLocaleForSegment, isLocaleSegment } from '@/i18n/locales';

export default async function FieldDetailPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocaleSegment(locale)) notFound();
  redirect(localeHref(canonicalLocaleForSegment(locale), '/fields'));
}
