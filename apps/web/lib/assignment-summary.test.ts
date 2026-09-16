import { expect, test } from 'bun:test';

import {
  assignmentSummary,
  serviceTotals,
  type AssignmentPanelRow,
} from './assignment-summary';

type Revision = NonNullable<AssignmentPanelRow['latestRevision']>;

function revision(
  revisionNumber: number,
  status: Revision['status'],
  currency: Revision['currency'],
  lineTotal: number,
): Revision {
  return {
    _id: `revision-${revisionNumber}` as Revision['_id'],
    _creationTime: revisionNumber,
    organizationId: 'organization-1' as Revision['organizationId'],
    assignmentId: 'assignment-1' as Revision['assignmentId'],
    revisionNumber,
    status,
    vehicleClassId: 'class-1' as Revision['vehicleClassId'],
    modality: 'fixed',
    quantity: 1,
    rateCardVersionId: 'rate-version-1' as Revision['rateCardVersionId'],
    rateLineId: 'rate-line-1' as Revision['rateLineId'],
    unitAmount: lineTotal,
    currency,
    lineTotal,
  };
}

function row(currentRevision: Revision | null, latestRevision: Revision | null): AssignmentPanelRow {
  return {
    assignment: {
      _id: 'assignment-1' as AssignmentPanelRow['assignment']['_id'],
      _creationTime: 1,
      organizationId: 'organization-1' as AssignmentPanelRow['assignment']['organizationId'],
      serviceId: 'service-1' as AssignmentPanelRow['assignment']['serviceId'],
      projectId: 'project-1' as AssignmentPanelRow['assignment']['projectId'],
      providerId: 'provider-1' as AssignmentPanelRow['assignment']['providerId'],
      position: 0,
      executionStatus: 'unassigned',
    },
    currentRevision,
    latestRevision,
    provider: {
      _id: 'provider-1' as NonNullable<AssignmentPanelRow['provider']>['_id'],
      name: 'Ruta Uno',
      status: 'active',
    },
    vehicleClass: {
      _id: 'class-1' as NonNullable<AssignmentPanelRow['vehicleClass']>['_id'],
      name: 'Bus',
      status: 'active',
    },
    costCentre: null,
  };
}

test('only currentRevision can make terms agreed', () => {
  const acceptedLookingLatest = revision(3, 'accepted', 'COP', 45_000);
  expect(assignmentSummary(row(null, acceptedLookingLatest))).toEqual({
    kind: 'proposed',
    status: 'accepted',
    terms: {
      vehicleClassName: 'Bus',
      modality: 'fixed',
      quantity: 1,
      unitAmount: 45_000,
      currency: 'COP',
      lineTotal: 45_000,
    },
  });
});

test('a latest draft is explicit proposed terms and an empty row is unpriced', () => {
  expect(assignmentSummary(row(null, revision(2, 'draft', 'USD', 20_00))).kind).toBe('proposed');
  expect(assignmentSummary(row(null, null))).toEqual({ kind: 'unpriced' });
});

test('running totals split currencies and exclude every non-current draft', () => {
  const copA = revision(1, 'accepted', 'COP', 10_000);
  const copB = revision(2, 'accepted', 'COP', 25_000);
  const usd = revision(1, 'accepted', 'USD', 30_00);
  const draft = revision(3, 'draft', 'COP', 999_999);
  expect(serviceTotals([
    row(copA, copA), row(copB, copB), row(usd, usd), row(null, draft),
  ])).toEqual([
    { currency: 'COP', minorUnits: 35_000 },
    { currency: 'USD', minorUnits: 30_00 },
  ]);
});
