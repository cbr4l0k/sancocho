import type { CanonicalLocale } from '../locales';
import enUS from './en-US';
import esCO from './es-CO';

export { enUS, esCO };

export function messagesForLocale(locale: CanonicalLocale) {
  return locale === 'es-CO' ? esCO : enUS;
}
