import { expect, test } from 'bun:test';

import { localeHref } from '@/i18n/locale-href';

test('builds Spanish service kind paths from the URL locale segment', () => {
  expect(localeHref('es-CO', '/settings/service-kinds/123')).toBe('/es/settings/service-kinds/123');
});

test('builds English service kind paths from the URL locale segment', () => {
  expect(localeHref('en-US', '/settings/service-kinds/123')).toBe('/en/settings/service-kinds/123');
});

test('never emits canonical locales in URL paths', () => {
  const spanishHref = localeHref('es-CO', '/settings/service-kinds/123');
  const englishHref = localeHref('en-US', '/settings/service-kinds/123');

  expect(spanishHref).not.toContain('es-CO');
  expect(englishHref).not.toContain('en-US');
});

test('normalizes paths without a leading slash', () => {
  expect(localeHref('es-CO', 'settings/service-kinds/123')).toBe('/es/settings/service-kinds/123');
});

test('preserves query strings', () => {
  expect(localeHref('es-CO', '/services/new?projectId=x')).toBe('/es/services/new?projectId=x');
  expect(localeHref('es-CO', '/events/new?projectId=x')).toBe('/es/events/new?projectId=x');
});

test('retains locale segments for Event and Service detail links', () => {
  expect(localeHref('es-CO', '/events/event-id')).toBe('/es/events/event-id');
  expect(localeHref('en-US', '/services/service-id')).toBe('/en/services/service-id');
});


test('preserves fragments', () => {
  expect(localeHref('en-US', '/settings/service-kinds/123#versions')).toBe('/en/settings/service-kinds/123#versions');
});
