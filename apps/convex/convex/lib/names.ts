import { invalidInput } from './errors';

/** Shared upper bound for user-supplied display names across domains. */
export const maxEntityNameLength = 200;

/**
 * One statement of the display-name rule: trimmed, non-empty, and bounded.
 * `label` names the entity in the rejection message ("Invalid project name");
 * it is developer-supplied, never caller input, so it discloses nothing (I9).
 *
 * Returns the trimmed name, which is what callers MUST store: validating a
 * trimmed value and then persisting the raw one let `'  '`-padded names through
 * a rule they were never actually held to (a 200-character name with leading
 * spaces passed the bound, then exceeded it in the database).
 */
export function validateEntityName(name: string, label: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > maxEntityNameLength) {
    return invalidInput('entityNameInvalid', `Invalid ${label} name`);
  }
  return trimmed;
}
