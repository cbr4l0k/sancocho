import { expect, test } from 'bun:test';

import { localeHref } from '@/i18n/locale-href';

test('builds Spanish recipe paths from the URL locale segment', () => {
  expect(localeHref('es-CO', '/recipes/123')).toBe('/es/recipes/123');
});

test('builds English recipe paths from the URL locale segment', () => {
  expect(localeHref('en-US', '/recipes/123')).toBe('/en/recipes/123');
});

test('never emits canonical locales in URL paths', () => {
  const spanishHref = localeHref('es-CO', '/recipes/123');
  const englishHref = localeHref('en-US', '/recipes/123');

  expect(spanishHref).not.toContain('es-CO');
  expect(englishHref).not.toContain('en-US');
});

test('normalizes paths without a leading slash', () => {
  expect(localeHref('es-CO', 'recipes/123')).toBe('/es/recipes/123');
});

test('preserves query strings', () => {
  expect(localeHref('es-CO', '/services/new?projectId=x')).toBe('/es/services/new?projectId=x');
});

test('preserves fragments', () => {
  expect(localeHref('en-US', '/recipes/123#versions')).toBe('/en/recipes/123#versions');
});
