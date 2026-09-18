import type {
  currencyValidator,
  exportSheetValidator,
  locationTypeValidator,
  rateModalityValidator,
} from '@priamo/convex/validators';

import { instantCell, moneyCell, type ExportCell } from './export-cells';
import { exportFieldHeaders, serviceFieldCells, type ServiceFieldSource } from './export-columns';
import type { ServiceFieldColumn } from './service-columns';
import {
  archivalStatusTokens,
  assignmentRevisionStatusTokens,
  eventStatusTokens,
  executionStatusTokens,
  projectStatusTokens,
  rateCardVersionStatusTokens,
  serviceKindStatusTokens,
  serviceKindVersionStatusTokens,
  serviceStatusTokens,
  type ArchivalStatus,
  type AssignmentRevisionStatus,
  type EventStatus,
  type ExecutionStatus,
  type ProjectStatus,
  type RateCardVersionStatus,
  type ServiceKindStatus,
  type ServiceKindVersionStatus,
  type ServiceStatus,
  type StatusLabelKey,
} from './status';

export type ExportSheetName = typeof exportSheetValidator.type;
type Currency = typeof currencyValidator.type;
type LocationType = typeof locationTypeValidator.type;
type RateModality = typeof rateModalityValidator.type;

const columnKeys = [
  'export.columns.name',
  'export.columns.project',
  'export.columns.event',
  'export.columns.status',
  'export.columns.startsAt',
  'export.columns.endsAt',
  'export.columns.description',
  'export.columns.serviceKind',
  'export.columns.version',
  'export.columns.venue',
  'export.columns.costCentre',
  'export.columns.budget',
  'export.columns.currency',
  'export.columns.accountable',
  'export.columns.key',
  'export.columns.versionStatus',
  'export.columns.publishedAt',
  'export.columns.type',
  'export.columns.address',
  'export.columns.latitude',
  'export.columns.longitude',
  'export.columns.service',
  'export.columns.provider',
  'export.columns.vehicleClass',
  'export.columns.modality',
  'export.columns.quantity',
  'export.columns.unitAmount',
  'export.columns.lineTotal',
  'export.columns.executionStatus',
  'export.columns.revisionNumber',
  'export.columns.revisionStatus',
  'export.columns.acceptedAt',
  'export.columns.declinedReason',
  'export.columns.driver',
  'export.columns.vehiclePlate',
  'export.columns.legalName',
  'export.columns.taxId',
  'export.columns.contactName',
  'export.columns.contactEmail',
  'export.columns.contactPhone',
  'export.columns.notes',
  'export.columns.rateCard',
  'export.columns.dispatched',
  'export.columns.completed',
] as const;

type ColumnKey = (typeof columnKeys)[number];

/**
 * Every message key a sheet can ask for, as a union of literals rather than `string`.
 *
 * The console's `t` is typed against the catalogue, so this keeps a header key that does
 * not exist a `tsc` failure here instead of a raw key rendered into a spreadsheet cell.
 */
export type ExportMessageKey =
  | ColumnKey
  | `export.sheetNames.${ExportSheetName}`
  | StatusLabelKey
  | `locations.types.${LocationType}`
  | `common.modalities.${RateModality}`;

export type Translate = (key: ExportMessageKey) => string;

export type ExportSheetData = {
  readonly name: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly ExportCell[])[];
};

/**
 * Names the export resolves locally from the entities it already walked.
 *
 * Nothing here is fetched for its own sake: an id the maps do not know produces an empty
 * cell, never the id. A Convex id is meaningless outside the deployment, and in a
 * spreadsheet it looks like data.
 */
export type ExportLookups = {
  readonly projectNames: ReadonlyMap<string, string>;
  readonly eventNames: ReadonlyMap<string, string>;
  readonly locationNames: ReadonlyMap<string, string>;
  readonly costCentreNames: ReadonlyMap<string, string>;
  readonly userNames: ReadonlyMap<string, string>;
  readonly serviceKindNames: ReadonlyMap<string, string>;
  readonly versionNumbers: ReadonlyMap<string, number>;
};

const empty: ExportCell = { kind: 'empty' };

