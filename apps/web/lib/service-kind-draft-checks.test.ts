import { expect, test } from 'bun:test';

import { checkServiceKindDraft } from './service-kind-draft-checks';

function problemsFor(result: ReturnType<typeof checkServiceKindDraft>, id: string): string {
  return (result.fieldProblems.get(id) ?? []).join(',');
}

test('reports an empty draft', () => {
  expect(checkServiceKindDraft([]).empty).toBe(true);
});

test('reports duplicate field definitions on every duplicate row', () => {
  const result = checkServiceKindDraft([
    { _id: 'first', fieldDefinitionId: 'one', position: 0, required: false, visible: true },
    { _id: 'second', fieldDefinitionId: 'one', position: 1, required: false, visible: true },
  ]);
  expect(problemsFor(result, 'first')).toBe('duplicateDefinition');
  expect(problemsFor(result, 'second')).toBe('duplicateDefinition');
});

test('reports duplicate positions, negative and non-integer positions', () => {
  const result = checkServiceKindDraft([
    { _id: 'one', fieldDefinitionId: 'one', position: 0, required: false, visible: true },
    { _id: 'two', fieldDefinitionId: 'two', position: 0, required: false, visible: true },
    { _id: 'three', fieldDefinitionId: 'three', position: -1, required: false, visible: true },
    { _id: 'four', fieldDefinitionId: 'four', position: 1.5, required: false, visible: true },
  ]);
  expect(problemsFor(result, 'one')).toBe('duplicatePosition');
  expect(problemsFor(result, 'two')).toBe('duplicatePosition');
  expect(problemsFor(result, 'three')).toBe('invalidPosition');
  expect(problemsFor(result, 'four')).toBe('invalidPosition');
});

test('reports required fields hidden from operators', () => {
  const result = checkServiceKindDraft([
    { _id: 'one', fieldDefinitionId: 'one', position: 0, required: true, visible: false },
  ]);
  expect(problemsFor(result, 'one')).toBe('requiredHidden');
});
