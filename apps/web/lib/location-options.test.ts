import { describe, expect, test } from 'bun:test';

import { buildLocationOptions } from './location-options';

type TestLocation = {
  _id: string;
  name: string;
  status: 'active' | 'archived';
};

const activeTerminal: TestLocation = { _id: 'terminal', name: 'Terminal Norte', status: 'active' };
const activeWarehouse: TestLocation = { _id: 'warehouse', name: 'Bodega Central', status: 'active' };
const archivedTerminal: TestLocation = { _id: 'terminal', name: 'Terminal Norte', status: 'archived' };

describe('buildLocationOptions', () => {
  test('includes the selected archived location and flags it as archived', () => {
    expect(buildLocationOptions({ loaded: [activeWarehouse], selected: archivedTerminal })).toEqual([
      { location: archivedTerminal, isArchived: true },
      { location: activeWarehouse, isArchived: false },
    ]);
  });

  test('includes a selected active location that is absent from the loaded page', () => {
    expect(buildLocationOptions({ loaded: [activeWarehouse], selected: activeTerminal })).toEqual([
      { location: activeTerminal, isArchived: false },
      { location: activeWarehouse, isArchived: false },
    ]);
  });

  test('does not duplicate a selected location already in the loaded page', () => {
    const options = buildLocationOptions({ loaded: [activeTerminal, activeWarehouse], selected: activeTerminal });

    expect(options).toHaveLength(2);
    expect(options.filter((option) => option.location._id === activeTerminal._id)).toHaveLength(1);
  });

  test('returns only loaded active options when there is no selection', () => {
    expect(buildLocationOptions({ loaded: [activeTerminal, activeWarehouse], selected: undefined })).toEqual([
      { location: activeTerminal, isArchived: false },
      { location: activeWarehouse, isArchived: false },
    ]);
  });

  test('excludes archived loaded locations that are not selected', () => {
    const archivedWarehouse: TestLocation = { _id: 'warehouse', name: 'Bodega Central', status: 'archived' };

    expect(buildLocationOptions({ loaded: [activeTerminal, archivedWarehouse], selected: undefined })).toEqual([
      { location: activeTerminal, isArchived: false },
    ]);
  });
});
