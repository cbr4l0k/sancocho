import type { Id } from '../_generated/dataModel';
import { invalidInput } from '../lib/errors';
import {
  isFiniteNumber,
  isValidDateString,
  isValidTimeString,
  type serviceFieldValueValidator,
  type fieldConfigValidator,
} from '../validators';

type FieldConfig = typeof fieldConfigValidator.type;
type FieldValue = typeof serviceFieldValueValidator.type;

/**
 * Absolute ceilings on stored string values, independent of what any snapshot
 * says.
 *
 * A snapshot's own `maxLength` is optional — the seeded `notes` built-in ships
 * with none — so without these a single Service value could be megabytes. That
 * matters because of an asymmetry: `updateServiceFields` writes one row per field,
 * so writes stay small, but `getService` `.collect()`s every value of an service at
 * once. The I6 argument for that collect bounds the ROW COUNT
 * (`maxFieldsPerVersion`), not the bytes — so a handful of huge values makes an
 * Service permanently unreadable while still being writable, and Services are never
 * deleted.
 *
 * They are enforced in two places on purpose:
 * - `validateFieldValueAgainstConfig` applies them to every value, which is what
 *   protects values written against snapshots (including already-published,
 *   immutable ones) that declare no `maxLength` at all;
 * - `assertValidFieldConfig` refuses a config that promises MORE than the cap,
 *   so no snapshot can ever advertise a bound the value gate would not honour.
 *
 * Sizes: `text` is a single-line value (2000, matching the description caps);
 * `longText` is a notes field (10000 ~ 10KB, so even a full 200-field service
 * stays inside a single transaction's read budget).
 */
export const maxTextValueLength = 2000;
export const maxLongTextValueLength = 10000;

/**
 * The single derivation of a stored location-mirror column from a typed value.
 *
 * Two tables denormalize the location a value points at so that locations can
 * be checked for references through an index instead of a table scan:
 * `serviceKindFields.defaultLocationId` (configuration defaults) and
 * `serviceFieldValues.locationId` (operational data). Both are server-derived
 * from the value beside them and are never client-supplied (I4).
 *
 * EVERY write path that stores or clears one of those value columns must set
 * the mirror from this helper in the same patch — including clears, where it
 * returns `undefined` and the mirror must be removed. A path that forgets it
 * leaves a location deletable while a row still references it, which for an
 * immutable published version means a permanently unusable version (I2/I3).
 * Issue #10's service-value writes consume this helper for the second mirror.
 */
export function locationIdFromValue(value: FieldValue | null | undefined): Id<'locations'> | undefined {
  return value?.kind === 'location' ? value.locationId : undefined;
}

/**
 * Structural equality over the value union, mirroring `sameFieldConfig`.
 * `JSON.stringify` was key-order sensitive, so an identical value whose
 * properties happened to arrive in a different order read as a change — a
 * spurious patch and audit row on what is really a no-op write.
 *
 * `null` and `undefined` both mean "no value", so clearing an absent one is a
 * no-op. Two callers share it, and they must agree: `serviceKindFields.defaultValue`
 * (is this default actually different?) and `serviceFieldValues.value` (is this
 * submitted value actually a change worth auditing?). A looser comparison in
 * either place produces audit rows describing edits that never happened.
 */
export function sameFieldValue(left: FieldValue | undefined | null, right: FieldValue | undefined | null): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  switch (left.kind) {
    case 'text':
      return right.kind === 'text' && left.value === right.value;
    case 'longText':
      return right.kind === 'longText' && left.value === right.value;
    case 'number':
      return right.kind === 'number' && left.value === right.value;
    case 'boolean':
      return right.kind === 'boolean' && left.value === right.value;
    case 'date':
      return right.kind === 'date' && left.value === right.value;
    case 'datetime':
      return right.kind === 'datetime' && left.value === right.value;
    case 'time':
      return right.kind === 'time' && left.value === right.value;
    case 'select':
      return right.kind === 'select' && left.optionId === right.optionId;
    case 'multiSelect':
      // Compared positionally: the stored array is written back verbatim, so a
      // reordered selection is a real change to the stored value.
      return right.kind === 'multiSelect' && left.optionIds.length === right.optionIds.length && left.optionIds.every((optionId, index) => optionId === right.optionIds[index]);
    case 'location':
      return right.kind === 'location' && left.locationId === right.locationId;
  }
}

