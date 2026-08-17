import { expect, test } from 'vitest';

import { normalizeSearchTerm, normalizeSearchText } from '../convex/lib/search';

test('search normalization folds diacritics, punctuation, case, and whitespace', () => {
  expect(normalizeSearchText('  Medellín ', 'pickup_time', 'El Dorado – T2  ')).toBe('medellin pickup time el dorado t2');
  expect(normalizeSearchText('BOGOTÁ')).toBe('bogota');
});

test('search terms cap Convex expressions at sixteen tokens and discard empty text', () => {
  expect(normalizeSearchTerm(Array.from({ length: 18 }, (_, index) => `term${index + 1}`).join(' ')).split(' ')).toHaveLength(16);
  expect(normalizeSearchTerm('   ')).toBe('');
  expect(normalizeSearchTerm('—_!')).toBe('');
});
