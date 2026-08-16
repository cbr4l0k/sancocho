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
 * The minimum role that may change an organization's *configuration* — the
 * shared vocabulary the whole tenant then operates against: Field Definitions
 * and Locations.
 *
 * Stated once, here, rather than repeated as a `'admin'` literal at each call
 * site, so the policy is a single decision rather than eight independent ones.
 *
 * These are deliberately stricter than operational work. A planner runs
 * projects, services and recipes all day; a field definition they add is
 * permanent in a way a service is not (once a published version references it,
 * its key, semantic type and config are frozen for good — I2/I3), and a
 * location is referenced by field values across every project. Configuration is
 * therefore an administrator's decision, and operators compose what already
 * exists.
 */
export const organizationConfigurationRole: Role = 'admin';

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
