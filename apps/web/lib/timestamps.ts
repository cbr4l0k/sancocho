import { isValidDateInput, isValidTimeInput } from '@/i18n/formats';

export type TimestampParts = { date: string; time: string };

function localParts(date: Date): TimestampParts {
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
  };
}

/** Builds a local wall-clock selection into an absolute ms value, rejecting DST-normalized times. */
export function timestampFromParts(parts: TimestampParts): number | undefined {
  if (!isValidDateInput(parts.date) || !isValidTimeInput(parts.time)) return undefined;
  const date = new Date(
    Number(parts.date.slice(0, 4)),
    Number(parts.date.slice(5, 7)) - 1,
    Number(parts.date.slice(8, 10)),
    Number(parts.time.slice(0, 2)),
    Number(parts.time.slice(3, 5)),
  );
  const timestamp = date.getTime();
  const reconstructed = localParts(date);
  return Number.isFinite(timestamp) && reconstructed.date === parts.date && reconstructed.time === parts.time
    ? timestamp
    : undefined;
}

export function timestampToParts(timestamp: number): TimestampParts {
  return localParts(new Date(timestamp));
}
