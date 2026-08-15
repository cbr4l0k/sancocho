import { ClerkProvider } from '@clerk/nextjs';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { ConvexClientProvider } from '@/app/convex-client-provider';
import { chivo, chivoMono } from '@/app/fonts';
import { defaultLocale, isCanonicalLocale } from '@/i18n/locales';
import './globals.css';

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const localeHeader = (await headers()).get('x-sancocho-locale');
  const locale =
    localeHeader !== null && isCanonicalLocale(localeHeader) ? localeHeader : defaultLocale;

  return (
    <ClerkProvider>
      {/*
        No `data-theme` is stamped here on purpose: `:root` carries the dark
        palette, so dark is what everyone gets unless their OS asks for light.
        A future toggle sets `data-theme` and wins over both.
      */}
      <html lang={locale} className={`${chivo.variable} ${chivoMono.variable}`}>
        <body>
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
