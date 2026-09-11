import { describe, expect, test } from 'bun:test';

import {
  formatProjectionValue,
  prepareProjectionGroups,
  projectionLocationLabel,
  type ProjectionEntry,
} from './portal-projection';

const serviceName: ProjectionEntry = {
  semanticType: 'serviceName',
  label: 'Nombre de operación',
  value: { kind: 'text', value: 'Llegada artistas' },
};
const origin: ProjectionEntry = {
  semanticType: 'transport.origin',
  label: 'Recogida',
  value: { kind: 'text', value: 'Entrada norte' },
};
const serviceDate: ProjectionEntry = {
  semanticType: 'serviceDate',
  label: 'Día local',
  value: { kind: 'date', value: '2026-09-11' },
};

describe('prepareProjectionGroups', () => {
  test('preserves backend position order while grouping only adjacent entries', () => {
    const groups = prepareProjectionGroups([serviceName, origin, serviceDate]);
    expect(groups.map(({ group }) => group)).toEqual(['service', 'route', 'service']);
    expect(groups.flatMap(({ entries }) => entries.map(({ label }) => label))).toEqual([
      'Nombre de operación',
      'Recogida',
      'Día local',
    ]);
  });
});

describe('formatProjectionValue', () => {
  test('formats supported kinds with the locale helpers', () => {
    expect(formatProjectionValue('es-CO', serviceDate, 'Sin definir')).toContain('2026');
    expect(formatProjectionValue('en-US', {
      semanticType: 'passenger.count', label: 'Adultos', value: { kind: 'number', value: 1234 },
    }, 'Not set')).toBe('1,234');
    expect(formatProjectionValue('en-US', {
      semanticType: 'serviceTime', label: 'Hora', value: { kind: 'time', value: '13:05' },
    }, 'Not set')).toMatch(/1:05 PM/);
  });

  test('never renders unresolved reference or option identifiers', () => {
    expect(formatProjectionValue('en-US', {
      semanticType: 'serviceName', label: 'Selector', value: { kind: 'select', optionId: 'internal-option' },
    }, 'Not set')).toBe('Not set');
    expect(projectionLocationLabel(undefined, 'Not set')).toBe('Not set');
    expect(projectionLocationLabel('Terminal 2', 'Not set')).toBe('Terminal 2');
  });
});
