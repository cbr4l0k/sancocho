import { getRequestConfig } from 'next-intl/server';

import { canonicalLocaleForSegment, defaultLocale, isCanonicalLocale, isLocaleSegment } from './locales';
import { messagesForLocale } from './messages';

/**
 * `requestLocale` arrives as a URL segment (`en`) when next-intl resolved it
 * from the route, and as a canonical locale (`en-US`) when a layout announced
 * it with `setRequestLocale`. Both are accepted; anything else falls back to
 * Spanish, never to English.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale =
    requested === undefined
      ? defaultLocale
      : isLocaleSegment(requested)
        ? canonicalLocaleForSegment(requested)
        : isCanonicalLocale(requested)
          ? requested
          : defaultLocale;

  return { locale, messages: messagesForLocale(locale) };
});
