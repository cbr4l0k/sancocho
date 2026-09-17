import { describe, expect, test } from 'bun:test';
import { ConvexError } from 'convex/values';

import { importRow, type ImportRowInput, type ImportRowMutations } from './import-row';
import type { RateLookupResult } from './rate-lookup-result';
import type { PlannedAssignment, PlannedRow } from './workbook-plan';

type CreateServiceArgs = Parameters<ImportRowMutations['createService']>[0];
type CreateAssignmentArgs = Parameters<ImportRowMutations['createAssignment']>[0];
type CreateRevisionArgs = Parameters<ImportRowMutations['createRevision']>[0];
type AcceptRevisionArgs = Parameters<ImportRowMutations['acceptRevision']>[0];

function fixtureId<TableName extends string>(tableName: TableName, value: string): string & { __tableName: TableName } {
  return Object.assign(value, { __tableName: tableName });
}

const eventId = fixtureId('events', 'event-id');
const serviceKindVersionId = fixtureId('serviceKindVersions', 'service-kind-version-id');
const providerId = fixtureId('providers', 'provider-id');
const costCentreId = fixtureId('costCentres', 'cost-centre-id');
const vehicleClassId = fixtureId('vehicleClasses', 'vehicle-class-id');
const serviceId = fixtureId('services', 'service-id');
const assignmentId = fixtureId('assignments', 'assignment-id');
const revisionId = fixtureId('assignmentRevisions', 'revision-id');

const resolvedRate: RateLookupResult = {
  kind: 'resolved',
  rateCardId: fixtureId('rateCards', 'rate-card-id'),
  rateCardName: 'Standard',
  rateCardVersionId: fixtureId('rateCardVersions', 'rate-card-version-id'),
  rateLineId: fixtureId('rateLines', 'rate-line-id'),
  unitAmount: 125_00,
  currency: 'USD',
};

const unpriceableRate: RateLookupResult = { kind: 'unpriceable', reason: 'noRateLine' };

const pricedAssignment: PlannedAssignment = {
  create: { providerId: 'planned-provider', costCentreId: 'planned-cost-centre', position: 2 },
  revision: {
    vehicleClassId: 'planned-vehicle-class',
    modality: 'transfer',
    quantity: 3,
    rateCardVersionId: 'planned-rate-card-version',
    rateLineId: 'planned-rate-line',
  },
};

function plannedRow(assignment: PlannedAssignment | null = pricedAssignment): PlannedRow {
  return {
    rowNumber: 7,
    service: { name: 'Airport transfer', startsAt: 1_700_000_000_000, values: [] },
    ...(assignment === null ? {} : { assignment }),
    problems: [],
    unresolvedReferences: [],
    unresolvedOptions: [],
    defaultAction: 'create',
  };
}

function input(
  row: PlannedRow = plannedRow(),
  rateResult: RateLookupResult | undefined = resolvedRate,
): ImportRowInput {
  return {
    row,
    rateResult,
    eventId,
    serviceKindVersionId,
    fieldDefinitionIds: new Map(),
    providerIds: new Map([['planned-provider', providerId]]),
    vehicleClassIds: new Map([['planned-vehicle-class', vehicleClassId]]),
    costCentreIds: new Map([['planned-cost-centre', costCentreId]]),
  };
}

function recordingMutations(overrides: Partial<ImportRowMutations> = {}) {
  const calls: string[] = [];
  const serviceArgs: CreateServiceArgs[] = [];
  const assignmentArgs: CreateAssignmentArgs[] = [];
  const revisionArgs: CreateRevisionArgs[] = [];
  const acceptanceArgs: AcceptRevisionArgs[] = [];

  const mutations: ImportRowMutations = {
    createService: async (args) => {
      calls.push('createService');
      serviceArgs.push(args);
      return overrides.createService === undefined ? serviceId : overrides.createService(args);
    },
    createAssignment: async (args) => {
      calls.push('createAssignment');
      assignmentArgs.push(args);
      return overrides.createAssignment === undefined ? assignmentId : overrides.createAssignment(args);
    },
    createRevision: async (args) => {
      calls.push('createRevision');
      revisionArgs.push(args);
      return overrides.createRevision === undefined ? revisionId : overrides.createRevision(args);
    },
    acceptRevision: async (args) => {
      calls.push('acceptRevision');
      acceptanceArgs.push(args);
      return overrides.acceptRevision === undefined ? null : overrides.acceptRevision(args);
    },
  };

  return { mutations, calls, serviceArgs, assignmentArgs, revisionArgs, acceptanceArgs };
}

