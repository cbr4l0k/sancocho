import { isValidDateInput } from '@/i18n/formats';

export type ExportWindow = { readonly from?: number; readonly to?: number };

/**
 * Local start of a `YYYY-MM-DD` as an absolute ms, matching `lib/timestamps.ts`.
 *
 * The operator means whole days in their own zone, so midnight is the browser's
 * local midnight, never UTC. Building this at UTC midnight would admit the
 * previous local evening in Colombia.
 */
function localDayStart(value: string): number {
  return new Date(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
  ).getTime();
}

/** Last millisecond of that local calendar day. */
function localDayEnd(value: string): number {
  return new Date(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
    23,
    59,
    59,
    999,
  ).getTime();
}

/**
 * Reads the two `YYYY-MM-DD` values the date inputs hold (either may be `''`).
 *
 * An invalid or empty string contributes nothing: the key is absent, not
 * `undefined` (`exactOptionalPropertyTypes` is on).
 */
export function parseExportWindow(fromDate: string, toDate: string): ExportWindow {
  return {
    ...(isValidDateInput(fromDate) ? { from: localDayStart(fromDate) } : {}),
    ...(isValidDateInput(toDate) ? { to: localDayEnd(toDate) } : {}),
  };
}

/** Inclusive at both ends. An empty window admits everything. */
export function withinExportWindow(startsAt: number, window: ExportWindow): boolean {
  return (
    (window.from === undefined || startsAt >= window.from) &&
    (window.to === undefined || startsAt <= window.to)
  );
}
