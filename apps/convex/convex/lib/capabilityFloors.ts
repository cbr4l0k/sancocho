import type { Role } from './roles';

/**
 * Every capability a Provider grant confers. It is a SET, not a ladder: nothing
 * here implies anything else here, and `roleAtLeast` must never be applied to
 * it.
 *
 * There is deliberately no `readProject`, no `readOtherAssignments` and no
 * `readRates` — see docs/provider-access.md "What a Provider MAY NOT see".
 * Adding a member is a reviewed security change with tests, never configuration.
 */
export type Capability =
  | 'readAssignment'
  | 'writeExecution'
  | 'respondToTerms'
  | 'readLinkedServiceProjection';

/**
 * The complete gate vocabulary. Commercial Assignment authoring is member-only
 * until #88 adds Provider response actions, so it is intentionally not part of
 * the Provider grant's closed `Capability` set.
 *
 * `readAssignmentPricing` (#74) is the second member-only intent. It exists as
 * its own word rather than borrowing `writeAssignmentTerms` because it grants
 * something genuinely different: the ability to READ a published rate before
 * committing to it. Every other public rate read floors at `admin`, since the
 * Rate Card catalogue is organization configuration — but the console cannot
 * obey "resolve and display the Rate live, and never let the user type it"
 * unless the role that authors Assignments can also see one. Naming the intent
 * separately is what keeps that widening visible in `docs/authorization.md`
 * instead of hiding inside a write intent. Today the two resolve identically —
 * both member-only, both `planner` — so no test can tell them apart; the
 * separation exists so the pricing floor can move without dragging authoring
 * with it.
 */
export type ProjectIntent = Capability | 'writeAssignmentTerms' | 'readAssignmentPricing';

/**
 * The member arm's translation of the same intents into the OTHER vocabulary —
 * the role ladder. The two axes never compose (a provider's rank in its own
 * Organization is not an argument about somebody else's project, and a
 * coordinator's role is not a capability); this map is simply how a coordinator
 * member's ranked role answers the same question the grant answers by
 * enumeration.
 *
 * Reading and responding mirror the floors the rest of the codebase already
 * uses: viewers read, operators run what is planned (`changeServiceStatus`),
 * planners author commercial intent.
 */
export const memberRoleForCapability: Readonly<Record<ProjectIntent, Role>> = Object.freeze({
  readAssignment: 'viewer',
  writeAssignmentTerms: 'planner',
  // Deliberately the same floor as authoring, because the two are one action
  // split across a round trip: a planner who may commit a price may see it.
  readAssignmentPricing: 'planner',
  readLinkedServiceProjection: 'viewer',
  writeExecution: 'operator',
  respondToTerms: 'planner',
});
