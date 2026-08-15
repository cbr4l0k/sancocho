import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';

import { canonicalLocaleForSegment, isLocaleSegment } from '@/i18n/locales';
import { messagesForLocale } from '@/i18n/messages';

type LocaleLayoutProps = Readonly<{ children: ReactNode; params: Promise<{ locale: string }> }>;

export async function generateMetadata({ params }: LocaleLayoutProps): Promise<Metadata> {
  const { locale: segment } = await params;
  const locale = isLocaleSegment(segment) ? canonicalLocaleForSegment(segment) : 'es-CO';
  const messages = messagesForLocale(locale);

  return { title: 'Sancocho', description: messages.auth.signedOut };
}

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const { locale: segment } = await params;
  const locale = isLocaleSegment(segment) ? canonicalLocaleForSegment(segment) : 'es-CO';
  const messages = await getMessages();

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
