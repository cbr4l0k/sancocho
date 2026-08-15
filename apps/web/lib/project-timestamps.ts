import { timestampFromParts, timestampToParts } from './timestamps';

export type ProjectTimestampParts = {
  date: string;
  time: string;
};

export type ProjectDateRange = {
  startsAt?: number;
  endsAt?: number;
};

/** Builds an absolute millisecond timestamp from explicit local calendar and clock parts. */
export function projectTimestampFromParts(parts: ProjectTimestampParts): number | undefined {
  return timestampFromParts(parts);
}

/** Converts an absolute timestamp into the local form-control values used for editing. */
export function projectTimestampToParts(timestamp: number): ProjectTimestampParts {
  return timestampToParts(timestamp);
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
