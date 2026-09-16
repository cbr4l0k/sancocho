import { expect, test } from 'bun:test';

import { executionSubmitProblem } from './assignment-execution';

test('blocks every invalid execution submission instead of bypassing the submit gate', () => {
  expect(executionSubmitProblem({ status: 'assigned' })).toEqual({ kind: 'vehicle' });
  expect(executionSubmitProblem({ status: 'confirmed', vehiclePlateOverride: 'ABC-123' }))
    .toEqual({ kind: 'driver' });
  expect(executionSubmitProblem({ status: 'notExecuted', notExecutedReason: '  ' }))
    .toEqual({ kind: 'notExecutedReason' });
});

test('requires exactly one vehicle source for a vehicle-bearing status', () => {
  expect(executionSubmitProblem({ status: 'assigned' })).toEqual({ kind: 'vehicle' });
  expect(executionSubmitProblem({
    status: 'assigned',
    fleetVehicleId: 'fleet-1',
    vehiclePlateOverride: 'ABC-123',
  })).toEqual({ kind: 'vehicle' });
  expect(executionSubmitProblem({ status: 'assigned', fleetVehicleId: 'fleet-1' })).toBeUndefined();
  expect(executionSubmitProblem({ status: 'assigned', vehiclePlateOverride: ' ABC-123 ' })).toBeUndefined();
});

test('requires a nonblank driver name when confirming execution', () => {
  expect(executionSubmitProblem({ status: 'confirmed', vehiclePlateOverride: 'ABC-123' }))
    .toEqual({ kind: 'driver' });
  expect(executionSubmitProblem({
    status: 'confirmed',
    vehiclePlateOverride: 'ABC-123',
    driverName: '  ',
  })).toEqual({ kind: 'driver' });
  expect(executionSubmitProblem({
    status: 'confirmed',
    vehiclePlateOverride: 'ABC-123',
    driverName: 'Sam',
  })).toBeUndefined();
});

test('requires a trimmed not-executed reason within the backend bound', () => {
  expect(executionSubmitProblem({ status: 'notExecuted', notExecutedReason: '  ' }))
    .toEqual({ kind: 'notExecutedReason' });
  expect(executionSubmitProblem({ status: 'notExecuted', notExecutedReason: 'x'.repeat(1001) }))
    .toEqual({ kind: 'notExecutedReason' });
  expect(executionSubmitProblem({ status: 'notExecuted', notExecutedReason: 'Traffic' }))
    .toBeUndefined();
});

test('does not require execution details when returning to unassigned', () => {
  expect(executionSubmitProblem({ status: 'unassigned' })).toBeUndefined();
});
