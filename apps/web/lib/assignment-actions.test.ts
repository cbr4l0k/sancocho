import { describe, expect, test } from 'bun:test';

import { memberRoleForCapability } from '@priamo/convex/capability-floors';

import {
  assignmentActions,
  assignmentMemberCapabilityFloors,
  type AssignmentActionContext,
  type AssignmentActor,
} from './assignment-actions';
import type { Role } from './roles';

const writableDraft: AssignmentActionContext = {
  serviceWritable: true,
  hasRevisionHistory: true,
  revision: { status: 'draft' },
  executionStatus: 'assigned',
};

function sorted(actor: AssignmentActor, context = writableDraft): string[] {
  return [...assignmentActions(actor, context)].sort();
}

describe('memberRoleForCapability mirrors', () => {
  test('console capability floors match the backend source of truth', () => {
    type ConsoleIntent = keyof typeof assignmentMemberCapabilityFloors;
    const consoleFloors: Readonly<Record<ConsoleIntent, Role>> = assignmentMemberCapabilityFloors;
    const backendFloors: Readonly<Record<ConsoleIntent, Role>> = {
      readAssignment: memberRoleForCapability.readAssignment,
      readAssignmentPricing: memberRoleForCapability.readAssignmentPricing,
      writeAssignmentTerms: memberRoleForCapability.writeAssignmentTerms,
      respondToTerms: memberRoleForCapability.respondToTerms,
      writeExecution: memberRoleForCapability.writeExecution,
    };
    expect(consoleFloors).toEqual(backendFloors);
  });
});

test('member roles expose exactly their capability combinations', () => {
  expect(sorted({ kind: 'member', role: 'viewer' })).toEqual([]);
  expect(sorted({ kind: 'member', role: 'operator' })).toEqual(['transitionExecution']);
  expect(sorted({ kind: 'member', role: 'planner' })).toEqual([
    'acceptTerms', 'addAssignment', 'declineTerms', 'reprice', 'transitionExecution',
  ]);
});

test('a member with execution capability sees no pricing or terms actions', () => {
  expect(sorted({ kind: 'member', role: 'operator' })).toEqual(['transitionExecution']);
});

test('terms actions do not reveal unrelated execution actions at a terminal state', () => {
  expect(sorted({ kind: 'member', role: 'planner' }, { ...writableDraft, executionStatus: 'completed' }))
    .toEqual(['acceptTerms', 'addAssignment', 'declineTerms', 'reprice']);
});

test('providers respond and counter but never see coordinator pricing actions', () => {
  expect(sorted({ kind: 'provider' })).toEqual([
    'acceptTerms', 'counterTerms', 'declineTerms', 'transitionExecution',
  ]);
  expect(sorted({ kind: 'provider' }, {
    ...writableDraft,
    revision: { status: 'draft', proposedOnBehalfOfProviderId: 'provider-1' },
  })).toEqual(['counterTerms', 'declineTerms', 'transitionExecution']);
});

test('only drafts can be answered and completed or not-executed rows cannot transition', () => {
  expect(sorted({ kind: 'provider' }, {
    ...writableDraft,
    revision: { status: 'declined' },
    executionStatus: 'notExecuted',
  })).toEqual([]);
});

test('remove is available only before negotiation history exists', () => {
  expect(sorted({ kind: 'member', role: 'planner' }, {
    ...writableDraft,
    hasRevisionHistory: false,
    revision: null,
  })).toEqual(['addAssignment', 'removeAssignment', 'transitionExecution']);
});

test('member gets exactly execution actions when the Service is not writable', () => {
  expect({
    member: sorted({ kind: 'member', role: 'planner' }, {
      ...writableDraft,
      serviceWritable: false,
      hasRevisionHistory: false,
    }),
  }).toEqual({ member: ['transitionExecution'] });
});

test('provider gets exactly execution actions when the Service is not writable', () => {
  expect({
    provider: sorted({ kind: 'provider' }, { ...writableDraft, serviceWritable: false }),
  }).toEqual({ provider: ['transitionExecution'] });
});