/** Tenant-authored text, exported exactly as entered. Empty text is a blank cell. */
function textCell(value: string | undefined): ExportCell {
  return value === undefined || value.trim() === '' ? empty : { kind: 'text', value };
}

function lookupCell(id: string | undefined, names: ReadonlyMap<string, string>): ExportCell {
  return id === undefined ? empty : textCell(names.get(id));
}

function numberCell(value: number | undefined): ExportCell {
  return value === undefined ? empty : { kind: 'number', value };
}

function optionalInstantCell(value: number | undefined): ExportCell {
  return value === undefined ? empty : instantCell(value);
}

function headers(translate: Translate, keys: readonly ColumnKey[]): string[] {
  return keys.map(translate);
}

export type ExportableEvent = {
  readonly name: string;
  readonly status: EventStatus;
  readonly startsAt: number;
  readonly endsAt?: number;
  readonly projectId: string;
  readonly venueLocationId?: string;
  readonly clientCostCentreId?: string;
  readonly budgetAmount?: number;
  readonly budgetCurrency?: Currency;
  readonly accountableUserId?: string;
};

const eventColumns = [
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
] as const satisfies readonly ColumnKey[];

export function eventsSheet(
  events: readonly ExportableEvent[],
  lookups: ExportLookups,
  translate: Translate,
): ExportSheetData {
  return {
    name: translate('export.sheetNames.events'),
    headers: headers(translate, eventColumns),
    rows: events.map((event) => [
      textCell(event.name),
      lookupCell(event.projectId, lookups.projectNames),
      { kind: 'text', value: translate(eventStatusTokens[event.status].labelKey) },
      instantCell(event.startsAt),
      optionalInstantCell(event.endsAt),
      lookupCell(event.venueLocationId, lookups.locationNames),
      lookupCell(event.clientCostCentreId, lookups.costCentreNames),
      // A budget with no currency is not money, so it is not written as an amount.
      event.budgetAmount === undefined || event.budgetCurrency === undefined
        ? empty
        : moneyCell(event.budgetAmount, event.budgetCurrency),
      textCell(event.budgetCurrency),
      lookupCell(event.accountableUserId, lookups.userNames),
    ]),
  };
}

export type ExportableService = {
  readonly service: {
    readonly name: string;
    readonly status: ServiceStatus;
    readonly startsAt: number;
    readonly endsAt?: number;
    readonly projectId: string;
    readonly eventId: string;
    readonly serviceKindId: string;
    readonly serviceKindVersionId: string;
  };
  readonly fields: readonly ServiceFieldSource[];
};

const serviceColumns = [
  'export.columns.name',
  'export.columns.project',
  'export.columns.event',
  'export.columns.serviceKind',
  'export.columns.version',
  'export.columns.status',
  'export.columns.startsAt',
  'export.columns.endsAt',
] as const satisfies readonly ColumnKey[];

/**
 * The semantic columns first in a fixed order, then the union of field columns the
 * Services table derives for the same rows. See docs/export.md "The Services column
 * strategy" for why it is one sheet with blanks rather than a sheet per Kind.
 */
export function servicesSheet(
  services: readonly ExportableService[],
  columns: readonly ServiceFieldColumn[],
  lookups: ExportLookups,
  translate: Translate,
): ExportSheetData {
  return {
    name: translate('export.sheetNames.services'),
    headers: [...headers(translate, serviceColumns), ...exportFieldHeaders(columns)],
    rows: services.map(({ service, fields }) => [
      textCell(service.name),
      lookupCell(service.projectId, lookups.projectNames),
      lookupCell(service.eventId, lookups.eventNames),
      lookupCell(service.serviceKindId, lookups.serviceKindNames),
      numberCell(lookups.versionNumbers.get(service.serviceKindVersionId)),
      { kind: 'text', value: translate(serviceStatusTokens[service.status].labelKey) },
      instantCell(service.startsAt),
      optionalInstantCell(service.endsAt),
      ...serviceFieldCells(fields, columns),
    ]),
  };
}

export type ExportableProject = {
  readonly name: string;
  readonly status: ProjectStatus;
  readonly startsAt?: number;
  readonly endsAt?: number;
  readonly description?: string;
};

