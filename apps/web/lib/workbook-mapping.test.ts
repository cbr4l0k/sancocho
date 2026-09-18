import { describe, expect, test } from 'bun:test';

import {
  mappingProblems,
  targetFromValue,
  targetValue,
  type ColumnTarget,
  type VersionField,
  type WorkbookMapping,
} from './workbook-mapping';

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

  test('counts a snapshot default location as a default, the same as a default value', () => {
    // A required `location` field whose version snapshot pins a default location is
    // already answered; demanding a column for it would block the whole mapping.
    const defaultedLocation: readonly VersionField[] = [
      { fieldDefinitionId: 'required', required: true, config: { kind: 'location' }, defaultLocationId: 'location-1' },
    ];
    expect(mappingProblems([], defaultedLocation)).not.toContainEqual({
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

describe('column target select values', () => {
  // Keyed by kind and anchored with `satisfies`, so adding a `ColumnTarget` arm is a
  // `tsc` failure HERE too, not just in the module. Enumerated literally rather than
  // iterated off the module's own `fixedTargets`: deriving the list from the code
  // under test would make the round-trip assert nothing.
  const fixedByKind = {
    ignored: { kind: 'ignored' },
    serviceName: { kind: 'serviceName' },
    startsAtDate: { kind: 'startsAtDate' },
    startsAtTime: { kind: 'startsAtTime' },
    endsAtDate: { kind: 'endsAtDate' },
    endsAtTime: { kind: 'endsAtTime' },
    provider: { kind: 'provider' },
    vehicleClass: { kind: 'vehicleClass' },
    modality: { kind: 'modality' },
    quantity: { kind: 'quantity' },
    costCentre: { kind: 'costCentre' },
    workbookAmount: { kind: 'workbookAmount' },
  } as const satisfies Record<Exclude<ColumnTarget['kind'], 'field'>, ColumnTarget>;
  const fixed: readonly ColumnTarget[] = Object.values(fixedByKind);

  test('round-trips every fixed target through its select value', () => {
    for (const target of fixed) {
      expect(targetFromValue(targetValue(target), ['passengers'])).toEqual(target);
    }
  });

  test('round-trips a field target only while its field is on the selected version', () => {
    expect(targetValue({ kind: 'field', fieldDefinitionId: 'passengers' })).toBe('field:passengers');
    expect(targetFromValue('field:passengers', ['passengers', 'luggage'])).toEqual({
      kind: 'field',
      fieldDefinitionId: 'passengers',
    });
    // A field id from a version the operator has since switched away from.
    expect(targetFromValue('field:passengers', ['luggage'])).toEqual({ kind: 'ignored' });
  });

  test('falls back to ignored for anything it does not recognize', () => {
    expect(targetFromValue('provider ', ['passengers'])).toEqual({ kind: 'ignored' });
    expect(targetFromValue('', ['passengers'])).toEqual({ kind: 'ignored' });
    expect(targetFromValue('Provider', ['passengers'])).toEqual({ kind: 'ignored' });
    expect(targetFromValue('field:', ['passengers'])).toEqual({ kind: 'ignored' });
    expect(targetFromValue('toString', ['passengers'])).toEqual({ kind: 'ignored' });
  });
});
