export type DispatchDay = { from: number; to: number; key: string };
export type DispatchDayPath = '/dispatch' | '/portal/dispatch';

const dispatchDayKeyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function keyFor(year: number, monthIndex: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fromLocalParts(year: number, monthIndex: number, day: number): DispatchDay {
  const start = new Date(year, monthIndex, day);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return {
    from: start.getTime(),
    to: end.getTime(),
    key: keyFor(start.getFullYear(), start.getMonth(), start.getDate()),
  };
}

/** The viewer's local calendar day as the backend's half-open [from, to) window. */
export function dispatchDayFor(date: Date): DispatchDay {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid dispatch day date');
  return fromLocalParts(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Resolves a shared URL key, falling back to the viewer's current local day. */
export function browserDispatchDay(key: string | undefined, now: Date): DispatchDay {
  if (key === undefined) return dispatchDayFor(now);
  try {
    return dispatchDayFromKey(key);
  } catch {
    return dispatchDayFor(now);
  }
}

/** Calendar arithmetic deliberately avoids adding 24 hours across DST changes. */
export function shiftDispatchDay(day: DispatchDay, deltaDays: number): DispatchDay {
  if (!Number.isInteger(deltaDays)) throw new RangeError('Dispatch day shift must be an integer');
  const start = new Date(day.from);
  return fromLocalParts(start.getFullYear(), start.getMonth(), start.getDate() + deltaDays);
}

export function dispatchDayNavigation(day: DispatchDay, path: DispatchDayPath): {
  previous: { day: DispatchDay; href: string };
  next: { day: DispatchDay; href: string };
} {
  const previous = shiftDispatchDay(day, -1);
  const next = shiftDispatchDay(day, 1);
  return {
    previous: { day: previous, href: `${path}?day=${previous.key}` },
    next: { day: next, href: `${path}?day=${next.key}` },
  };
}

/** Parses a strict YYYY-MM-DD URL key into the viewer's local calendar day. */
export function dispatchDayFromKey(key: string): DispatchDay {
  const match = dispatchDayKeyPattern.exec(key);
  if (match === null) throw new RangeError('Invalid dispatch day key');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(year, monthIndex, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== monthIndex ||
    parsed.getDate() !== day
  ) throw new RangeError('Invalid dispatch day key');
  return fromLocalParts(year, monthIndex, day);
}
