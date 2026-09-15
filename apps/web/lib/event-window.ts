import { formatDateTime } from '@/i18n/formats';
import type { CanonicalLocale } from '@/i18n/locales';

export type EventWindowProblem = 'endBeforeStart';

export function eventWindowProblem(startsAt: number, endsAt: number | undefined): EventWindowProblem | undefined {
  return endsAt !== undefined && endsAt < startsAt ? 'endBeforeStart' : undefined;
}

export function formatEventWindow(locale: CanonicalLocale, startsAt: number, endsAt: number | undefined): string {
  const start = formatDateTime(locale, startsAt);
  return endsAt === undefined ? start : `${start} – ${formatDateTime(locale, endsAt)}`;
}