const projectColumns = [
  'export.columns.name',
  'export.columns.status',
  'export.columns.startsAt',
  'export.columns.endsAt',
  'export.columns.description',
] as const satisfies readonly ColumnKey[];

export function projectsSheet(
  projects: readonly ExportableProject[],
  translate: Translate,
): ExportSheetData {
  return {
    name: translate('export.sheetNames.projects'),
    headers: headers(translate, projectColumns),
    rows: projects.map((project) => [
      textCell(project.name),
      { kind: 'text', value: translate(projectStatusTokens[project.status].labelKey) },
      optionalInstantCell(project.startsAt),
      optionalInstantCell(project.endsAt),
      textCell(project.description),
    ]),
  };
}

export type ExportableServiceKind = {
  readonly key: string;
  readonly name: string;
  readonly status: ServiceKindStatus;
  readonly description?: string;
  readonly versions: readonly {
    readonly versionNumber: number;
    readonly status: ServiceKindVersionStatus;
    readonly publishedAt?: number;
  }[];
};

const serviceKindColumns = [
  'export.columns.key',
  'export.columns.name',
  'export.columns.status',
  'export.columns.version',
  'export.columns.versionStatus',
  'export.columns.publishedAt',
  'export.columns.description',
] as const satisfies readonly ColumnKey[];

/**
 * One row per VERSION, not per Service Kind. A Service Kind's identity is its key and a
 * version's identity is its number; flattening them keeps both readable in a sheet that
 * can be sorted, and a Kind with no version still appears as a row of its own.
 */
export function serviceKindsSheet(
  serviceKinds: readonly ExportableServiceKind[],
  translate: Translate,
): ExportSheetData {
  const rows: ExportCell[][] = [];
  for (const serviceKind of serviceKinds) {
    const kindCells = [
      textCell(serviceKind.key),
      textCell(serviceKind.name),
      { kind: 'text', value: translate(serviceKindStatusTokens[serviceKind.status].labelKey) },
    ] as const satisfies readonly ExportCell[];
    if (serviceKind.versions.length === 0) {
      rows.push([...kindCells, empty, empty, empty, textCell(serviceKind.description)]);
      continue;
    }
    for (const version of serviceKind.versions) {
      rows.push([
        ...kindCells,
        { kind: 'number', value: version.versionNumber },
        { kind: 'text', value: translate(serviceKindVersionStatusTokens[version.status].labelKey) },
        optionalInstantCell(version.publishedAt),
        textCell(serviceKind.description),
      ]);
    }
  }
  return {
    name: translate('export.sheetNames.serviceKinds'),
    headers: headers(translate, serviceKindColumns),
    rows,
  };
}

export type ExportableLocation = {
  readonly name: string;
  readonly type: LocationType;
  readonly status: ArchivalStatus;
  readonly address?: string;
  readonly latitude?: number;
  readonly longitude?: number;
};

const locationColumns = [
  'export.columns.name',
  'export.columns.type',
  'export.columns.status',
  'export.columns.address',
  'export.columns.latitude',
  'export.columns.longitude',
] as const satisfies readonly ColumnKey[];

export function locationsSheet(
  locations: readonly ExportableLocation[],
  translate: Translate,
): ExportSheetData {
  return {
    name: translate('export.sheetNames.locations'),
    headers: headers(translate, locationColumns),
    rows: locations.map((location) => [
      textCell(location.name),
      { kind: 'text', value: translate(`locations.types.${location.type}`) },
      { kind: 'text', value: translate(archivalStatusTokens[location.status].labelKey) },
      textCell(location.address),
      numberCell(location.latitude),
      numberCell(location.longitude),
    ]),
  };
}

export type ExportableProvider = {
  readonly name: string;
  readonly legalName?: string;
  readonly taxId?: string;
  readonly contactName?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly notes?: string;
  readonly status: ArchivalStatus;
};

const providerColumns = [
  'export.columns.name',
  'export.columns.legalName',
  'export.columns.taxId',
  'export.columns.contactName',
  'export.columns.contactEmail',
  'export.columns.contactPhone',
  'export.columns.status',
  'export.columns.notes',
] as const satisfies readonly ColumnKey[];

