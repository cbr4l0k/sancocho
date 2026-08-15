import { getRequestConfig } from 'next-intl/server';

import { canonicalLocaleForSegment, defaultLocale, isLocaleSegment } from './locales';
import { messagesForLocale } from './messages';

export default getRequestConfig(async ({ requestLocale }) => {
  const segment = await requestLocale;
  const locale = segment !== undefined && isLocaleSegment(segment) ? canonicalLocaleForSegment(segment) : defaultLocale;

  return { locale, messages: messagesForLocale(locale) };
});
