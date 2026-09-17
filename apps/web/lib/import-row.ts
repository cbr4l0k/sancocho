import type { FunctionArgs, FunctionReturnType } from 'convex/server';

import { api } from '@priamo/convex/api';

import { errorMessageKey, presentConvexError } from './convex-errors';
import type { ImportRowOutcome } from './import-run';
import type { RateLookupResult } from './rate-lookup-result';
import type { PlannedRow } from './workbook-plan';

type CreateServiceArgs = FunctionArgs<typeof api.services.mutations.createServiceFromServiceKind>;
type CreateAssignmentArgs = FunctionArgs<typeof api.assignments.mutations.createAssignment>;
type CreateRevisionArgs = FunctionArgs<typeof api.assignments.mutations.createAssignmentRevision>;
type AcceptRevisionArgs = FunctionArgs<typeof api.assignments.mutations.acceptAssignmentRevision>;

type ServiceId = FunctionReturnType<typeof api.services.mutations.createServiceFromServiceKind>;
type AssignmentId = FunctionReturnType<typeof api.assignments.mutations.createAssignment>;
type RevisionId = FunctionReturnType<typeof api.assignments.mutations.createAssignmentRevision>;
type AcceptRevisionResult = FunctionReturnType<typeof api.assignments.mutations.acceptAssignmentRevision>;

export type ImportRowMutations = {
  createService: (args: CreateServiceArgs) => Promise<ServiceId>;
  createAssignment: (args: CreateAssignmentArgs) => Promise<AssignmentId>;
  createRevision: (args: CreateRevisionArgs) => Promise<RevisionId>;
  acceptRevision: (args: AcceptRevisionArgs) => Promise<AcceptRevisionResult>;
};

export type ImportRowInput = {
  row: PlannedRow;
  rateResult: RateLookupResult | undefined;
  eventId: CreateServiceArgs['eventId'];
  serviceKindVersionId: CreateServiceArgs['serviceKindVersionId'];
  fieldDefinitionIds: ReadonlyMap<string, CreateServiceArgs['values'][number]['fieldDefinitionId']>;
  providerIds: ReadonlyMap<string, CreateAssignmentArgs['providerId']>;
  vehicleClassIds: ReadonlyMap<string, CreateRevisionArgs['vehicleClassId']>;
  costCentreIds: ReadonlyMap<string, NonNullable<CreateAssignmentArgs['costCentreId']>>;
};

export async function importRow(
  mutations: ImportRowMutations,
  input: ImportRowInput,
): Promise<ImportRowOutcome> {
  const { row } = input;
  if (row.service === undefined) {
    return { kind: 'failedService', rowNumber: row.rowNumber, errorKey: 'errors.generic' };
  }
  const values = row.service.values.flatMap((item) => {
    const fieldDefinitionId = input.fieldDefinitionIds.get(item.fieldDefinitionId);
    return fieldDefinitionId === undefined ? [] : [{ fieldDefinitionId, value: item.value }];
  });
  if (values.length !== row.service.values.length) {
    return { kind: 'failedService', rowNumber: row.rowNumber, errorKey: 'errors.generic' };
  }

  let serviceId: ServiceId;
  try {
    serviceId = await mutations.createService({
      eventId: input.eventId,
      serviceKindVersionId: input.serviceKindVersionId,
      name: row.service.name,
      startsAt: row.service.startsAt,
      ...(row.service.endsAt === undefined ? {} : { endsAt: row.service.endsAt }),
      values,
    });
  } catch (error) {
    return {
      kind: 'failedService',
      rowNumber: row.rowNumber,
      errorKey: errorMessageKey(presentConvexError(error)),
    };
  }

  if (row.assignment === undefined) {
    return { kind: 'created', rowNumber: row.rowNumber, assignment: 'none' };
  }
  const providerId = input.providerIds.get(row.assignment.create.providerId);
  const costCentreId = row.assignment.create.costCentreId === undefined
    ? undefined
    : input.costCentreIds.get(row.assignment.create.costCentreId);
  if (providerId === undefined ||
      (row.assignment.create.costCentreId !== undefined && costCentreId === undefined)) {
    return { kind: 'failedAssignment', rowNumber: row.rowNumber, errorKey: 'errors.generic' };
  }

  let assignmentId: AssignmentId;
  try {
    assignmentId = await mutations.createAssignment({
      serviceId,
      providerId,
      position: row.assignment.create.position,
      ...(costCentreId === undefined ? {} : { costCentreId }),
    });
  } catch (error) {
    return {
      kind: 'failedAssignment',
      rowNumber: row.rowNumber,
      errorKey: errorMessageKey(presentConvexError(error)),
    };
  }

  if (row.assignment.revision === undefined) {
    return { kind: 'created', rowNumber: row.rowNumber, assignment: 'unpriced' };
  }
  const vehicleClassId = input.vehicleClassIds.get(row.assignment.revision.vehicleClassId);
  if (vehicleClassId === undefined || input.rateResult?.kind !== 'resolved') {
    return { kind: 'failedRevision', rowNumber: row.rowNumber, step: 'revision', errorKey: 'errors.generic' };
  }

  let revisionId: RevisionId;
  try {
    revisionId = await mutations.createRevision({
      assignmentId,
      vehicleClassId,
      modality: row.assignment.revision.modality,
      quantity: row.assignment.revision.quantity,
      rateCardVersionId: input.rateResult.rateCardVersionId,
      rateLineId: input.rateResult.rateLineId,
    });
  } catch (error) {
    return {
      kind: 'failedRevision',
      rowNumber: row.rowNumber,
      step: 'revision',
      errorKey: errorMessageKey(presentConvexError(error)),
    };
  }
  try {
    await mutations.acceptRevision({ revisionId });
  } catch (error) {
    return {
      kind: 'failedRevision',
      rowNumber: row.rowNumber,
      step: 'acceptance',
      errorKey: errorMessageKey(presentConvexError(error)),
    };
  }
  return { kind: 'created', rowNumber: row.rowNumber, assignment: 'priced' };
}
