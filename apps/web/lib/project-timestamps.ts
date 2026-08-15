import { isValidDateInput, isValidTimeInput } from '@/i18n/formats';

export type ProjectTimestampParts = {
  date: string;
  time: string;
};

export type ProjectDateRange = {
  startsAt?: number;
  endsAt?: number;
};

function localParts(date: Date): ProjectTimestampParts {
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
  };
}

/** Builds an absolute millisecond timestamp from explicit local calendar and clock parts. */
export function projectTimestampFromParts(parts: ProjectTimestampParts): number | undefined {
  if (!isValidDateInput(parts.date) || !isValidTimeInput(parts.time)) return undefined;
  const year = Number(parts.date.slice(0, 4));
  const month = Number(parts.date.slice(5, 7));
  const day = Number(parts.date.slice(8, 10));
  const hour = Number(parts.time.slice(0, 2));
  const minute = Number(parts.time.slice(3, 5));
  const date = new Date(year, month - 1, day, hour, minute);
  const timestamp = date.getTime();
  const reconstructed = localParts(date);
  return Number.isFinite(timestamp) && reconstructed.date === parts.date && reconstructed.time === parts.time
    ? timestamp
    : undefined;
}

/** Converts an absolute timestamp into the local form-control values used for editing. */
export function projectTimestampToParts(timestamp: number): ProjectTimestampParts {
  return localParts(new Date(timestamp));
}

/** Validates optional start/end values while preserving intentionally empty endpoints. */
export function projectDateRangeFromParts(
  start: ProjectTimestampParts,
  end: ProjectTimestampParts,
): ProjectDateRange | undefined {
  const startEmpty = start.date === '' && start.time === '';
  const endEmpty = end.date === '' && end.time === '';
  const startsAt = startEmpty ? undefined : projectTimestampFromParts(start);
  const endsAt = endEmpty ? undefined : projectTimestampFromParts(end);
  if ((!startEmpty && startsAt === undefined) || (!endEmpty && endsAt === undefined)) return undefined;
  if (startsAt !== undefined && endsAt !== undefined && endsAt < startsAt) return undefined;
  return {
    ...(startsAt === undefined ? {} : { startsAt }),
    ...(endsAt === undefined ? {} : { endsAt }),
  };
}
