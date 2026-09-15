import { expect, test } from 'bun:test';

import { catalogueArgs, fleetCatalogueArgs, pickerArgs } from './catalogue-filters';

test('query arguments carry no pagination state, so paging cannot be confused with filtering', () => {
  // This is the real content of "filters survive pagination". `usePaginatedQuery`
  // owns the cursor and compares these arguments to decide when to abandon it;
  // if a cursor or page size leaked in here, every "load more" would look like a
  // filter change and restart from the first page.
  //
  // An earlier version of this test asserted `catalogueArgs(a, f)` equals
  // `catalogueArgs(a, f)` — that a pure function is deterministic, which proves
  // nothing about pagination.
  const args = catalogueArgs('org-1', { search: 'Norte', status: 'active' });
  expect(Object.keys(args).sort()).toEqual(['organizationId', 'search', 'status']);
});

test('a search is trimmed, so incidental whitespace is not a different filter', () => {
  expect(catalogueArgs('org-1', { search: '  Norte  ', status: 'active' })).toEqual({
    organizationId: 'org-1',
    search: 'Norte',
    status: 'active',
  });
});

test('catalogue and fleet arguments are skipped entirely until an organization is known', () => {
  // `CLAUDE.md`: tenant lists pass `'skip'` until the current organization is
  // known. Without this, both surfaces fire a real paginated query carrying
  // `organizationId: undefined` on first render and on every organization
  // switch — an argument-validator rejection shown as an error on a screen
  // that should simply be pending. Only `pickerArgs` was covered before.
  expect(catalogueArgs(undefined, { search: '', status: '' })).toBe('skip');
  expect(catalogueArgs(undefined, { search: 'norte', status: 'active' })).toBe('skip');
  expect(fleetCatalogueArgs(undefined, { search: '', status: '', providerId: '', vehicleClassId: '' })).toBe('skip');
  expect(
    fleetCatalogueArgs(undefined, { search: 'x', status: 'active', providerId: 'p1', vehicleClassId: 'c1' }),
  ).toBe('skip');
});

test('changing any filter changes the arguments, which is what resets the cursor', () => {
  const base = catalogueArgs('org-1', { search: '', status: '' });
  expect(base).not.toEqual(catalogueArgs('org-1', { search: 'norte', status: '' }));
  expect(base).not.toEqual(catalogueArgs('org-1', { search: '', status: 'archived' }));
  expect(base).not.toEqual(catalogueArgs('org-2', { search: '', status: '' }));
});

test('an unset filter is absent from the arguments rather than sent as an empty string', () => {
  // The backend validators accept `status` only as `active | archived`, so a
  // literal '' would be rejected at the boundary rather than meaning "any".
  expect(catalogueArgs('org-1', { search: '   ', status: '' })).toEqual({ organizationId: 'org-1' });
});

test('fleet Provider and Vehicle Class filters travel as query arguments, not as a client-side filter', () => {
  // Their presence here is what proves the backend index serves them. Filtering
  // a fetched page instead would leave these absent and return short pages (I6).
  const args = fleetCatalogueArgs('org-1', {
    search: 'ABC',
    status: 'active',
    providerId: 'provider-1',
    vehicleClassId: 'class-1',
  });
  expect(args).toEqual({
    organizationId: 'org-1',
    search: 'ABC',
    status: 'active',
    providerId: 'provider-1',
    vehicleClassId: 'class-1',
  });
  expect(fleetCatalogueArgs('org-1', { search: 'ABC', status: 'active', providerId: '', vehicleClassId: 'class-1' }))
    .not.toHaveProperty('providerId');
  expect(fleetCatalogueArgs('org-1', { search: 'ABC', status: 'active', providerId: 'provider-1', vehicleClassId: '' }))
    .not.toHaveProperty('vehicleClassId');
});

test('pickers skip without organization context and request only active rows once it exists', () => {
  expect(pickerArgs(undefined, '')).toBe('skip');
  expect(pickerArgs(undefined, 'norte')).toBe('skip');
  expect(pickerArgs('org-1', 'norte')).toEqual({ organizationId: 'org-1', status: 'active', search: 'norte' });
  expect(pickerArgs('org-1', '')).toEqual({ organizationId: 'org-1', status: 'active' });
});
