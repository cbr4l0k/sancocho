import type { CanonicalLocale } from './locales';

function dateParts(value: string): { year: number; month: number; day: number } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return undefined;
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0) ? { year, month, day } : undefined;
}

export function isValidDateInput(value: string): boolean {
  return dateParts(value) !== undefined;
}

export function isValidTimeInput(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function parseDateForStorage(value: string): string | undefined {
  return isValidDateInput(value) ? value : undefined;
}

export function parseTimeForStorage(value: string): string | undefined {
  return isValidTimeInput(value) ? value : undefined;
}

export function formatDate(locale: CanonicalLocale, value: string): string {
  const parts = dateParts(value);
  if (parts === undefined) return value;
  // A bare ISO date is UTC midnight; construct a local Date so Colombia never displays the prior day.
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(parts.year, parts.month - 1, parts.day));
}

export function formatTime(locale: CanonicalLocale, value: string): string {
  if (!isValidTimeInput(value)) return value;
  const [hourText, minuteText] = value.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  return new Intl.DateTimeFormat(locale, { hour: locale === 'es-CO' ? '2-digit' : 'numeric', minute: '2-digit', hour12: locale === 'en-US' }).format(new Date(2000, 0, 1, hour, minute));
}

/**
 * Formats an absolute timestamp in the supplied IANA time zone. Without one,
 * the browser zone is used and labelled; an organization-zone model does not exist yet.
 */
export function formatDateTime(locale: CanonicalLocale, milliseconds: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(milliseconds));
}

export function formatNumber(locale: CanonicalLocale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}
