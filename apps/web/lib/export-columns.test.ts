import { describe, expect, test } from 'bun:test';

import { exportFieldHeaders, serviceFieldCells, type ServiceFieldSource } from './export-columns';
import { serviceFieldColumns } from './service-columns';

describe('export field headers', () => {
  test('uses the field label when it identifies the column on its own', () => {
    expect(
      exportFieldHeaders([
        { key: 'flight_number', label: 'Número de vuelo' },
        { key: 'passenger_count', label: 'Pasajeros' },
      ]),
    ).toEqual(['Número de vuelo', 'Pasajeros']);
  });

  test('disambiguates every column of a shared label, not only the later one', () => {
    // Two different Field Definitions whose tenant-authored labels collide. Marking only
    // the second would make the first look like the canonical column.
    expect(
      exportFieldHeaders([
        { key: 'pickup_notes', label: 'Notas' },
        { key: 'passenger_count', label: 'Pasajeros' },
        { key: 'driver_notes', label: 'Notas' },
      ]),
    ).toEqual(['Notas (pickup_notes)', 'Pasajeros', 'Notas (driver_notes)']);
  });

  test('disambiguates three columns sharing one label', () => {
    expect(
      exportFieldHeaders([
        { key: 'a_notes', label: 'Notas' },
        { key: 'b_notes', label: 'Notas' },
        { key: 'c_notes', label: 'Notas' },
      ]),
    ).toEqual(['Notas (a_notes)', 'Notas (b_notes)', 'Notas (c_notes)']);
  });
});

describe('service field cells', () => {
  const flight: ServiceFieldSource = {
    key: 'flight_number',
    config: { kind: 'text' },
    value: { kind: 'text', value: 'AV8020' },
  };
  const passengers: ServiceFieldSource = {
    key: 'passenger_count',
    config: { kind: 'number' },
    value: { kind: 'number', value: 18 },
  };
  const unfilled: ServiceFieldSource = { key: 'terminal', config: { kind: 'text' } };

  const columns = [
    { key: 'flight_number', label: 'Número de vuelo' },
    { key: 'passenger_count', label: 'Pasajeros' },
    { key: 'terminal', label: 'Terminal' },
  ];

  test('places every value under its own column, in column order', () => {
    expect(serviceFieldCells([passengers, flight], columns)).toEqual([
      { kind: 'text', value: 'AV8020' },
      { kind: 'number', value: 18 },
      { kind: 'empty' },
    ]);
  });

  test('leaves a column this version does not compose blank', () => {
    // A shuttle composes neither the flight number nor the terminal an airport transfer
    // does. Those cells are blank; they are not the previous row's values and they are
    // not a sentinel string that would break the column's type for every other row.
    expect(serviceFieldCells([passengers], columns)).toEqual([
      { kind: 'empty' },
      { kind: 'number', value: 18 },
      { kind: 'empty' },
    ]);
  });

  test('leaves a composed field with no stored value blank', () => {
    expect(serviceFieldCells([flight, unfilled], columns)).toEqual([
      { kind: 'text', value: 'AV8020' },
      { kind: 'empty' },
      { kind: 'empty' },
    ]);
  });

  test('gives two rows composing different fields their own cells', () => {
    const transfer = serviceFieldCells([flight, passengers], columns);
    const shuttle = serviceFieldCells([{ ...passengers, value: { kind: 'number', value: 42 } }], columns);
    expect(transfer).toEqual([
      { kind: 'text', value: 'AV8020' },
      { kind: 'number', value: 18 },
      { kind: 'empty' },
    ]);
    expect(shuttle).toEqual([{ kind: 'empty' }, { kind: 'number', value: 42 }, { kind: 'empty' }]);
  });

  test('lines up with the union the Services table builds from the same rows', () => {
    // The export does not invent a second column strategy: it fills the columns
    // `service-columns.ts` already derives for the screen. This pins the two together, so
    // a change to that union cannot silently shift which value lands in which column.
    const rows = [
      { fields: [{ key: 'passenger_count', label: 'Pasajeros', position: 1 }] },
      {
        fields: [
          { key: 'flight_number', label: 'Número de vuelo', position: 0 },
          { key: 'terminal', label: 'Terminal', position: 2 },
        ],
      },
    ];
    const union = serviceFieldColumns(rows);
    expect(union.map((column) => column.key)).toEqual(['flight_number', 'passenger_count', 'terminal']);
    expect(serviceFieldCells([flight, passengers], union)).toEqual([
      { kind: 'text', value: 'AV8020' },
      { kind: 'number', value: 18 },
      { kind: 'empty' },
    ]);
  });

  test('orders two fields that share a label and a position by key, in either arrival order', () => {
    // Position and label both tie, so the remaining comparison is the key. Without it
    // the column set would follow whichever row arrived first, and the colliding
    // headers would follow it. docs/export.md promises both determinism and
    // collision-disambiguation of those headers.
    const alpha = { key: 'alpha_notes', label: 'Notas', position: 0 };
    const zeta = { key: 'zeta_notes', label: 'Notas', position: 0 };
    const fromAlphaFirst = serviceFieldColumns([{ fields: [alpha] }, { fields: [zeta] }]);
    const fromZetaFirst = serviceFieldColumns([{ fields: [zeta] }, { fields: [alpha] }]);
    expect(fromAlphaFirst.map((column) => column.key)).toEqual(['alpha_notes', 'zeta_notes']);
    expect(fromZetaFirst.map((column) => column.key)).toEqual(['alpha_notes', 'zeta_notes']);
    expect(exportFieldHeaders(fromAlphaFirst)).toEqual(['Notas (alpha_notes)', 'Notas (zeta_notes)']);
    expect(exportFieldHeaders(fromZetaFirst)).toEqual(['Notas (alpha_notes)', 'Notas (zeta_notes)']);
  });
});