/**
 * The single statement of "does this typed value satisfy this field config?".
 *
 * The config passed in is always the rule set that owns the value: the
 * immutable `serviceKindFields` snapshot, never the live `fieldDefinitions` row — so
 * a value stays interpretable under exactly the rules it was written against
 * (I3). ServiceKind publishing uses it for `serviceKindFields.defaultValue`; issue #10's
 * service validation gate reuses it unchanged for `serviceFieldValues.value`, so
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
      return assertLength(value.value, config.minLength, config.maxLength, maxTextValueLength);
    case 'longText':
      if (config.kind !== 'longText') return kindMismatch();
      return assertLength(value.value, config.minLength, config.maxLength, maxLongTextValueLength);
    case 'number':
      if (config.kind !== 'number') return kindMismatch();
      // Convex accepts NaN/Infinity in v.number(); an unorderable value would
      // silently pass every bound comparison below.
      if (!isFiniteNumber(value.value)) return invalidInput('fieldValueInvalid', 'Field value must be a finite number');
      if (config.integer === true && !Number.isInteger(value.value)) return invalidInput('fieldValueInvalid', 'Field value must be an integer');
      return assertNumericBounds(value.value, config.min, config.max);
    case 'datetime':
      if (config.kind !== 'datetime') return kindMismatch();
      if (!isFiniteNumber(value.value)) return invalidInput('fieldValueInvalid', 'Field value must be a finite number');
      return assertNumericBounds(value.value, config.min, config.max);
    case 'date':
      if (config.kind !== 'date') return kindMismatch();
      if (!isValidDateString(value.value)) return invalidInput('fieldValueInvalid', 'Field value must be a YYYY-MM-DD calendar date');
      // Zero-padded ISO dates order correctly under lexicographic comparison.
      return assertOrderedBounds(value.value, config.min, config.max);
    case 'time':
      if (config.kind !== 'time') return kindMismatch();
      if (!isValidTimeString(value.value)) return invalidInput('fieldValueInvalid', 'Field value must be an HH:mm wall-clock time');
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
      if (selected.size !== value.optionIds.length) return invalidInput('fieldValueOptionInvalid', 'Field value must not repeat select options');
      if (value.optionIds.some((optionId) => !config.options.some((option) => option.id === optionId))) return unknownOption();
      if (config.minSelections !== undefined && value.optionIds.length < config.minSelections) {
        return invalidInput('fieldValueRangeInvalid', 'Field value selects fewer options than the field configuration allows');
      }
      if (config.maxSelections !== undefined && value.optionIds.length > config.maxSelections) {
        return invalidInput('fieldValueRangeInvalid', 'Field value selects more options than the field configuration allows');
      }
      return;
    }
  }
}

function kindMismatch(): never {
  return invalidInput('fieldValueKindMismatch', 'Field value kind must match its field configuration');
}

function unknownOption(): never {
  return invalidInput('fieldValueOptionInvalid', 'Field value must reference an option defined by the field configuration');
}

function assertLength(value: string, minLength: number | undefined, maxLength: number | undefined, absoluteMaximum: number): void {
  if (minLength !== undefined && value.length < minLength) return invalidInput('fieldValueLengthInvalid', 'Field value is shorter than the configured minimum length');
  if (maxLength !== undefined && value.length > maxLength) return invalidInput('fieldValueLengthInvalid', 'Field value is longer than the configured maximum length');
  // The configured bound is optional; this one is not (see the caps above).
  if (value.length > absoluteMaximum) return invalidInput('fieldValueLengthInvalid', `Field value must not exceed ${absoluteMaximum} characters`);
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
  return invalidInput('fieldValueRangeInvalid', 'Field value is below the configured minimum');
}

function aboveMaximum(): never {
  return invalidInput('fieldValueRangeInvalid', 'Field value is above the configured maximum');
}
