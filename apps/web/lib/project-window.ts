import { timestampToParts } from '@/lib/timestamps';

/**
 * The client half of the project-window rule enforced by
 * the Service and Event `validate*WithinProjectWindow` backend rules.
 *
 * A project declares the span its Events and Services live inside — a festival
 * runs the 15th to the 19th — and a child outside it is almost always a typo,
 * not a plan. This is an AFFORDANCE, never authorization: it exists so the form can
 * bound its date pickers and name the problem before a round trip. The backend
 * remains the only thing that decides, and it rejects the same cases with
 * `serviceBeforeProjectWindow` / `serviceAfterProjectWindow` or
 * `eventBeforeProjectWindow` / `eventAfterProjectWindow`.
 *
 * Both ends are optional, and a project with no dates constrains nothing.
 */
export type ProjectWindow = { startsAt?: number | undefined; endsAt?: number | undefined };

/** Which end of the window a Service or Event falls outside of, if either. */
export function projectWindowProblem(
  window: ProjectWindow,
  startsAt: number,
  endsAt: number | undefined,
): 'before' | 'after' | undefined {
  if (window.startsAt !== undefined && startsAt < window.startsAt) return 'before';
  // The service's last instant is its end when it has one, otherwise its start
  // — which is what lets an open-ended service be checked by the same rule.
  if (window.endsAt !== undefined && (endsAt ?? startsAt) > window.endsAt) return 'after';
  return undefined;
}

/**
 * `min`/`max` for an `<input type="date">` covering the window's calendar days.
 *
 * Day granularity is deliberately looser than the rule above: the first and
 * last day of the window must stay selectable even though part of each day is
 * outside it, so the picker narrows the choice and `projectWindowProblem`
 * catches the hours the picker cannot express.
 */
export function projectWindowDateBounds(window: ProjectWindow): { min?: string; max?: string } {
  return {
    ...(window.startsAt === undefined ? {} : { min: timestampToParts(window.startsAt).date }),
    ...(window.endsAt === undefined ? {} : { max: timestampToParts(window.endsAt).date }),
  };
}
