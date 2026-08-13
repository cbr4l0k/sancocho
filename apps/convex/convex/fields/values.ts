import { invalidInput } from '../lib/errors';
import {
  isFiniteNumber,
  isValidDateString,
  isValidTimeString,
  type eventFieldValueValidator,
  type fieldConfigValidator,
} from '../validators';

type FieldConfig = typeof fieldConfigValidator.type;
type FieldValue = typeof eventFieldValueValidator.type;

/**
 * The single statement of "does this typed value satisfy this field config?".
 *
 * The config passed in is always the rule set that owns the value: the
 * immutable `recipeFields` snapshot, never the live `fieldDefinitions` row — so
 * a value stays interpretable under exactly the rules it was written against
 * (I3). Recipe publishing uses it for `recipeFields.defaultValue`; issue #10's
 * event validation gate reuses it unchanged for `eventFieldValues.value`, so
 * a default and a stored value can never be held to different rules.
 *
 * Deliberate split of responsibility: this helper is pure (config + value, no
 * `ctx`) and therefore validates *shape and rules only*. The `location` branch
 * checks only that the discriminators agree — proving the referenced location
 * exists, belongs to the same organization, and is not archived requires a
 * database read and stays with the caller, which owns the tenant context and
 * must fail with the generic not-found error (I1/I9).
 */
export function validateFieldValueAgainstConfig(config: FieldConfig, value: FieldValue): void {
  switch (value.kind) {
    case 'boolean':
      if (config.kind !== 'boolean') return kindMismatch();
      return;
    case 'location':
      // Existence, tenant ownership, and archival are caller-side (see doc comment).
      if (config.kind !== 'location') return kindMismatch();
      return;
    case 'text':
      if (config.kind !== 'text') return kindMismatch();
      return assertLength(value.value, config.minLength, config.maxLength);
    case 'longText':
      if (config.kind !== 'longText') return kindMismatch();
      return assertLength(value.value, config.minLength, config.maxLength);
    case 'number':
      if (config.kind !== 'number') return kindMismatch();
      // Convex accepts NaN/Infinity in v.number(); an unorderable value would
      // silently pass every bound comparison below.
      if (!isFiniteNumber(value.value)) return invalidInput('Field value must be a finite number');
      if (config.integer === true && !Number.isInteger(value.value)) return invalidInput('Field value must be an integer');
      return assertNumericBounds(value.value, config.min, config.max);
    case 'datetime':
      if (config.kind !== 'datetime') return kindMismatch();
      if (!isFiniteNumber(value.value)) return invalidInput('Field value must be a finite number');
      return assertNumericBounds(value.value, config.min, config.max);
    case 'date':
      if (config.kind !== 'date') return kindMismatch();
      if (!isValidDateString(value.value)) return invalidInput('Field value must be a YYYY-MM-DD calendar date');
      // Zero-padded ISO dates order correctly under lexicographic comparison.
      return assertOrderedBounds(value.value, config.min, config.max);
    case 'time':
      if (config.kind !== 'time') return kindMismatch();
      if (!isValidTimeString(value.value)) return invalidInput('Field value must be an HH:mm wall-clock time');
      // Zero-padded HH:mm orders correctly under lexicographic comparison.
      return assertOrderedBounds(value.value, config.min, config.max);
    case 'select':
      if (config.kind !== 'select') return kindMismatch();
      if (!config.options.some((option) => option.id === value.optionId)) return unknownOption();
      return;
    case 'multiSelect': {
      if (config.kind !== 'multiSelect') return kindMismatch();
      const selected = new Set(value.optionIds);
      // A repeated id would inflate the selection count against the bounds.
      if (selected.size !== value.optionIds.length) return invalidInput('Field value must not repeat select options');
      if (value.optionIds.some((optionId) => !config.options.some((option) => option.id === optionId))) return unknownOption();
      if (config.minSelections !== undefined && value.optionIds.length < config.minSelections) {
        return invalidInput('Field value selects fewer options than the field configuration allows');
      }
      if (config.maxSelections !== undefined && value.optionIds.length > config.maxSelections) {
        return invalidInput('Field value selects more options than the field configuration allows');
      }
      return;
    }
  }
}

function kindMismatch(): never {
  return invalidInput('Field value kind must match its field configuration');
}

function unknownOption(): never {
  return invalidInput('Field value must reference an option defined by the field configuration');
}

function assertLength(value: string, minLength: number | undefined, maxLength: number | undefined): void {
  if (minLength !== undefined && value.length < minLength) return invalidInput('Field value is shorter than the configured minimum length');
  if (maxLength !== undefined && value.length > maxLength) return invalidInput('Field value is longer than the configured maximum length');
}

function assertNumericBounds(value: number, min: number | undefined, max: number | undefined): void {
  if (min !== undefined && value < min) return belowMinimum();
  if (max !== undefined && value > max) return aboveMaximum();
}

function assertOrderedBounds(value: string, min: string | undefined, max: string | undefined): void {
  if (min !== undefined && value < min) return belowMinimum();
  if (max !== undefined && value > max) return aboveMaximum();
}

function belowMinimum(): never {
  return invalidInput('Field value is below the configured minimum');
}

function aboveMaximum(): never {
  return invalidInput('Field value is above the configured maximum');
}
