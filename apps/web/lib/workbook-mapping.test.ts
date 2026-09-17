import { describe, expect, test } from 'bun:test';

import { mappingProblems, type VersionField, type WorkbookMapping } from './workbook-mapping';

const fields: readonly VersionField[] = [
  { fieldDefinitionId: 'required', required: true, config: { kind: 'text' } },
  { fieldDefinitionId: 'optional', required: false, config: { kind: 'text' } },
];

describe('workbook mapping validation', () => {
  test('accepts a complete service and assignment mapping', () => {
    const mapping: WorkbookMapping = [
      { kind: 'serviceName' }, { kind: 'startsAtDate' }, { kind: 'startsAtTime' },
      { kind: 'field', fieldDefinitionId: 'required' },
      { kind: 'provider' }, { kind: 'vehicleClass' }, { kind: 'modality' }, { kind: 'quantity' },
      { kind: 'workbookAmount' },
    ];
    expect(mappingProblems(mapping, fields)).toEqual([]);
  });

  test('reports duplicate single-valued and field targets by column', () => {
    const problems = mappingProblems([
      { kind: 'serviceName' }, { kind: 'serviceName' },
      { kind: 'field', fieldDefinitionId: 'required' }, { kind: 'field', fieldDefinitionId: 'required' },
    ], fields);
    expect(problems).toContainEqual({ kind: 'duplicateTarget', target: 'serviceName', columns: [0, 1] });
    expect(problems).toContainEqual({ kind: 'duplicateTarget', target: 'field:required', columns: [2, 3] });
  });

  test('requires unmapped required fields unless their snapshot has a default', () => {
    expect(mappingProblems([], fields)).toContainEqual({
      kind: 'requiredFieldUnmapped',
      fieldDefinitionId: 'required',
    });
    const defaulted: readonly VersionField[] = [
      { fieldDefinitionId: 'required', required: true, config: { kind: 'text' }, defaultValue: { kind: 'text', value: 'x' } },
    ];
    expect(mappingProblems([], defaulted)).not.toContainEqual({
      kind: 'requiredFieldUnmapped',
      fieldDefinitionId: 'required',
    });
  });

  test('requires the core service targets', () => {
    const problems = mappingProblems([{ kind: 'field', fieldDefinitionId: 'required' }], fields);
    expect(problems).toEqual([
      { kind: 'requiredTargetUnmapped', target: 'serviceName' },
      { kind: 'requiredTargetUnmapped', target: 'startsAtDate' },
      { kind: 'requiredTargetUnmapped', target: 'startsAtTime' },
    ]);
  });

  test('reports orphan times and ends without a complete start', () => {
    const problems = mappingProblems([
      { kind: 'startsAtTime' }, { kind: 'endsAtTime' },
      { kind: 'field', fieldDefinitionId: 'required' },
    ], fields);
    expect(problems).toContainEqual({ kind: 'timeWithoutDate', target: 'startsAtTime' });
    expect(problems).toContainEqual({ kind: 'timeWithoutDate', target: 'endsAtTime' });
    expect(problems).toContainEqual({ kind: 'endWithoutStart' });
  });

  test('keeps the assignment quartet all-or-nothing', () => {
    const problems = mappingProblems([
      { kind: 'provider' }, { kind: 'quantity' }, { kind: 'workbookAmount' },
      { kind: 'field', fieldDefinitionId: 'required' },
    ], fields);
    expect(problems).toContainEqual({ kind: 'partialAssignment', missing: ['vehicleClass', 'modality'] });
    expect(problems).toContainEqual({ kind: 'workbookAmountWithoutAssignment' });
  });

  test('does not treat several ignored columns as a duplicate target', () => {
    const mapping: WorkbookMapping = [
      { kind: 'ignored' },
      { kind: 'serviceName' },
      { kind: 'ignored' },
      { kind: 'startsAtDate' },
      { kind: 'ignored' },
      { kind: 'startsAtTime' },
      { kind: 'field', fieldDefinitionId: 'required' },
      { kind: 'ignored' },
    ];
    expect(mappingProblems(mapping, fields)).toEqual([]);
  });
});
