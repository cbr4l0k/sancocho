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
const createProject = api.projects.mutations.createProject;
const archiveProject = api.projects.mutations.archiveProject;
const createEvent = api.events.mutations.createEvent;
const updateEvent = api.events.mutations.updateEvent;

const NOT_FOUND_OR_INACCESSIBLE = 'notFoundOrInaccessible';
const CONFLICT = 'conflict';
const UNAUTHENTICATED = 'unauthenticated';
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
    expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining(['membership.created', 'organization.created']));
  });

  await expect(owner.client.mutation(createOrganization, { name: 'Other', slug: 'acme' })).rejects.toMatchObject({
    data: { code: CONFLICT },
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
    await expect(member.client.query(getOrganization, { organizationId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(member.client.mutation(updateOrganization, { organizationId, name: 'Nope' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(member.client.mutation(addMember, { organizationId, userId: owner.userId, role: 'viewer' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(
      member.client.query(listMembers, { organizationId, paginationOpts: firstPage }),
    ).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  }
});

test('organization administration is closed below admin, and an admin rename is stored and audited', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const viewer = await provision(t, 'viewer');
  const planner = await provision(t, 'planner');
  const admin = await provision(t, 'admin');
  const target = await provision(t, 'target');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'roles-org' });
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });

  // The floor is admin, not planner: a planner composes work inside the tenant,
  // it does not administer the tenant itself. Both ranks below admin are here so
  // the floor cannot slip a rank unnoticed.
  for (const { client } of [viewer, planner]) {
    await expect(client.mutation(updateOrganization, { organizationId, name: 'Nope' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(client.mutation(addMember, { organizationId, userId: target.userId, role: 'viewer' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  }

  // The success path: the trimmed name is what is stored, and the rename leaves
  // an attributed audit row naming the new name.
  await expect(admin.client.mutation(updateOrganization, { organizationId, name: '  Acme Logistics  ' })).resolves.toBeNull();
  // Slugs are deliberately immutable, and an omitted name is an accepted no-op.
  await expect(admin.client.mutation(updateOrganization, { organizationId })).resolves.toBeNull();
  await expect(admin.client.mutation(updateOrganization, { organizationId, name: '   ' })).rejects.toMatchObject({ data: { code: 'entityNameInvalid' } });

  await t.run(async (ctx) => {
    expect(await ctx.db.get(organizationId)).toMatchObject({ name: 'Acme Logistics', slug: 'roles-org' });
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'organization').eq('entityId', organizationId))
      .collect();
    const updates = audits.filter((audit) => audit.action === 'organization.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ actorUserId: admin.userId, organizationId, metadata: { name: 'Acme Logistics' } });
  });
});

test('membership administration is closed below admin, and an admin administers every non-owner rank', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const viewer = await provision(t, 'viewer');
  const planner = await provision(t, 'planner');
  const admin = await provision(t, 'admin');
  const target = await provision(t, 'target');
  const newcomer = await provision(t, 'newcomer');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'membership-floor' });
  const viewerMembershipId = await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  const plannerMembershipId = await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const adminMembershipId = await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });
  const targetMembershipId = await owner.client.mutation(addMember, { organizationId, userId: target.userId, role: 'operator' });

  // THE privilege-escalation guard. `canAssignRole` only polices changes that
  // touch an OWNER, so the admin floor on these two mutations is the only thing
  // standing between a sub-admin member and the whole roster: without it a viewer
  // could promote ITSELF to admin (the `ownMembershipId` case) and demote or
  // remove any admin/planner/operator. Both ranks below admin are exercised so
  // the floor cannot slip a rank unnoticed.
  for (const { client, ownMembershipId } of [
    { client: viewer.client, ownMembershipId: viewerMembershipId },
    { client: planner.client, ownMembershipId: plannerMembershipId },
  ]) {
    for (const membershipId of [ownMembershipId, targetMembershipId, adminMembershipId]) {
      await expect(client.mutation(changeMemberRole, { membershipId, role: 'admin' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
      await expect(client.mutation(removeMember, { membershipId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    }
  }
  // Every refusal was total: no rank moved and no membership disappeared.
  await t.run(async (ctx) => {
    const memberships = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId))
      .collect();
    expect(memberships.map((membership) => membership.role).sort()).toEqual(['admin', 'operator', 'owner', 'planner', 'viewer']);
  });

  // Admin is a floor, not a ceiling-less whitelist: an admin adds a NON-owner
  // member (the owner policy that refuses `role: 'owner'` is a separate gate),
  // changes a non-owner rank, and removes a non-owner membership.
  const newcomerMembershipId = await admin.client.mutation(addMember, { organizationId, userId: newcomer.userId, role: 'planner' });
  await expect(admin.client.mutation(changeMemberRole, { membershipId: targetMembershipId, role: 'planner' })).resolves.toBeNull();
  await expect(admin.client.mutation(removeMember, { membershipId: newcomerMembershipId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect((await ctx.db.get(targetMembershipId))?.role).toBe('planner');
    expect(await ctx.db.get(newcomerMembershipId)).toBeNull();
  });
});

test('organization slugs must be 3–63 lowercase dash-separated segments', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');

  for (const slug of ['ab', 'a'.repeat(64), 'Acme', 'has space', '-leading', 'trailing-', 'double--dash', 'under_score', 'acme!', '']) {
    await expect(owner.client.mutation(createOrganization, { name: 'Rejected', slug })).rejects.toMatchObject({
      data: { code: 'organizationSlugInvalid' },
    });
  }
  // Both length bounds are inclusive, and digits are legal inside a segment.
  await expect(owner.client.mutation(createOrganization, { name: 'Shortest', slug: 'abc' })).resolves.toBeDefined();
  await expect(owner.client.mutation(createOrganization, { name: 'Longest', slug: 'a'.repeat(63) })).resolves.toBeDefined();
  await expect(owner.client.mutation(createOrganization, { name: 'Segmented', slug: 'acme-2026-north' })).resolves.toBeDefined();
});

test('every public organization function is opaque to unauthenticated callers', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'org-unauth' });
  const missingOrganizationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', { name: 'Temporary', slug: 'org-unauth-ghost' });
    await ctx.db.delete(id);
    return id;
  });

  // Identical error for a real and a fabricated id on every entry point: without
  // an identity nothing is reached, so nothing is disclosed.
  for (const id of [organizationId, missingOrganizationId]) {
    await expect(t.query(getOrganization, { organizationId: id })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
    await expect(t.query(listMembers, { organizationId: id, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
    await expect(t.mutation(updateOrganization, { organizationId: id, name: 'Nope' })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
    await expect(t.mutation(addMember, { organizationId: id, userId: member.userId, role: 'viewer' })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  }
  await expect(t.query(api.organizations.queries.listMyOrganizations, {})).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  await expect(t.mutation(createOrganization, { name: 'Nope', slug: 'org-unauth-new' })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
});

test('duplicate memberships are rejected without disclosing the existing membership', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'duplicates-org' });
  await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'viewer' });

  await expect(owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'admin' })).rejects.toMatchObject({ data: { code: CONFLICT } });
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

  await expect(firstOwner.client.mutation(changeMemberRole, { membershipId: firstMembershipId, role: 'admin' })).rejects.toMatchObject({ data: { code: CONFLICT } });
  await expect(firstOwner.client.mutation(removeMember, { membershipId: firstMembershipId })).rejects.toMatchObject({ data: { code: CONFLICT } });

  const secondMembershipId = await firstOwner.client.mutation(addMember, { organizationId, userId: secondOwner.userId, role: 'owner' });
  await firstOwner.client.mutation(changeMemberRole, { membershipId: secondMembershipId, role: 'admin' });
  await firstOwner.client.mutation(changeMemberRole, { membershipId: secondMembershipId, role: 'owner' });
  await firstOwner.client.mutation(removeMember, { membershipId: secondMembershipId });

  await t.run(async (ctx) => {
    // The membership row is gone, so the audit row is the only remaining record
    // of who removed whom and what rank they held.
    expect(await ctx.db.get(secondMembershipId)).toBeNull();
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'membership').eq('entityId', secondMembershipId))
      .collect();
    const removals = audits.filter((audit) => audit.action === 'membership.removed');
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ actorUserId: firstOwner.userId, organizationId, metadata: { previousRole: 'owner' } });
    // The refused demotion and removal of the final owner wrote nothing at all.
    const firstOwnerAudits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'membership').eq('entityId', firstMembershipId))
      .collect();
    expect(firstOwnerAudits.map((audit) => audit.action)).toEqual(['membership.created']);
  });
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
    await expect(t.mutation(changeMemberRole, { membershipId, role: 'admin' })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
    await expect(t.mutation(removeMember, { membershipId })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  }

  // Authenticated non-member: identical generic error for real and fabricated ids.
  const outsider = await provision(t, 'outsider');
  for (const membershipId of [realMembershipId, fakeMembershipId]) {
    await expect(outsider.client.mutation(changeMemberRole, { membershipId, role: 'admin' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(outsider.client.mutation(removeMember, { membershipId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  }

  // A target user id that no longer resolves is refused with the same generic
  // error — and the refusal is load-bearing, not cosmetic: writing the membership
  // anyway would leave a row pointing at no user, and `listMembers` fails the
  // WHOLE roster the moment its join meets one. The read below is what proves the
  // roster survived the attempt.
  const fakeUserId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('users', { authProvider: issuer, authSubject: 'ghost-user' });
    await ctx.db.delete(id);
    return id;
  });
  await expect(owner.client.mutation(addMember, { organizationId, userId: fakeUserId, role: 'viewer' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  const roster = await owner.client.query(listMembers, { organizationId, paginationOpts: firstPage });
  expect(roster.page.map((entry) => entry.membership.role).sort()).toEqual(['owner', 'viewer']);
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

  await expect(admin.client.mutation(addMember, { organizationId, userId: target.userId, role: 'owner' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  const targetMembershipId = await owner.client.mutation(addMember, { organizationId, userId: target.userId, role: 'viewer' });

  // The changeMemberRole path enforces the same policy: admins can neither
  // promote to owner nor touch an existing owner's membership.
  await expect(admin.client.mutation(changeMemberRole, { membershipId: targetMembershipId, role: 'owner' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  const ownerMembershipId = await t.run(async (ctx) => {
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', owner.userId))
      .unique();
    if (membership === null) throw new Error('Expected owner membership');
    return membership._id;
  });
  await expect(admin.client.mutation(changeMemberRole, { membershipId: ownerMembershipId, role: 'admin' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  await expect(admin.client.mutation(removeMember, { membershipId: ownerMembershipId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });

  await expect(owner.client.mutation(changeMemberRole, { membershipId: targetMembershipId, role: 'owner' })).resolves.toBeNull();
});

test('removing a member accountable for an Event always succeeds and leaves the record standing', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'accountable-owner');
  const planner = await provision(t, 'accountable-planner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'accountable-org' });
  const membershipId = await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Accountable project' });
  const eventId = await owner.client.mutation(createEvent, {
    projectId,
    name: 'Accountable event',
    startsAt: 200,
    accountableUserId: planner.userId,
  });
  // The Event is frozen exactly the way a real one ends up: archiving its
  // Project is terminal and makes every Event write beneath it refuse. Any
  // accountability guard on removal would pin this member's access forever.
  await owner.client.mutation(archiveProject, { projectId });
  await expect(owner.client.mutation(updateEvent, { eventId, accountableUserId: null })).rejects.toMatchObject({
    data: { code: 'eventProjectReadOnly' },
  });

  // Revocation is never refusable, so it succeeds even here.
  await expect(owner.client.mutation(removeMember, { membershipId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(membershipId)).toBeNull();
    // The stored id survives as the true record of who was accountable, and
    // the user row it names is never deleted, so nothing dangles.
    expect((await ctx.db.get(eventId))?.accountableUserId).toBe(planner.userId);
    expect(await ctx.db.get(planner.userId)).not.toBeNull();
  });
});
