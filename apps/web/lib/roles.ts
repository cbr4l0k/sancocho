import type { roleValidator } from '@priamo/convex/validators';

export type Role = typeof roleValidator.type;

/**
 * Display-only UX affordance, never an authorization decision. The backend is
 * the sole authority for permission checks; hiding UI does not protect data.
 */
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

export const roleLabelKey = {
  owner: 'vocab.roles.owner',
  admin: 'vocab.roles.admin',
  planner: 'vocab.roles.planner',
  operator: 'vocab.roles.operator',
  viewer: 'vocab.roles.viewer',
} as const satisfies Record<Role, `vocab.roles.${Role}`>;