export function providersSheet(
  providers: readonly ExportableProvider[],
  translate: Translate,
): ExportSheetData {
  return {
    name: translate('export.sheetNames.providers'),
    headers: headers(translate, providerColumns),
    rows: providers.map((provider) => [
      textCell(provider.name),
      textCell(provider.legalName),
      textCell(provider.taxId),
      textCell(provider.contactName),
      textCell(provider.contactEmail),
      textCell(provider.contactPhone),
      { kind: 'text', value: translate(archivalStatusTokens[provider.status].labelKey) },
      textCell(provider.notes),
    ]),
  };
}

export type ExportableRateCard = {
  readonly providerName: string;
  readonly name: string;
  readonly status: ArchivalStatus;
  readonly versions: readonly {
    readonly versionNumber: number;
    readonly status: RateCardVersionStatus;
    readonly publishedAt?: number;
    readonly currency: Currency;
    readonly lines: readonly {
      readonly vehicleClassName: string;
      readonly modality: RateModality;
      readonly unitAmount: number;
    }[];
  }[];
};

const rateCardColumns = [
  'export.columns.provider',
  'export.columns.rateCard',
  'export.columns.status',
  'export.columns.version',
  'export.columns.versionStatus',
  'export.columns.publishedAt',
  'export.columns.vehicleClass',
  'export.columns.modality',
  'export.columns.unitAmount',
  'export.columns.currency',
] as const satisfies readonly ColumnKey[];

/**
 * One row per RATE LINE, not per Rate Card. A card's identity is its name and a
 * line's identity is class × modality; flattening them keeps both readable in a
 * sheet that can be sorted. A version with no lines still appears as a row, and
 * a card with no versions still appears as a row of its own.
 */
export function rateCardsSheet(
  rateCards: readonly ExportableRateCard[],
  translate: Translate,
): ExportSheetData {
  const rows: ExportCell[][] = [];
  for (const rateCard of rateCards) {
    const cardCells = [
      textCell(rateCard.providerName),
      textCell(rateCard.name),
      { kind: 'text', value: translate(archivalStatusTokens[rateCard.status].labelKey) },
    ] as const satisfies readonly ExportCell[];
    if (rateCard.versions.length === 0) {
      rows.push([...cardCells, empty, empty, empty, empty, empty, empty, empty]);
      continue;
    }
    for (const version of rateCard.versions) {
      const versionCells = [
        ...cardCells,
        { kind: 'number', value: version.versionNumber },
        { kind: 'text', value: translate(rateCardVersionStatusTokens[version.status].labelKey) },
        optionalInstantCell(version.publishedAt),
      ] as const satisfies readonly ExportCell[];
      if (version.lines.length === 0) {
        rows.push([...versionCells, empty, empty, empty, textCell(version.currency)]);
        continue;
      }
      for (const line of version.lines) {
        rows.push([
          ...versionCells,
          textCell(line.vehicleClassName),
          { kind: 'text', value: translate(`common.modalities.${line.modality}`) },
          moneyCell(line.unitAmount, version.currency),
          textCell(version.currency),
        ]);
      }
    }
  }
  return {
    name: translate('export.sheetNames.rateCards'),
    headers: headers(translate, rateCardColumns),
    rows,
  };
}

export type ExportableAssignment = {
  readonly serviceName: string;
  readonly eventId: string;
  readonly projectId: string;
  readonly provider: { readonly name: string } | null;
  readonly vehicleClass: { readonly name: string } | null;
  readonly costCentre: { readonly name: string; readonly key: string } | null;
  readonly executionStatus: ExecutionStatus;
  readonly driverName?: string;
  readonly vehiclePlateOverride?: string;
  readonly dispatchedAt?: number;
  readonly completedAt?: number;
  readonly notes?: string;
  readonly currentRevision: {
    readonly quantity: number;
    readonly unitAmount: number;
    readonly currency: Currency;
    readonly lineTotal: number;
  } | null;
};

