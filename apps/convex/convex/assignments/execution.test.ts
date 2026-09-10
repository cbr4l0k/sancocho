import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';

import {
  executionStatuses,
  executionStatusTransitions,
  transitionExecution,
  type ExecutionStatus,
  type ResultingExecutionFields,
} from './execution';

const validFields: ResultingExecutionFields = {
  serviceStatus: 'confirmed',
  vehiclePlateOverride: 'SUB 123',
  driverName: 'María Pérez',
  notExecutedReason: 'Provider unavailable',
};

function expectCode(run: () => unknown, codes: readonly string[]): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    expect(error.data).toMatchObject({ code: expect.stringMatching(new RegExp(`^(${codes.join('|')})$`)) });
    return;
  }
  throw new Error('Expected transition to be refused');
}

/**
 * The legal lifecycle, written down INDEPENDENTLY of the implementation.
 *
 * Deriving this from `executionStatusTransitions` — the obvious way to write an
 * exhaustive matrix test — makes the table its own oracle: any edit to the table
 * moves the expectation with it, so adding an illegal edge or deleting a legal
 * one changes nothing the test can see. Every entry below is therefore a
 * deliberate statement about the domain that someone has to edit on purpose.
 */
const expectedLegalTransitions: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  unassigned: ['assigned', 'notExecuted'],
  assigned: ['confirmed', 'unassigned', 'notExecuted'],
  confirmed: ['dispatched', 'assigned', 'notExecuted'],
  dispatched: ['completed', 'notExecuted'],
  completed: [],
  notExecuted: [],
};

describe('execution transition machine', () => {
  test('matches the independently declared lifecycle', () => {
    // Compared as sets so the table cannot gain or lose an edge unnoticed, and
    // so the two terminals stay terminal.
    for (const status of executionStatuses) {
      expect([...executionStatusTransitions[status]].sort())
        .toEqual([...expectedLegalTransitions[status]].sort());
    }
    expect([...executionStatuses].sort())
      .toEqual(Object.keys(expectedLegalTransitions).sort());
  });

  test('enumerates the full legal and illegal transition matrix', () => {
    for (const current of executionStatuses) {
      for (const next of executionStatuses) {
        const legal = expectedLegalTransitions[current].includes(next);
        if (legal) {
          expect(() => transitionExecution(current, next, validFields)).not.toThrow();
        } else {
          expectCode(
            () => transitionExecution(current, next, validFields),
            expectedLegalTransitions[current].length === 0
              ? ['assignmentExecutionTerminal']
              : ['assignmentExecutionStatusTransitionInvalid'],
          );
        }
      }
    }
  });

  test('refuses assigned without exactly one vehicle source', () => {
    expectCode(
      () => transitionExecution('unassigned', 'assigned', { serviceStatus: 'confirmed' }),
      ['assignmentExecutionVehicleInvalid'],
    );
    expectCode(
      () => transitionExecution('unassigned', 'assigned', {
        ...validFields,
        fleetVehicleId: 'vehicle',
      }),
      ['assignmentExecutionVehicleInvalid'],
    );
  });

  test('refuses confirmed without a driver name', () => {
    expectCode(
      () => transitionExecution('assigned', 'confirmed', {
        serviceStatus: 'confirmed',
        vehiclePlateOverride: 'SUB 123',
      }),
      ['assignmentExecutionDriverRequired'],
    );
  });

  test('requires a confirmed Service before dispatch', () => {
    for (const serviceStatus of ['draft', 'planned'] as const) {
      expectCode(
        () => transitionExecution('confirmed', 'dispatched', { ...validFields, serviceStatus }),
        ['assignmentExecutionServiceNotConfirmed'],
      );
    }
    for (const serviceStatus of ['confirmed', 'active', 'completed'] as const) {
      expect(() => transitionExecution('confirmed', 'dispatched', { ...validFields, serviceStatus })).not.toThrow();
    }
  });

  test('requires a non-empty bounded reason for not-executed terminal transitions', () => {
    for (const notExecutedReason of ['', '   ', 'x'.repeat(1001)]) {
      expectCode(
        () => transitionExecution('unassigned', 'notExecuted', {
          serviceStatus: 'draft',
          notExecutedReason,
        }),
        ['assignmentNotExecutedReasonInvalid'],
      );
    }
    expect(transitionExecution('unassigned', 'notExecuted', {
      serviceStatus: 'draft',
      notExecutedReason: '  Provider unavailable  ',
    }).notExecutedReason).toBe('Provider unavailable');
  });

  test('clears vehicle and driver fields on unassignment and driver fields on reassignment', () => {
    const unassigned = transitionExecution('assigned', 'unassigned', {
      ...validFields,
      driverPhone: '+57 300 000 0000',
    });
    expect(unassigned).toMatchObject({
      fleetVehicleId: undefined,
      vehiclePlateOverride: undefined,
      driverName: undefined,
      driverPhone: undefined,
    });
    const reassigned = transitionExecution('confirmed', 'assigned', {
      ...validFields,
      driverPhone: '+57 300 000 0000',
    });
    expect(reassigned).toMatchObject({ driverName: undefined, driverPhone: undefined });
    expect(reassigned.vehiclePlateOverride).toBe('SUB 123');
  });
});
