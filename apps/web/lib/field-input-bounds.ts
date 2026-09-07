import type { fieldConfigValidator } from '@priamo/convex/validators';

import { timestampToParts } from '@/lib/timestamps';

type FieldConfig = typeof fieldConfigValidator.type;

/**
 * The native input attributes a field's configuration already implies.
 *
 * `serviceFieldProblem` has always known these rules and reported a violation
 * after the fact; nothing was telling the CONTROL about them, so a field
 * configured to accept 1–8 passengers offered an unbounded number spinner and a
 * date field with a range offered the whole calendar. These are affordances
 * only — the service kind snapshot is enforced by `fields/values.ts` server-side, and
 * a browser that ignores them changes nothing.
 */
export type FieldInputBounds = {
  min?: string | number;
  max?: string | number;
  step?: number;
  maxLength?: number;
};

export function fieldInputBounds(config: FieldConfig): FieldInputBounds {
  switch (config.kind) {
    case 'number':
      return {
        ...(config.min === undefined ? {} : { min: config.min }),
        ...(config.max === undefined ? {} : { max: config.max }),
        // Integer-only fields step whole numbers so the spinner cannot produce
        // a value the snapshot would reject.
        ...(config.integer === true ? { step: 1 } : {}),
      };
    case 'date':
    case 'time':
      return {
        ...(config.min === undefined ? {} : { min: config.min }),
        ...(config.max === undefined ? {} : { max: config.max }),
      };
    case 'text':
    case 'longText':
      return config.maxLength === undefined ? {} : { maxLength: config.maxLength };
    default:
      // `datetime` bounds are timestamps and belong to the date half of the
      // pair — see `datetimeDateBounds`. The rest constrain by their options,
      // which the control already renders exhaustively.
      return {};
  }
}

/**
 * The `<input type="date">` bounds of a `datetime` field's configured range.
 *
 * Same day-granularity caveat as the project window: the boundary days stay
 * selectable and `serviceFieldProblem` is what refuses the hours inside them.
 */
export function datetimeDateBounds(config: FieldConfig): { min?: string; max?: string } {
  if (config.kind !== 'datetime') return {};
  return {
    ...(config.min === undefined ? {} : { min: timestampToParts(config.min).date }),
    ...(config.max === undefined ? {} : { max: timestampToParts(config.max).date }),
  };
}
