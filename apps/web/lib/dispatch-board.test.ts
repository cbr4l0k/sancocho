import { describe, expect, test } from 'bun:test';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

import { api } from '@priamo/convex/api';

import {
  coordinatorDispatchArgs,
  dispatchDayReadinessArgs,
  dispatchSheetCompleteness,
  groupProviderDispatch,
  providerDispatchArgs,
  readinessDisplay,
  visibleCoordinatorDispatchEntries,
} from './dispatch-board';

type CoordinatorArgs = FunctionArgs<typeof api.assignments.queries.listDispatchDay>;
type ProviderArgs = FunctionArgs<typeof api.assignments.queries.listProviderDispatchDay>;
type ProviderEntry = FunctionReturnType<typeof api.assignments.queries.listProviderDispatchDay>['page'][number];

function providerEntry(serviceNumber: number, startsAt: number, position: number): ProviderEntry {
  return {
    assignment: {
      _id: `assignment-${serviceNumber}-${position}` as ProviderEntry['assignment']['_id'],
      _creationTime: position,
      organizationId: 'organization-id' as ProviderEntry['assignment']['organizationId'],
      serviceId: `service-${serviceNumber}` as ProviderEntry['assignment']['serviceId'],
      projectId: 'project-id' as ProviderEntry['assignment']['projectId'],
      providerId: 'provider-id' as ProviderEntry['assignment']['providerId'],
      position,
      executionStatus: 'assigned',
    },
    service: {
      _id: `service-${serviceNumber}` as ProviderEntry['service']['_id'],
      startsAt,
    },
    serviceProjection: [],
  };
}

describe('dispatch query arguments', () => {
  test('passes every coordinator filter to the backend query', () => {
    const projectId = 'project-id' as CoordinatorArgs['projectId'];
    const eventId = 'event-id' as NonNullable<CoordinatorArgs['eventId']>;
    const providerId = 'provider-id' as NonNullable<CoordinatorArgs['providerId']>;
    const costCentreId = 'cost-centre-id' as NonNullable<CoordinatorArgs['costCentreId']>;
    expect(coordinatorDispatchArgs(projectId, { from: 100, to: 200 }, {
      eventId,
      status: 'confirmed',
      providerId,
      costCentreId,
    })).toStrictEqual({ projectId, from: 100, to: 200, eventId, status: 'confirmed', providerId, costCentreId });
  });

  test('omits inactive coordinator filters from the backend query', () => {
    const projectId = 'project-id' as CoordinatorArgs['projectId'];
    const args = coordinatorDispatchArgs(projectId, { from: 100, to: 200 }, {});
    expect(args).toStrictEqual({ projectId, from: 100, to: 200 });
    expect('eventId' in args).toBe(false);
    expect('status' in args).toBe(false);
    expect('providerId' in args).toBe(false);
    expect('costCentreId' in args).toBe(false);
  });

  test('passes an active Provider status filter to the backend query', () => {
    const projectId = 'project-id' as ProviderArgs['projectId'];
    expect(providerDispatchArgs(projectId, { from: 100, to: 200 }, { status: 'confirmed' }))
      .toStrictEqual({ projectId, from: 100, to: 200, status: 'confirmed' });
  });

  test('omits an inactive Provider status filter from the backend query', () => {
    const projectId = 'project-id' as ProviderArgs['projectId'];
    const args = providerDispatchArgs(projectId, { from: 100, to: 200 }, { status: undefined });
    expect(args).toStrictEqual({ projectId, from: 100, to: 200 });
    expect('status' in args).toBe(false);
  });

  test('builds readiness arguments from the same day and optional Event filter', () => {
    const projectId = 'project-id' as CoordinatorArgs['projectId'];
    const eventId = 'event-id' as NonNullable<CoordinatorArgs['eventId']>;
    expect(dispatchDayReadinessArgs(projectId, { from: 100, to: 200 }, { eventId }))
      .toStrictEqual({ projectId, from: 100, to: 200, eventId });
    const unfiltered = dispatchDayReadinessArgs(projectId, { from: 100, to: 200 }, {});
    expect(unfiltered).toStrictEqual({ projectId, from: 100, to: 200 });
    expect('eventId' in unfiltered).toBe(false);
  });
});

test('only an exhausted page set makes a dispatch sheet complete', () => {
  expect(dispatchSheetCompleteness('Exhausted')).toEqual({ kind: 'complete' });
  expect(dispatchSheetCompleteness('CanLoadMore')).toEqual({ kind: 'loadedOnly' });
  expect(dispatchSheetCompleteness('LoadingMore')).toEqual({ kind: 'loadedOnly' });
  expect(dispatchSheetCompleteness('LoadingFirstPage')).toEqual({ kind: 'loadedOnly' });
});

test('coordinator projection removes Services with no rows after filtering', () => {
  const visible = { service: 'visible', rows: [{ assignment: 'one' }] };
  const hidden = { service: 'hidden', rows: [] };
  expect(visibleCoordinatorDispatchEntries([hidden, visible])).toEqual([visible]);
});

test('incomplete readiness is structurally rendered as a lower bound', () => {
  expect(readinessDisplay({ unassigned: 7, complete: false })).toEqual({ kind: 'atLeast', count: 7 });
  expect(readinessDisplay({ unassigned: 7, complete: true })).toEqual({ kind: 'exact', count: 7 });
});

test('flat Provider pages merge repeated Services and order the loaded set by time', () => {
  const laterFirstPage = providerEntry(2, 200, 0);
  const earlierFirstPage = providerEntry(1, 100, 1);
  const earlierSecondPage = providerEntry(1, 100, 2);
  const groups = groupProviderDispatch([laterFirstPage, earlierFirstPage, earlierSecondPage]);

  expect(groups.map((group) => group.service.startsAt)).toEqual([100, 200]);
  expect(groups[0]?.entries.map((entry) => entry.assignment.position)).toEqual([1, 2]);
  expect(groups[1]?.entries.map((entry) => entry.assignment.position)).toEqual([0]);
});
