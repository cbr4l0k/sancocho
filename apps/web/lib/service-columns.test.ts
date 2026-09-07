import { describe, expect, test } from 'bun:test';

import { serviceFieldColumns } from './service-columns';

describe('serviceFieldColumns', () => {
  test('unions the fields of every loaded service kind', () => {
    const columns = serviceFieldColumns([
      { fields: [{ key: 'flight_number', label: 'Vuelo', position: 0 }] },
      { fields: [{ key: 'route', label: 'Ruta', position: 1 }] },
    ]);
    expect(columns.map((column) => column.key)).toEqual(['flight_number', 'route']);
  });

  test('treats the same field key from two service kinds as one column', () => {
    const columns = serviceFieldColumns([
      { fields: [{ key: 'notes', label: 'Notas', position: 3 }] },
      { fields: [{ key: 'notes', label: 'Notas', position: 9 }] },
    ]);
    expect(columns).toEqual([{ key: 'notes', label: 'Notas' }]);
  });

  test('orders by the earliest position any service kind gives a field', () => {
    const columns = serviceFieldColumns([
      { fields: [{ key: 'notes', label: 'Notas', position: 9 }] },
      {
        fields: [
          { key: 'notes', label: 'Notas', position: 1 },
          { key: 'terminal', label: 'Terminal', position: 2 },
        ],
      },
    ]);
    expect(columns.map((column) => column.key)).toEqual(['notes', 'terminal']);
  });

  test('breaks a position tie by label so the order is stable across pages', () => {
    const columns = serviceFieldColumns([
      { fields: [{ key: 'z', label: 'Zulia', position: 0 }] },
      { fields: [{ key: 'a', label: 'Andes', position: 0 }] },
    ]);
    expect(columns.map((column) => column.key)).toEqual(['a', 'z']);
  });

  test('has no columns to offer before a page loads', () => {
    expect(serviceFieldColumns([])).toEqual([]);
  });
});
