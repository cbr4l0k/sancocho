import { invalidInput } from './errors';

/** Shared upper bound for user-supplied display names across domains. */
export const maxEntityNameLength = 200;

/**
 * One statement of the display-name rule: trimmed, non-empty, and bounded.
 * `label` names the entity in the rejection message ("Invalid project name");
 * it is developer-supplied, never caller input, so it discloses nothing (I9).
 */
export function validateEntityName(name: string, label: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > maxEntityNameLength) {
    return invalidInput(`Invalid ${label} name`);
  }
}
