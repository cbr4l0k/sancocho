import type { EventFieldValue } from './field-value-form';

export type EventFieldValueChange<FieldDefinitionId> = {
  fieldDefinitionId: FieldDefinitionId;
  value: EventFieldValue | null;
};

export function sameEventFieldValue(left: EventFieldValue | undefined, right: EventFieldValue | undefined): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) return left === right;
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
      return (
        right.kind === 'multiSelect' &&
        left.optionIds.length === right.optionIds.length &&
        left.optionIds.every((id, index) => id === right.optionIds[index])
      );
    case 'location':
      return right.kind === 'location' && left.locationId === right.locationId;
  }
}

/**
 * Omitting a field preserves it. Only a value that differs from the loaded
 * event is submitted; clearing an existing value is represented by null.
 */
export function changedEventFieldValues<FieldDefinitionId>(
  original: ReadonlyMap<FieldDefinitionId, EventFieldValue>,
  edited: ReadonlyMap<FieldDefinitionId, EventFieldValue | undefined>,
): EventFieldValueChange<FieldDefinitionId>[] {
  return changedValues(original, edited, sameEventFieldValue);
}

export function changedValues<FieldDefinitionId, Value>(
  original: ReadonlyMap<FieldDefinitionId, Value>,
  edited: ReadonlyMap<FieldDefinitionId, Value | undefined>,
  sameValue: (left: Value | undefined, right: Value | undefined) => boolean,
): { fieldDefinitionId: FieldDefinitionId; value: Value | null }[] {
  const changes: { fieldDefinitionId: FieldDefinitionId; value: Value | null }[] = [];
  for (const [fieldDefinitionId, editedValue] of edited) {
    const originalValue = original.get(fieldDefinitionId);
    if (sameValue(originalValue, editedValue)) continue;
    if (editedValue === undefined && originalValue === undefined) continue;
    changes.push({ fieldDefinitionId, value: editedValue ?? null });
  }
  return changes;
}
