import type { CanonicalLocale } from './locales';

function dateParts(value: string): { year: number; month: number; day: number } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const candidate = new Date(year, month - 1, day);
  return candidate.getFullYear() === year && candidate.getMonth() === month - 1 && candidate.getDate() === day ? { year, month, day } : undefined;
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

export function formatDateTime(locale: CanonicalLocale, milliseconds: number): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(milliseconds));
}

export function formatNumber(locale: CanonicalLocale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}
