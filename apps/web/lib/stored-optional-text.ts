/** Displays blank stored text as absent, including legacy whitespace-only values. */
export function storedOptionalText(value: string | null | undefined, notSet: string): string {
  return value === null || value === undefined || value.trim() === '' ? notSet : value;
}

/**
 * Omits a blank create/previously-absent value, but sends `''` when clearing an
 * existing value. These mutations accept `v.optional(v.string())` without a
 * `null` clearing arm, so clearing stores `''` rather than removing the column.
 */
export function optionalTextMutationValue(value: string, previous: string | undefined): string | undefined {
  if (value.trim() !== '') return value;
  return previous === undefined ? undefined : '';
}
