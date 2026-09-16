import { executionStatusTransitions } from '@priamo/convex/assignments/execution';

import { roleAtLeast, type Role } from './roles';
import type { AssignmentRevisionStatus, ExecutionStatus } from './status';

/**
 * Display-only affordances, never authorization. The backend authority is
 * `memberRoleForCapability` in `convex/lib/capabilityFloors.ts`, together with each
 * Assignment mutation's `requireAssignmentAccess` / `requireRevisionAccess` gate.
 */
export type AssignmentActor = { kind: 'member'; role: Role } | { kind: 'provider' };

export type AssignmentAction =
  | 'addAssignment'
  | 'reprice'
  | 'removeAssignment'
  | 'acceptTerms'
  | 'declineTerms'
  | 'counterTerms'
  | 'transitionExecution';

export type AssignmentActionContext = {
  serviceWritable: boolean;
  hasRevisionHistory: boolean;
  revision: {
    status: AssignmentRevisionStatus;
    proposedOnBehalfOfProviderId?: string | undefined;
  } | null;
  executionStatus: ExecutionStatus;
};

/** Mirrors the backend's exported `memberRoleForCapability`; that table is authoritative. */
export const assignmentMemberCapabilityFloors = Object.freeze({
  readAssignment: 'viewer',
  readAssignmentPricing: 'planner',
  writeAssignmentTerms: 'planner',
  respondToTerms: 'planner',
  writeExecution: 'operator',
} as const satisfies Readonly<Record<
  'readAssignment' | 'readAssignmentPricing' | 'writeAssignmentTerms' | 'respondToTerms' | 'writeExecution',
  Role
>>);

export function assignmentActions(
  actor: AssignmentActor,
  context: AssignmentActionContext,
): ReadonlySet<AssignmentAction> {
  const actions = new Set<AssignmentAction>();
  const mayWriteTerms = actor.kind === 'member' &&
    roleAtLeast(actor.role, assignmentMemberCapabilityFloors.writeAssignmentTerms);
  const mayRespond = actor.kind === 'provider' ||
    roleAtLeast(actor.role, assignmentMemberCapabilityFloors.respondToTerms);
  const mayExecute = actor.kind === 'provider' ||
    roleAtLeast(actor.role, assignmentMemberCapabilityFloors.writeExecution);

  if (context.serviceWritable && mayWriteTerms) {
    actions.add('addAssignment');
    if (context.revision !== null) actions.add('reprice');
    if (!context.hasRevisionHistory) actions.add('removeAssignment');
  }

  if (context.serviceWritable && context.revision?.status === 'draft' && mayRespond) {
    if (actor.kind === 'member' || context.revision.proposedOnBehalfOfProviderId === undefined) {
      actions.add('acceptTerms');
    }
    actions.add('declineTerms');
    if (actor.kind === 'provider') actions.add('counterTerms');
  }

  if (mayExecute && executionStatusTransitions[context.executionStatus].length > 0) {
    actions.add('transitionExecution');
  }
  return actions;
}
