import type esCO from './messages/es-CO';
import type { TranslationShape } from './messages/schema';
import type { CanonicalLocale } from './locales';

declare module 'next-intl' {
  interface AppConfig {
    Locale: CanonicalLocale;
    Messages: TranslationShape<typeof esCO>;
  }
}
