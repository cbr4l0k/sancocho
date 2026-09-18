import type { fieldConfigValidator, serviceFieldValueValidator } from '@priamo/convex/validators';

export type ColumnTarget =
  | { kind: 'ignored' }
  | { kind: 'serviceName' }
  | { kind: 'startsAtDate' }
  | { kind: 'startsAtTime' }
  | { kind: 'endsAtDate' }
  | { kind: 'endsAtTime' }
  | { kind: 'field'; fieldDefinitionId: string }
  | { kind: 'provider' }
  | { kind: 'vehicleClass' }
  | { kind: 'modality' }
  | { kind: 'quantity' }
  | { kind: 'costCentre' }
  | { kind: 'workbookAmount' };

export type WorkbookMapping = readonly ColumnTarget[];

export type VersionField = {
  fieldDefinitionId: string;
  required: boolean;
  config: typeof fieldConfigValidator.type;
  defaultValue?: typeof serviceFieldValueValidator.type;
  defaultLocationId?: string;
};

export type MappingProblem =
  | { kind: 'duplicateTarget'; target: string; columns: readonly number[] }
  | { kind: 'requiredTargetUnmapped'; target: 'serviceName' | 'startsAtDate' | 'startsAtTime' }
  | { kind: 'requiredFieldUnmapped'; fieldDefinitionId: string }
  | { kind: 'timeWithoutDate'; target: 'startsAtTime' | 'endsAtTime' }
  | { kind: 'endWithoutStart' }
  | { kind: 'partialAssignment'; missing: readonly ('provider' | 'vehicleClass' | 'modality' | 'quantity')[] }
  | { kind: 'workbookAmountWithoutAssignment' };

/**
 * Exhaustive over every non-`field` arm, so adding a `ColumnTarget` kind is a `tsc`
 * failure here rather than a select option that silently maps to `{kind:'ignored'}`.
 */
const fixedTargets = {
  ignored: true,
  serviceName: true,
  startsAtDate: true,
  startsAtTime: true,
  endsAtDate: true,
  endsAtTime: true,
  provider: true,
  vehicleClass: true,
  modality: true,
  quantity: true,
  costCentre: true,
  workbookAmount: true,
} as const satisfies Record<Exclude<ColumnTarget['kind'], 'field'>, true>;

function isFixedTargetKind(value: string): value is Exclude<ColumnTarget['kind'], 'field'> {
  return Object.hasOwn(fixedTargets, value);
}

/** The select option value for a column target; `targetFromValue` is its inverse. */
export function targetValue(target: ColumnTarget): string {
  return target.kind === 'field' ? `field:${target.fieldDefinitionId}` : target.kind;
}

/**
 * Anything not recognised becomes `ignored`: a field id no longer on the selected
 * version, or a value this build does not know, must not be mapped to a column.
 */
export function targetFromValue(value: string, fieldDefinitionIds: readonly string[]): ColumnTarget {
  const fieldDefinitionId = fieldDefinitionIds.find((id) => value === `field:${id}`);
  if (fieldDefinitionId !== undefined) return { kind: 'field', fieldDefinitionId };
  return isFixedTargetKind(value) ? { kind: value } : { kind: 'ignored' };
}

function targetKey(target: ColumnTarget): string | undefined {
  if (target.kind === 'ignored') return undefined;
  return targetValue(target);
}

export function mappingProblems(
  mapping: WorkbookMapping,
  versionFields: readonly VersionField[],
): readonly MappingProblem[] {
  const problems: MappingProblem[] = [];
  const columnsByTarget = new Map<string, number[]>();
  mapping.forEach((target, column) => {
    const key = targetKey(target);
    if (key === undefined) return;
    const columns = columnsByTarget.get(key) ?? [];
    columns.push(column);
    columnsByTarget.set(key, columns);
  });
  for (const [target, columns] of columnsByTarget) {
    if (columns.length > 1) problems.push({ kind: 'duplicateTarget', target, columns });
  }

  for (const target of ['serviceName', 'startsAtDate', 'startsAtTime'] as const) {
    if (!columnsByTarget.has(target)) problems.push({ kind: 'requiredTargetUnmapped', target });
  }

  for (const field of versionFields) {
    const hasDefault = field.defaultValue !== undefined || field.defaultLocationId !== undefined;
    if (field.required && !hasDefault && !columnsByTarget.has(`field:${field.fieldDefinitionId}`)) {
      problems.push({ kind: 'requiredFieldUnmapped', fieldDefinitionId: field.fieldDefinitionId });
    }
  }

  const has = (kind: ColumnTarget['kind']): boolean => mapping.some((target) => target.kind === kind);
  if (has('startsAtTime') && !has('startsAtDate')) problems.push({ kind: 'timeWithoutDate', target: 'startsAtTime' });
  if (has('endsAtTime') && !has('endsAtDate')) problems.push({ kind: 'timeWithoutDate', target: 'endsAtTime' });
  if ((has('endsAtDate') || has('endsAtTime')) && (!has('startsAtDate') || !has('startsAtTime'))) {
    problems.push({ kind: 'endWithoutStart' });
  }

  const assignmentKinds = ['provider', 'vehicleClass', 'modality', 'quantity'] as const;
  const present = assignmentKinds.filter(has);
  if (present.length > 0 && present.length < assignmentKinds.length) {
    problems.push({ kind: 'partialAssignment', missing: assignmentKinds.filter((kind) => !has(kind)) });
  }
  if (has('workbookAmount') && present.length !== assignmentKinds.length) {
    problems.push({ kind: 'workbookAmountWithoutAssignment' });
  }
  return problems;
}
