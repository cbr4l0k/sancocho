import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const updateOrganization = api.organizations.mutations.updateOrganization;
const addMember = api.organizations.mutations.addMember;
const changeMemberRole = api.organizations.mutations.changeMemberRole;
const removeMember = api.organizations.mutations.removeMember;
const getOrganization = api.organizations.queries.getOrganization;
const listMembers = api.organizations.queries.listMembers;

const NOT_FOUND_OR_INACCESSIBLE = 'Not found or inaccessible';
const CONFLICT = 'Conflict';
const UNAUTHENTICATED = 'Unauthenticated';
const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 10, cursor: null };

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: ReturnType<typeof convexTest>, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(ensureUser, {});
  return { client, userId };
}

test('createOrganization creates the organization, owner membership, and audits atomically', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');

  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'acme' });
  await t.run(async (ctx) => {
    const organization = await ctx.db.get(organizationId);
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', owner.userId))
      .unique();
    const audits = await ctx.db.query('auditEvents').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    expect(organization).toMatchObject({ name: 'Acme', slug: 'acme' });
    expect(membership).toMatchObject({ role: 'owner' });
    expect(audits.map((audit) => audit.action).sort()).toEqual(['membership.created', 'organization.created']);
  });

  await expect(owner.client.mutation(createOrganization, { name: 'Other', slug: 'acme' })).rejects.toMatchObject({
    data: CONFLICT,
  });
});

test('cross-organization access and fabricated organization IDs return the same generic error', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const orgA = await owner.client.mutation(createOrganization, { name: 'A', slug: 'org-a' });
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'org-b' });
  await owner.client.mutation(addMember, { organizationId: orgA, userId: member.userId, role: 'viewer' });
  const missingOrganizationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', { name: 'Temporary', slug: 'temporary-org' });
    await ctx.db.delete(id);
    return id;
  });

  for (const organizationId of [orgB, missingOrganizationId]) {
    await expect(member.client.query(getOrganization, { organizationId })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
    await expect(member.client.mutation(updateOrganization, { organizationId, name: 'Nope' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
    await expect(member.client.mutation(addMember, { organizationId, userId: owner.userId, role: 'viewer' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
    await expect(
      member.client.query(listMembers, { organizationId, paginationOpts: firstPage }),
    ).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  }
});

test('viewer cannot update and planner cannot add members', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const viewer = await provision(t, 'viewer');
  const planner = await provision(t, 'planner');
  const target = await provision(t, 'target');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'roles-org' });
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });

  await expect(viewer.client.mutation(updateOrganization, { organizationId, name: 'Nope' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(planner.client.mutation(addMember, { organizationId, userId: target.userId, role: 'viewer' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
});

test('duplicate memberships are rejected without disclosing the existing membership', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'duplicates-org' });
  await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'viewer' });

  await expect(owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'admin' })).rejects.toMatchObject({ data: CONFLICT });
});

test('the final owner cannot be demoted or removed, while a second owner can', async () => {
  const t = convexTest(schema, modules);
  const firstOwner = await provision(t, 'first-owner');
  const secondOwner = await provision(t, 'second-owner');
  const organizationId = await firstOwner.client.mutation(createOrganization, { name: 'Acme', slug: 'owners-org' });
  const firstMembershipId = await t.run(async (ctx) => {
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', firstOwner.userId))
      .unique();
    if (membership === null) throw new Error('Expected owner membership');
    return membership._id;
  });

  await expect(firstOwner.client.mutation(changeMemberRole, { membershipId: firstMembershipId, role: 'admin' })).rejects.toMatchObject({ data: CONFLICT });
  await expect(firstOwner.client.mutation(removeMember, { membershipId: firstMembershipId })).rejects.toMatchObject({ data: CONFLICT });

  const secondMembershipId = await firstOwner.client.mutation(addMember, { organizationId, userId: secondOwner.userId, role: 'owner' });
  await firstOwner.client.mutation(changeMemberRole, { membershipId: secondMembershipId, role: 'admin' });
  await firstOwner.client.mutation(changeMemberRole, { membershipId: secondMembershipId, role: 'owner' });
  await firstOwner.client.mutation(removeMember, { membershipId: secondMembershipId });
});

