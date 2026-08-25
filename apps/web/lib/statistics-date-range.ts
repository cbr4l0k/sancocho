import { isValidDateInput } from '@/i18n/formats';
import { maxUpcomingWindowDays } from '@/lib/statistics-upcoming-window';

/**
 * Date-range filter logic for the statistics surface.
 *
 * `startsAt`/`endsAt` on the backend filter args are absolute timestamps
 * (ms), but the filter control is two `YYYY-MM-DD` date inputs — there is no
 * organization-timezone model (see `i18n/formats.ts`), so "the selected day"
 * is resolved in the viewer's own local timezone, matching `formatDateTime`'s
 * documented behaviour elsewhere in the console.
 */

function dateParts(value: string): { year: number; month: number; day: number } | undefined {
  if (!isValidDateInput(value)) return undefined;
  return { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) };
}

/** Local midnight at the start of the given calendar day. */
export function startOfLocalDay(value: string): number | undefined {
  const parts = dateParts(value);
  if (parts === undefined) return undefined;
  return new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0).getTime();
}

/** The last millisecond of the given calendar day, local time — an inclusive upper bound. */
export function endOfLocalDay(value: string): number | undefined {
  const parts = dateParts(value);
  if (parts === undefined) return undefined;
  return new Date(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999).getTime();
}

export type DateRangeInput = { from: string; to: string };
export type ResolvedDateRangeFilter = { startsAt: number | undefined; endsAt: number | undefined };

/**
 * `undefined` for a blank or unparsable side lets the caller omit that bound
 * entirely (every filter combination, including a one-sided range, is legal
 * on the backend). `to < from` is reported as invalid rather than silently
 * swapped or dropped, since guessing the operator's intent here is worse than
 * asking them to fix it.
 */
export function resolveDateRangeFilter(input: DateRangeInput): ResolvedDateRangeFilter | 'invalid' {
  const startsAt = input.from.trim() === '' ? undefined : startOfLocalDay(input.from);
  const endsAt = input.to.trim() === '' ? undefined : endOfLocalDay(input.to);
  if (startsAt !== undefined && endsAt !== undefined && endsAt < startsAt) return 'invalid';
  return { startsAt, endsAt };
}

/**
 * The upcoming-services window is independent of the date-range filter (the
 * backend query was deliberately not folded into the filtered-read family —
 * see `docs/statistics.md`), so it gets its own, simpler resolver: "now" plus
 * a bounded number of days, clamped so it can never exceed the server's hard
 * `maxUpcomingWindowMs` cap regardless of what a caller passes in.
 */
export function resolveUpcomingWindow(days: number, now: number): { startsAt: number; endsAt: number } {
  const clampedDays = Math.min(Math.max(1, Math.floor(days)), maxUpcomingWindowDays);
  return { startsAt: now, endsAt: now + clampedDays * 24 * 60 * 60 * 1000 };
}
