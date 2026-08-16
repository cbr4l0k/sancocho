'use client';

import Link from 'next/link';
import { useCallback, type ComponentProps } from 'react';

import { localeHref } from './locale-href';
import { useCanonicalLocale } from './use-canonical-locale';

type LocaleLinkProps = Omit<ComponentProps<typeof Link>, 'href'> & {
  to: string;
};

export function useLocaleHref(): (path: string) => string {
  const locale = useCanonicalLocale();

  return useCallback((path: string) => localeHref(locale, path), [locale]);
}

export function LocaleLink({ to, ...props }: LocaleLinkProps) {
  const href = useLocaleHref();

  return <Link href={href(to)} {...props} />;
}
