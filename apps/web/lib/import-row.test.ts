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

const fieldDefinitionId = fixtureId('fieldDefinitions', 'field-definition-id');
const eventId = fixtureId('events', 'event-id');
const serviceKindVersionId = fixtureId('serviceKindVersions', 'service-kind-version-id');
const providerId = fixtureId('providers', 'provider-id');
const costCentreId = fixtureId('costCentres', 'cost-centre-id');
const vehicleClassId = fixtureId('vehicleClasses', 'vehicle-class-id');
const serviceId = fixtureId('services', 'service-id');
const assignmentId = fixtureId('assignments', 'assignment-id');
const revisionId = fixtureId('assignmentRevisions', 'revision-id');

// Named separately so the argument assertion can name the FRESH ids directly, and
// so they visibly differ from the stale ones the plan carries.
const resolvedVersionId = fixtureId('rateCardVersions', 'rate-card-version-id');
const resolvedLineId = fixtureId('rateLines', 'rate-line-id');

const resolvedRate: RateLookupResult = {
  kind: 'resolved',
  rateCardId: fixtureId('rateCards', 'rate-card-id'),
  rateCardName: 'Standard',
  rateCardVersionId: resolvedVersionId,
  rateLineId: resolvedLineId,
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
    service: {
      name: 'Airport transfer',
      startsAt: 1_700_000_000_000,
      endsAt: 1_700_003_600_000,
      values: [{ fieldDefinitionId: 'planned-field', value: { kind: 'number', value: 12 } }],
    },
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
    fieldDefinitionIds: new Map([['planned-field', fieldDefinitionId]]),
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

  test('sends each mutation exactly the arguments the row resolved to', async () => {
    const recorded = recordingMutations();

    await importRow(recorded.mutations, input());

    // Exact objects, not a key-name heuristic. This is the I10 guard: `toEqual` fails
    // on ANY extra key, so a money figure cannot ride along under an innocuous name —
    // a spelling regex let `{ note: unitAmount }` through and passed.
    expect(recorded.serviceArgs[0]).toEqual({
      eventId,
      serviceKindVersionId,
      name: 'Airport transfer',
      startsAt: 1_700_000_000_000,
      endsAt: 1_700_003_600_000,
      values: [{ fieldDefinitionId, value: { kind: 'number', value: 12 } }],
    });
    expect(recorded.assignmentArgs[0]).toEqual({
      serviceId,
      providerId,
      position: 2,
      costCentreId,
    });
    // The rate ids come from the FRESH lookup, never from the plan built during the
    // preview: the fixtures deliberately disagree, so sourcing them from
    // `row.assignment.revision` would commit a price from a possibly-retired Version.
    expect(recorded.revisionArgs[0]).toEqual({
      assignmentId,
      vehicleClassId,
      modality: 'transfer',
      quantity: 3,
      rateCardVersionId: resolvedVersionId,
      rateLineId: resolvedLineId,
    });
    expect(recorded.acceptanceArgs[0]).toEqual({ revisionId });
  });

  test('refuses to write a revision when the rate is ambiguous', async () => {
    const recorded = recordingMutations();
    const ambiguous: RateLookupResult = { kind: 'ambiguous', candidates: [] };

    // The row still carries a planned revision; only the server's answer changed.
    const outcome = await importRow(recorded.mutations, input(plannedRow(), ambiguous));

    expect(recorded.calls).toEqual(['createService', 'createAssignment']);
    expect(recorded.revisionArgs).toHaveLength(0);
    expect(outcome).toEqual({
      kind: 'failedRevision', rowNumber: 7, step: 'revision', errorKey: 'errors.generic',
    });
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