const assignmentColumns = [
  'export.columns.service',
  'export.columns.event',
  'export.columns.project',
  'export.columns.provider',
  'export.columns.vehicleClass',
  'export.columns.costCentre',
  'export.columns.quantity',
  'export.columns.unitAmount',
  'export.columns.lineTotal',
  'export.columns.currency',
  'export.columns.executionStatus',
  'export.columns.driver',
  'export.columns.vehiclePlate',
  'export.columns.dispatched',
  'export.columns.completed',
  'export.columns.notes',
] as const satisfies readonly ColumnKey[];

export function assignmentsSheet(
  assignments: readonly ExportableAssignment[],
  lookups: ExportLookups,
  translate: Translate,
): ExportSheetData {
  return {
    name: translate('export.sheetNames.assignments'),
    headers: headers(translate, assignmentColumns),
    rows: assignments.map((assignment) => {
      const revision = assignment.currentRevision;
      return [
        textCell(assignment.serviceName),
        lookupCell(assignment.eventId, lookups.eventNames),
        lookupCell(assignment.projectId, lookups.projectNames),
        textCell(assignment.provider?.name),
        textCell(assignment.vehicleClass?.name),
        textCell(assignment.costCentre?.name),
        // An assignment with no accepted revision has no agreed money. Zeros
        // here would state a price the record does not carry.
        revision === null ? empty : numberCell(revision.quantity),
        revision === null ? empty : moneyCell(revision.unitAmount, revision.currency),
        revision === null ? empty : moneyCell(revision.lineTotal, revision.currency),
        revision === null ? empty : textCell(revision.currency),
        { kind: 'text', value: translate(executionStatusTokens[assignment.executionStatus].labelKey) },
        textCell(assignment.driverName),
        textCell(assignment.vehiclePlateOverride),
        optionalInstantCell(assignment.dispatchedAt),
        optionalInstantCell(assignment.completedAt),
        textCell(assignment.notes),
      ];
    }),
  };
}

export type ExportableAssignmentRevision = {
  readonly serviceName: string;
  readonly providerName: string;
  readonly vehicleClassName: string;
  readonly modality: RateModality;
  readonly revisionNumber: number;
  readonly status: AssignmentRevisionStatus;
  readonly quantity: number;
  readonly unitAmount: number;
  readonly currency: Currency;
  readonly lineTotal: number;
  readonly acceptedAt?: number;
  readonly declinedReason?: string;
};

const assignmentRevisionColumns = [
  'export.columns.service',
  'export.columns.provider',
  'export.columns.vehicleClass',
  'export.columns.modality',
  'export.columns.revisionNumber',
  'export.columns.revisionStatus',
  'export.columns.quantity',
  'export.columns.unitAmount',
  'export.columns.lineTotal',
  'export.columns.currency',
  'export.columns.acceptedAt',
  'export.columns.declinedReason',
] as const satisfies readonly ColumnKey[];

export function assignmentRevisionsSheet(
  revisions: readonly ExportableAssignmentRevision[],
  translate: Translate,
): ExportSheetData {
  return {
    name: translate('export.sheetNames.assignmentRevisions'),
    headers: headers(translate, assignmentRevisionColumns),
    rows: revisions.map((revision) => [
      textCell(revision.serviceName),
      textCell(revision.providerName),
      textCell(revision.vehicleClassName),
      { kind: 'text', value: translate(`common.modalities.${revision.modality}`) },
      { kind: 'number', value: revision.revisionNumber },
      { kind: 'text', value: translate(assignmentRevisionStatusTokens[revision.status].labelKey) },
      numberCell(revision.quantity),
      moneyCell(revision.unitAmount, revision.currency),
      moneyCell(revision.lineTotal, revision.currency),
      textCell(revision.currency),
      optionalInstantCell(revision.acceptedAt),
      textCell(revision.declinedReason),
    ]),
  };
}

/** The header row plus the data rows, ready for `toSheetCell`. */
export function sheetCells(sheet: ExportSheetData): readonly (readonly ExportCell[])[] {
  return [sheet.headers.map((header) => ({ kind: 'text', value: header }) as const), ...sheet.rows];
}
