import { describe, expect, test } from 'bun:test';

import type { ExportCell } from './export-cells';
import {
  eventsSheet,
  locationsSheet,
  projectsSheet,
  serviceKindsSheet,
  servicesSheet,
  sheetCells,
  type ExportLookups,
} from './export-sheets';

/*
 * `translate` is the identity, so every assertion below names the MESSAGE KEY a cell asks
 * for rather than its Spanish or English wording. Which key a status or a header resolves
 * to is this module's decision and is worth pinning; the wording belongs to the
 * catalogues, and `bun run i18n:check` already proves both locales carry every key.
 */
const translate = <Key extends string>(key: Key): Key => key;

const lookups: ExportLookups = {
  projectNames: new Map([['project-1', 'Cumbre Andina']]),
  eventNames: new Map([['event-1', 'Traslados día 1']]),
  locationNames: new Map([['location-1', 'Aeropuerto El Dorado']]),
  costCentreNames: new Map([['cost-1', 'Operación Bogotá']]),
  userNames: new Map([['user-1', 'Ana Restrepo']]),
  serviceKindNames: new Map([['kind-1', 'Traslado aeropuerto']]),
  versionNumbers: new Map([['version-1', 3]]),
};

const startsAt = new Date(2026, 8, 12, 10, 20).getTime();
const startsAtCell: ExportCell = {
  kind: 'date',
  value: new Date(Date.UTC(2026, 8, 12, 10, 20)),
  format: 'yyyy-mm-dd hh:mm',
};

describe('events sheet', () => {
  test('resolves every reference to a display name and types every cell', () => {
    const sheet = eventsSheet(
      [
        {
          name: 'Traslados día 1',
          status: 'active',
          startsAt,
          projectId: 'project-1',
          venueLocationId: 'location-1',
          clientCostCentreId: 'cost-1',
          budgetAmount: 81_000_000,
          budgetCurrency: 'COP',
          accountableUserId: 'user-1',
        },
      ],
      lookups,
      translate,
    );

    expect(sheet.name).toBe('export.sheetNames.events');
    expect(sheet.headers).toEqual([
      'export.columns.name',
      'export.columns.project',
      'export.columns.status',
      'export.columns.startsAt',
      'export.columns.endsAt',
      'export.columns.venue',
      'export.columns.costCentre',
      'export.columns.budget',
      'export.columns.currency',
      'export.columns.accountable',
    ]);
    expect(sheet.rows).toEqual([
      [
        { kind: 'text', value: 'Traslados día 1' },
        { kind: 'text', value: 'Cumbre Andina' },
        { kind: 'text', value: 'events.statuses.active' },
        startsAtCell,
        { kind: 'empty' },
        { kind: 'text', value: 'Aeropuerto El Dorado' },
        { kind: 'text', value: 'Operación Bogotá' },
        { kind: 'number', value: 810000, format: '"COP" #,##0.00' },
        { kind: 'text', value: 'COP' },
        { kind: 'text', value: 'Ana Restrepo' },
      ],
    ]);
  });

  test('leaves a reference it could not resolve blank rather than writing the id', () => {
    const sheet = eventsSheet(
      [{ name: 'Suelto', status: 'draft', startsAt, projectId: 'project-404', venueLocationId: 'location-404' }],
      lookups,
      translate,
    );
    expect(sheet.rows[0]?.[1]).toEqual({ kind: 'empty' });
    expect(sheet.rows[0]?.[5]).toEqual({ kind: 'empty' });
  });

  test('refuses to write an amount with no currency as money', () => {
    // A number with no currency beside it is not money; writing it under a COP format
    // would state a fact the record does not carry.
    const sheet = eventsSheet(
      [{ name: 'Sin moneda', status: 'draft', startsAt, projectId: 'project-1', budgetAmount: 81_000_000 }],
      lookups,
      translate,
    );
    expect(sheet.rows[0]?.[7]).toEqual({ kind: 'empty' });
    expect(sheet.rows[0]?.[8]).toEqual({ kind: 'empty' });
  });
});

describe('services sheet', () => {
  const service = {
    service: {
      name: 'Traslado AV8020',
      status: 'confirmed',
      startsAt,
      projectId: 'project-1',
      eventId: 'event-1',
      serviceKindId: 'kind-1',
      serviceKindVersionId: 'version-1',
    },
    fields: [
      { key: 'flight_number', config: { kind: 'text' }, value: { kind: 'text', value: 'AV8020' } },
    ],
  } as const;

  test('writes the semantic columns first and the union columns after them', () => {
    const sheet = servicesSheet(
      [service],
      [
        { key: 'flight_number', label: 'Número de vuelo' },
        { key: 'terminal', label: 'Terminal' },
      ],
      lookups,
      translate,
    );

    expect(sheet.headers).toEqual([
      'export.columns.name',
      'export.columns.project',
      'export.columns.event',
      'export.columns.serviceKind',
      'export.columns.version',
      'export.columns.status',
      'export.columns.startsAt',
      'export.columns.endsAt',
      'Número de vuelo',
      'Terminal',
    ]);
    expect(sheet.rows).toEqual([
      [
        { kind: 'text', value: 'Traslado AV8020' },
        { kind: 'text', value: 'Cumbre Andina' },
        { kind: 'text', value: 'Traslados día 1' },
        { kind: 'text', value: 'Traslado aeropuerto' },
        { kind: 'number', value: 3 },
        { kind: 'text', value: 'services.statuses.confirmed' },
        startsAtCell,
        { kind: 'empty' },
        { kind: 'text', value: 'AV8020' },
        { kind: 'empty' },
      ],
    ]);
  });

  test('writes the version number, never the version id', () => {
    const sheet = servicesSheet(
      [{ ...service, service: { ...service.service, serviceKindVersionId: 'version-404' } }],
      [],
      lookups,
      translate,
    );
    expect(sheet.rows[0]?.[4]).toEqual({ kind: 'empty' });
  });
});

