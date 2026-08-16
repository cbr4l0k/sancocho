import { segmentForCanonicalLocale, type CanonicalLocale } from './locales';

/** Builds an app path from a locale-less path, inserting the correct URL segment. */
export function localeHref(locale: CanonicalLocale, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `/${segmentForCanonicalLocale(locale)}${normalizedPath}`;
}