describe('importRow', () => {
  test('runs the happy priced path through all four mutations in order', async () => {
    const recorded = recordingMutations();

    const outcome = await importRow(recorded.mutations, input());

    expect(recorded.calls).toEqual([
      'createService',
      'createAssignment',
      'createRevision',
      'acceptRevision',
    ]);
    expect(outcome).toEqual({ kind: 'created', rowNumber: 7, assignment: 'priced' });
  });

  test('stops without further writes when Service creation fails', async () => {
    const recorded = recordingMutations({
      createService: async () => { throw new Error('service failed'); },
    });

    const outcome = await importRow(recorded.mutations, input());

    expect(recorded.calls).toEqual(['createService']);
    expect(outcome).toEqual({ kind: 'failedService', rowNumber: 7, errorKey: 'errors.generic' });
  });

  test('reports assignment creation failure as failedAssignment after creating the Service', async () => {
    const recorded = recordingMutations({
      createAssignment: async () => { throw new Error('assignment failed'); },
    });

    const outcome = await importRow(recorded.mutations, input());

    expect(recorded.calls).toEqual(['createService', 'createAssignment']);
    expect(outcome.kind).not.toBe('created');
    expect(outcome).toEqual({ kind: 'failedAssignment', rowNumber: 7, errorKey: 'errors.generic' });
  });

  test('reports revision creation failure at the revision step', async () => {
    const recorded = recordingMutations({
      createRevision: async () => { throw new Error('revision failed'); },
    });

    const outcome = await importRow(recorded.mutations, input());

    expect(recorded.calls).toEqual(['createService', 'createAssignment', 'createRevision']);
    expect(outcome).toEqual({
      kind: 'failedRevision', rowNumber: 7, step: 'revision', errorKey: 'errors.generic',
    });
  });

  test('reports acceptance failure at the acceptance step after the first three writes', async () => {
    const recorded = recordingMutations({
      acceptRevision: async () => { throw new Error('acceptance failed'); },
    });

    const outcome = await importRow(recorded.mutations, input());

    expect(recorded.calls).toEqual([
      'createService',
      'createAssignment',
      'createRevision',
      'acceptRevision',
    ]);
    expect(outcome).toEqual({
      kind: 'failedRevision', rowNumber: 7, step: 'acceptance', errorKey: 'errors.generic',
    });
  });

  test('does not create a revision or acceptance for an unpriceable rate', async () => {
    const recorded = recordingMutations();
    const unpricedAssignment: PlannedAssignment = {
      create: pricedAssignment.create,
      unpricedReason: 'noRate',
    };

    const outcome = await importRow(recorded.mutations, input(plannedRow(unpricedAssignment), unpriceableRate));

    expect(recorded.calls).toEqual(['createService', 'createAssignment']);
    expect(recorded.revisionArgs).toHaveLength(0);
    expect(recorded.acceptanceArgs).toHaveLength(0);
    expect(outcome).toEqual({ kind: 'created', rowNumber: 7, assignment: 'unpriced' });
  });

  test('creates only the Service when no assignment is mapped', async () => {
    const recorded = recordingMutations();

    const outcome = await importRow(recorded.mutations, input(plannedRow(null), undefined));

    expect(recorded.calls).toEqual(['createService']);
    expect(outcome).toEqual({ kind: 'created', rowNumber: 7, assignment: 'none' });
  });

  test('omits monetary values from assignment and revision mutation arguments', async () => {
    const recorded = recordingMutations();

    await importRow(recorded.mutations, input());

    const assignment = recorded.assignmentArgs[0];
    const revision = recorded.revisionArgs[0];
    if (assignment === undefined || revision === undefined) throw new Error('Expected both mutation arguments');
    // Any money-shaped key, not a fixed list: the server resolves and stores the
    // price from the published Rate Card Version (I10), so a figure arriving from the
    // workbook must never reach a mutation argument under ANY spelling.
    const moneyShaped = /amount|total|currency|price|rate$|minorUnits/iu;
    const offending = (args: object): string[] => Object.keys(args).filter((key) => moneyShaped.test(key));
    expect(offending(assignment)).toEqual([]);
    expect(offending(revision)).toEqual([]);
  });

  test('maps a structured backend failure to a message key without carrying raw prose', async () => {
    const recorded = recordingMutations({
      createAssignment: async () => {
        throw new ConvexError({ code: 'assignmentLimitExceeded', message: 'raw backend prose' });
      },
    });

    const outcome = await importRow(recorded.mutations, input());

    expect(outcome).toEqual({
      kind: 'failedAssignment', rowNumber: 7, errorKey: 'errors.assignmentLimitExceeded',
    });
    expect(JSON.stringify(outcome)).not.toContain('raw backend prose');
  });
});