describe('projects sheet', () => {
  test('writes a project with no window as blanks, not as zero', () => {
    const sheet = projectsSheet(
      [
        { name: 'Cumbre Andina', status: 'active', startsAt, endsAt: startsAt, description: 'Cliente X' },
        { name: 'Sin fechas', status: 'draft' },
      ],
      translate,
    );
    expect(sheet.name).toBe('export.sheetNames.projects');
    expect(sheet.rows[0]).toEqual([
      { kind: 'text', value: 'Cumbre Andina' },
      { kind: 'text', value: 'projects.statuses.active' },
      startsAtCell,
      startsAtCell,
      { kind: 'text', value: 'Cliente X' },
    ]);
    expect(sheet.rows[1]).toEqual([
      { kind: 'text', value: 'Sin fechas' },
      { kind: 'text', value: 'projects.statuses.draft' },
      { kind: 'empty' },
      { kind: 'empty' },
      { kind: 'empty' },
    ]);
  });

  test('treats whitespace-only tenant text as no text at all', () => {
    // An operator who typed a space into a description did not write a description. A cell
    // holding ' ' reads as filled in a spreadsheet — it is not blank, it does not match a
    // blank filter, and it sorts among the real values.
    const sheet = projectsSheet([{ name: 'Cumbre Andina', status: 'active', description: '   ' }], translate);
    expect(sheet.rows[0]?.[4]).toEqual({ kind: 'empty' });
  });
});

describe('service kinds sheet', () => {
  test('writes one row per version, repeating the kind that owns it', () => {
    const sheet = serviceKindsSheet(
      [
        {
          key: 'airport_transfer',
          name: 'Traslado aeropuerto',
          status: 'active',
          description: 'Llegadas y salidas',
          versions: [
            { versionNumber: 1, status: 'retired', publishedAt: startsAt },
            { versionNumber: 2, status: 'published', publishedAt: startsAt },
          ],
        },
      ],
      translate,
    );
    expect(sheet.rows).toEqual([
      [
        { kind: 'text', value: 'airport_transfer' },
        { kind: 'text', value: 'Traslado aeropuerto' },
        { kind: 'text', value: 'serviceKinds.statuses.active' },
        { kind: 'number', value: 1 },
        { kind: 'text', value: 'serviceKinds.versionStatuses.retired' },
        startsAtCell,
        { kind: 'text', value: 'Llegadas y salidas' },
      ],
      [
        { kind: 'text', value: 'airport_transfer' },
        { kind: 'text', value: 'Traslado aeropuerto' },
        { kind: 'text', value: 'serviceKinds.statuses.active' },
        { kind: 'number', value: 2 },
        { kind: 'text', value: 'serviceKinds.versionStatuses.published' },
        startsAtCell,
        { kind: 'text', value: 'Llegadas y salidas' },
      ],
    ]);
  });

  test('still writes a service kind that has no version at all', () => {
    // A Kind with no draft yet is part of the configuration record. Dropping it would make
    // the sheet quietly disagree with the Service Kinds screen.
    const sheet = serviceKindsSheet([{ key: 'shuttle', name: 'Shuttle', status: 'draft', versions: [] }], translate);
    expect(sheet.rows).toEqual([
      [
        { kind: 'text', value: 'shuttle' },
        { kind: 'text', value: 'Shuttle' },
        { kind: 'text', value: 'serviceKinds.statuses.draft' },
        { kind: 'empty' },
        { kind: 'empty' },
        { kind: 'empty' },
        { kind: 'empty' },
      ],
    ]);
  });
});

describe('locations sheet', () => {
  test('writes the type and status as code-owned labels and the coordinates as numbers', () => {
    const sheet = locationsSheet(
      [
        {
          name: 'Aeropuerto El Dorado',
          type: 'airport',
          status: 'archived',
          address: 'Av. El Dorado',
          latitude: 4.7016,
          longitude: -74.1469,
        },
      ],
      translate,
    );
    expect(sheet.rows).toEqual([
      [
        { kind: 'text', value: 'Aeropuerto El Dorado' },
        { kind: 'text', value: 'locations.types.airport' },
        { kind: 'text', value: 'fields.statuses.archived' },
        { kind: 'text', value: 'Av. El Dorado' },
        { kind: 'number', value: 4.7016 },
        { kind: 'number', value: -74.1469 },
      ],
    ]);
  });

  test('keeps an archived row, with its status, rather than dropping it', () => {
    const sheet = locationsSheet(
      [
        { name: 'Activa', type: 'hotel', status: 'active' },
        { name: 'Archivada', type: 'depot', status: 'archived' },
      ],
      translate,
    );
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[1]?.[2]).toEqual({ kind: 'text', value: 'fields.statuses.archived' });
  });
});

describe('sheet cells', () => {
  test('puts the header row above the data rows', () => {
    const sheet = projectsSheet([{ name: 'Cumbre Andina', status: 'active' }], translate);
    const cells = sheetCells(sheet);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toEqual([
      { kind: 'text', value: 'export.columns.name' },
      { kind: 'text', value: 'export.columns.status' },
      { kind: 'text', value: 'export.columns.startsAt' },
      { kind: 'text', value: 'export.columns.endsAt' },
      { kind: 'text', value: 'export.columns.description' },
    ]);
    expect(cells[1]?.[0]).toEqual({ kind: 'text', value: 'Cumbre Andina' });
  });
});
