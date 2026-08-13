import type { roleValidator } from '../validators';

export type Role = typeof roleValidator.type;

/** Rank order owner > admin > planner > operator > viewer; all role policy derives from this map. */
const roleRank: Readonly<Record<Role, number>> = Object.freeze({
  owner: 0,
  admin: 1,
  planner: 2,
  operator: 3,
  viewer: 4,
});

export function roleAtLeast(actual: Role, required: Role): boolean {
  return roleRank[actual] <= roleRank[required];
}

export function isOwner(role: Role): boolean {
  return roleAtLeast(role, 'owner');
}

/**
 * Single statement of the ownership-assignment policy: any change that touches
 * the owner role — granting it, or altering/removing an existing owner —
 * requires the actor to be an owner. `targetCurrentRole` is undefined when
 * adding a new member.
 */
export function canAssignRole(
  actorRole: Role,
  targetCurrentRole: Role | undefined,
  targetNextRole: Role | undefined,
): boolean {
  const touchesOwner =
    (targetCurrentRole !== undefined && isOwner(targetCurrentRole)) ||
    (targetNextRole !== undefined && isOwner(targetNextRole));
  return touchesOwner ? isOwner(actorRole) : true;
}
