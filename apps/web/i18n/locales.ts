/**
 * This is the only mapping between short URL segments and canonical locales.
 * URLs use `/es` and `/en` so they stay readable and a future regional variant
 * can add a segment without changing existing links. Intl and the locale cookie
 * always receive the canonical `es-CO` or `en-US` identifier.
 */
export const localeSegments = {
  es: 'es-CO',
  en: 'en-US',
} as const;

export type LocaleSegment = keyof typeof localeSegments;
export type CanonicalLocale = (typeof localeSegments)[LocaleSegment];

export const defaultLocale: CanonicalLocale = 'es-CO';
export const localeCookieName = 'priamo_locale';

export function isLocaleSegment(value: string): value is LocaleSegment {
  return Object.hasOwn(localeSegments, value);
}

export function isCanonicalLocale(value: string): value is CanonicalLocale {
  return value === 'es-CO' || value === 'en-US';
}

export function canonicalLocaleForSegment(segment: LocaleSegment): CanonicalLocale {
  return localeSegments[segment];
}

export function segmentForCanonicalLocale(locale: CanonicalLocale): LocaleSegment {
  return locale === 'es-CO' ? 'es' : 'en';
}

export function canonicalLocaleFromAcceptLanguage(header: string | null): CanonicalLocale {
  if (header === null) return defaultLocale;

  const requestedLanguages = header
    .split(',')
    .map((entry, index) => {
      const [language = '', ...parameters] = entry.trim().toLowerCase().split(';');
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith('q='));
      const quality = qualityParameter === undefined ? 1 : Number(qualityParameter.trim().slice(2));
      return { language, quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const { language, quality } of requestedLanguages) {
    if (quality <= 0) continue;
    if (language === 'es-co' || language.startsWith('es-') || language === 'es') return 'es-CO';
    if (language === 'en-us' || language.startsWith('en-') || language === 'en') return 'en-US';
  }

  return defaultLocale;
}
