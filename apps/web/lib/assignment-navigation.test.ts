import { expect, test } from 'bun:test';

import { localeHref } from '@/i18n/locale-href';

const portalDetail = await Bun.file(
  new URL('../components/portal/assignment-detail-surface.tsx', import.meta.url),
).text();

test('portal Assignment detail routes its internal back link through LocaleLink', () => {
  expect(portalDetail).toContain('<LocaleLink');
});

test('Assignment engagement handoffs retain each locale URL segment', () => {
  expect(localeHref('es-CO', '/portal/engagements/project-1')).toBe('/es/portal/engagements/project-1');
  expect(localeHref('en-US', '/portal/engagements/project-1')).toBe('/en/portal/engagements/project-1');
});
