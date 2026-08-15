'use client';

import { useLocale } from 'next-intl';

import {
  defaultLocale,
  isCanonicalLocale,
  type CanonicalLocale,
} from './locales';

export function useCanonicalLocale(): CanonicalLocale {
  const requestedLocale = useLocale();

  return isCanonicalLocale(requestedLocale) ? requestedLocale : defaultLocale;
}
