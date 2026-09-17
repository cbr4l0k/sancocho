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

function targetKey(target: ColumnTarget): string | undefined {
  if (target.kind === 'ignored') return undefined;
  return target.kind === 'field' ? `field:${target.fieldDefinitionId}` : target.kind;
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
