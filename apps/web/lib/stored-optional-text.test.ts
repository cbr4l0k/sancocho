import { expect, test } from 'bun:test';

import { optionalTextMutationValue, storedOptionalText } from './stored-optional-text';

test('stored optional text renders absent and blank values as not set', () => {
  expect(storedOptionalText(undefined, 'Not set')).toBe('Not set');
  expect(storedOptionalText(null, 'Not set')).toBe('Not set');
  expect(storedOptionalText('', 'Not set')).toBe('Not set');
  expect(storedOptionalText('   ', 'Not set')).toBe('Not set');
  expect(storedOptionalText('Andes', 'Not set')).toBe('Andes');
});

test('optional text mutation values distinguish omission from clearing', () => {
  expect(optionalTextMutationValue('', undefined)).toBeUndefined();
  expect(optionalTextMutationValue('   ', undefined)).toBeUndefined();
  expect(optionalTextMutationValue('', 'Andes')).toBe('');
  expect(optionalTextMutationValue('  Andes  ', 'Old')).toBe('  Andes  ');
});