test('membership mutations are indistinguishable for unauthenticated probes (I9)', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'probe-org' });
  const realMembershipId = await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'viewer' });
  const fakeMembershipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizationMemberships', { organizationId, userId: member.userId, role: 'viewer' });
    await ctx.db.delete(id);
    return id;
  });

  // Unauthenticated: identical error for real and fabricated ids.
  for (const membershipId of [realMembershipId, fakeMembershipId]) {
    await expect(t.mutation(changeMemberRole, { membershipId, role: 'admin' })).rejects.toMatchObject({ data: UNAUTHENTICATED });
    await expect(t.mutation(removeMember, { membershipId })).rejects.toMatchObject({ data: UNAUTHENTICATED });
  }

  // Authenticated non-member: identical generic error for real and fabricated ids.
  const outsider = await provision(t, 'outsider');
  for (const membershipId of [realMembershipId, fakeMembershipId]) {
    await expect(outsider.client.mutation(changeMemberRole, { membershipId, role: 'admin' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
    await expect(outsider.client.mutation(removeMember, { membershipId })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  }
});

test('listMyOrganizations only returns the caller memberships', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const orgA = await owner.client.mutation(createOrganization, { name: 'A', slug: 'mine-a' });
  await owner.client.mutation(createOrganization, { name: 'B', slug: 'not-mine-b' });
  await owner.client.mutation(addMember, { organizationId: orgA, userId: member.userId, role: 'viewer' });

  const mine = await member.client.query(api.organizations.queries.listMyOrganizations, {});
  expect(mine).toHaveLength(1);
  expect(mine[0]?.organization._id).toBe(orgA);
  expect(mine[0]?.role).toBe('viewer');
});

test('viewer can read organization and paginated member roster', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const viewer = await provision(t, 'viewer');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'read-org' });
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });

  await expect(viewer.client.query(getOrganization, { organizationId })).resolves.toMatchObject({ slug: 'read-org' });
  const roster = await viewer.client.query(listMembers, { organizationId, paginationOpts: { numItems: 1, cursor: null } });
  expect(roster.page).toHaveLength(1);
  expect(roster.isDone).toBe(false);
  const rest = await viewer.client.query(listMembers, { organizationId, paginationOpts: { numItems: 10, cursor: roster.continueCursor } });
  expect(rest.page).toHaveLength(1);
  expect(rest.isDone).toBe(true);
});

test('role changes audit previous and new role', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'audit-org' });
  const membershipId = await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'viewer' });
  await owner.client.mutation(changeMemberRole, { membershipId, role: 'planner' });

  await t.run(async (ctx) => {
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'membership').eq('entityId', membershipId))
      .collect();
    expect(audits.map((a) => a.action)).toContain('membership.updated');
    const update = audits.find((a) => a.action === 'membership.updated');
    expect(update?.metadata).toMatchObject({ previousRole: 'viewer', role: 'planner' });
  });
});

test('only an owner can grant the owner role', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const admin = await provision(t, 'admin');
  const target = await provision(t, 'target');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'grant-owner-org' });
  await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });

  await expect(admin.client.mutation(addMember, { organizationId, userId: target.userId, role: 'owner' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  const targetMembershipId = await owner.client.mutation(addMember, { organizationId, userId: target.userId, role: 'viewer' });

  // The changeMemberRole path enforces the same policy: admins can neither
  // promote to owner nor touch an existing owner's membership.
  await expect(admin.client.mutation(changeMemberRole, { membershipId: targetMembershipId, role: 'owner' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  const ownerMembershipId = await t.run(async (ctx) => {
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', owner.userId))
      .unique();
    if (membership === null) throw new Error('Expected owner membership');
    return membership._id;
  });
  await expect(admin.client.mutation(changeMemberRole, { membershipId: ownerMembershipId, role: 'admin' })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(admin.client.mutation(removeMember, { membershipId: ownerMembershipId })).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });

  await expect(owner.client.mutation(changeMemberRole, { membershipId: targetMembershipId, role: 'owner' })).resolves.toBeNull();
});
