import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createInvitation = api.invitations.mutations.createInvitation;
const revokeInvitation = api.invitations.mutations.revokeInvitation;
const acceptInvitation = api.invitations.mutations.acceptInvitation;
const listPendingInvitations = api.invitations.queries.listPendingInvitations;
const listMyPendingInvitations = api.invitations.queries.listMyPendingInvitations;

const NOT_FOUND_OR_INACCESSIBLE = 'notFoundOrInaccessible';
const CONFLICT = 'conflict';
const UNAUTHENTICATED = 'unauthenticated';
const INVITATION_NOT_PENDING = 'invitationNotPending';
const INVITATION_EXPIRED = 'invitationExpired';
const INVITATION_EMAIL_INVALID = 'invitationEmailInvalid';
const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 10, cursor: null };

function identity(subject: string, email = `${subject}@example.com`) {
  return { issuer, subject, name: subject, email, emailVerified: true };
}

async function provision(t: ReturnType<typeof convexTest>, subject: string, email?: string) {
  const client = t.withIdentity(identity(subject, email));
  const userId = await client.mutation(ensureUser, {});
  return { client, userId };
}

async function orgWithAdmin(t: ReturnType<typeof convexTest>, slug: string) {
  const owner = await provision(t, `${slug}-owner`);
  const admin = await provision(t, `${slug}-admin`);
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug });
  await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });
  return { owner, admin, organizationId };
}

test('createInvitation is closed below admin, and an admin invites a non-owner role', async () => {
  const t = convexTest(schema, modules);
  const { owner, admin, organizationId } = await orgWithAdmin(t, 'invite-floor');
  const planner = await provision(t, 'invite-floor-planner');
  const viewer = await provision(t, 'invite-floor-viewer');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });

  for (const { client } of [planner, viewer]) {
    await expect(
      client.mutation(createInvitation, { organizationId, email: 'nope@example.com', role: 'viewer' }),
    ).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  }

  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'newcomer@example.com',
    role: 'planner',
  });
  await t.run(async (ctx) => {
    const invitation = await ctx.db.get(invitationId);
    expect(invitation).toMatchObject({
      organizationId,
      email: 'newcomer@example.com',
      role: 'planner',
      status: 'pending',
      invitedByUserId: admin.userId,
    });
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'invitation').eq('entityId', invitationId))
      .collect();
    expect(audits.map((a) => a.action)).toEqual(['invitation.created']);
    expect(audits[0]).toMatchObject({ actorUserId: admin.userId, metadata: { role: 'planner' } });
  });
});

test('an admin cannot invite as owner, but an owner can', async () => {
  const t = convexTest(schema, modules);
  const { owner, admin, organizationId } = await orgWithAdmin(t, 'invite-owner-ceiling');

  await expect(
    admin.client.mutation(createInvitation, { organizationId, email: 'target@example.com', role: 'owner' }),
  ).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });

  const invitationId = await owner.client.mutation(createInvitation, {
    organizationId,
    email: 'target@example.com',
    role: 'owner',
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(invitationId)).toMatchObject({ role: 'owner' });
  });
});

test('an invitation is normalized (trimmed, lowercased) and rejects malformed addresses', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'invite-normalize');

  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: '  Someone@Example.COM  ',
    role: 'viewer',
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(invitationId)).toMatchObject({ email: 'someone@example.com' });
  });

  for (const email of ['not-an-email', '', '   ', 'missing-domain@', '@no-local.com']) {
    await expect(admin.client.mutation(createInvitation, { organizationId, email, role: 'viewer' })).rejects.toMatchObject({
      data: { code: INVITATION_EMAIL_INVALID },
    });
  }
});

test('one pending invitation per organization and email: a duplicate is a conflict, resolved ones are not', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'invite-duplicate');

  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'dup@example.com',
    role: 'viewer',
  });
  await expect(
    admin.client.mutation(createInvitation, { organizationId, email: 'dup@example.com', role: 'planner' }),
  ).rejects.toMatchObject({ data: { code: CONFLICT } });

  // Revoking frees the address up for a fresh invitation.
  await admin.client.mutation(revokeInvitation, { invitationId });
  await expect(
    admin.client.mutation(createInvitation, { organizationId, email: 'dup@example.com', role: 'planner' }),
  ).resolves.toBeDefined();
});

test('a pending invitation past its own expiresAt does not block re-inviting the same address', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'invite-expired-reuse');

  const staleId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'stale@example.com',
    role: 'viewer',
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(staleId, { expiresAt: Date.now() - 1000 });
  });

  // A genuinely duplicate PENDING invite is still a conflict.
  const freshId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'stale@example.com',
    role: 'planner',
  });
  await expect(
    admin.client.mutation(createInvitation, { organizationId, email: 'stale@example.com', role: 'viewer' }),
  ).rejects.toMatchObject({ data: { code: CONFLICT } });

  await t.run(async (ctx) => {
    // The stale row was settled to `expired` as a side effect of the
    // duplicate check that let the fresh invitation through.
    expect(await ctx.db.get(staleId)).toMatchObject({ status: 'expired' });
    expect(await ctx.db.get(freshId)).toMatchObject({ status: 'pending', role: 'planner' });
  });
});

test('revokeInvitation is closed below admin, opaque to a foreign org, and rejects a non-pending invitation', async () => {
  const t = convexTest(schema, modules);
  const { owner, admin, organizationId } = await orgWithAdmin(t, 'revoke-floor');
  const viewer = await provision(t, 'revoke-floor-viewer');
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  const other = await orgWithAdmin(t, 'revoke-floor-other');

  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'target@example.com',
    role: 'viewer',
  });

  // Below the floor.
  await expect(viewer.client.mutation(revokeInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });
  // An admin of a DIFFERENT organization gets the same generic error as a
  // fabricated id — the invitation belongs to a foreign org (I9).
  await expect(other.admin.client.mutation(revokeInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });

  await expect(admin.client.mutation(revokeInvitation, { invitationId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(invitationId)).toMatchObject({ status: 'revoked' });
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'invitation').eq('entityId', invitationId))
      .collect();
    expect(audits.map((a) => a.action)).toEqual(['invitation.created', 'invitation.revoked']);
  });

  // Already resolved: revoking again is refused with a specific state error,
  // since this is the caller's own organization's data (I9's specific-vs-generic line).
  await expect(admin.client.mutation(revokeInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: INVITATION_NOT_PENDING },
  });
});

test('accepting an invitation addressed to a different email fails opaquely', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'accept-wrong-email');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'intended@example.com',
    role: 'planner',
  });

  const wrongPerson = await provision(t, 'accept-wrong-email-outsider', 'someone-else@example.com');
  await expect(wrongPerson.client.mutation(acceptInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(invitationId)).toMatchObject({ status: 'pending' });
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', wrongPerson.userId))
      .unique();
    expect(membership).toBeNull();
  });
});

test('a caller with no verified email cannot accept anything addressed to anyone', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'accept-no-email');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'someone@example.com',
    role: 'viewer',
  });

  const unverified = t.withIdentity({ issuer, subject: 'unverified-subject', name: 'Unverified' });
  await unverified.mutation(ensureUser, {});
  await expect(unverified.mutation(acceptInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });
});

test('accepting creates exactly one membership with the invited role, and consumes the invitation', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'accept-happy');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'recruit@example.com',
    role: 'planner',
  });
  const recruit = await provision(t, 'accept-happy-recruit', 'recruit@example.com');

  const membershipId = await recruit.client.mutation(acceptInvitation, { invitationId });
  await t.run(async (ctx) => {
    const membership = await ctx.db.get(membershipId);
    expect(membership).toMatchObject({ organizationId, userId: recruit.userId, role: 'planner' });
    expect(await ctx.db.get(invitationId)).toMatchObject({ status: 'accepted' });
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'invitation').eq('entityId', invitationId))
      .collect();
    expect(audits.map((a) => a.action)).toEqual(['invitation.created', 'invitation.accepted']);
    const membershipAudits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'membership').eq('entityId', membershipId))
      .collect();
    expect(membershipAudits.map((a) => a.action)).toEqual(['membership.created']);
  });
});

test('a mixed-case identity claim still finds and can accept an invitation stored lowercase', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'accept-mixed-case');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'Mixed.Case@Example.COM',
    role: 'viewer',
  });
  await t.run(async (ctx) => {
    // Stored normalized regardless of how the admin typed it.
    expect(await ctx.db.get(invitationId)).toMatchObject({ email: 'mixed.case@example.com' });
  });

  // The identity provider's own claim is never normalized (auth/model.ts
  // stores it verbatim) — this recruit's `users.email` is genuinely mixed case.
  const recruit = await provision(t, 'accept-mixed-case-recruit', 'Mixed.Case@Example.COM');

  const mine = await recruit.client.query(listMyPendingInvitations, { paginationOpts: firstPage });
  expect(mine.page.map((entry) => entry.invitation._id)).toEqual([invitationId]);

  const membershipId = await recruit.client.mutation(acceptInvitation, { invitationId });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(membershipId)).toMatchObject({ organizationId, userId: recruit.userId, role: 'viewer' });
  });
});

test('accepting twice does not produce two memberships', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'accept-twice');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'recruit@example.com',
    role: 'viewer',
  });
  const recruit = await provision(t, 'accept-twice-recruit', 'recruit@example.com');

  await recruit.client.mutation(acceptInvitation, { invitationId });
  await expect(recruit.client.mutation(acceptInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: INVITATION_NOT_PENDING },
  });

  await t.run(async (ctx) => {
    const memberships = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', recruit.userId))
      .collect();
    expect(memberships).toHaveLength(1);
  });
});

test('accepting after the invitation was already consumed by an existing membership is a conflict, not a duplicate', async () => {
  const t = convexTest(schema, modules);
  const { owner, admin, organizationId } = await orgWithAdmin(t, 'accept-already-member');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'already@example.com',
    role: 'viewer',
  });
  const person = await provision(t, 'accept-already-member-person', 'already@example.com');
  // The admin separately attaches the same person directly before they accept.
  await owner.client.mutation(addMember, { organizationId, userId: person.userId, role: 'operator' });

  await expect(person.client.mutation(acceptInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: CONFLICT },
  });
  await t.run(async (ctx) => {
    const memberships = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', person.userId))
      .collect();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ role: 'operator' });
    // The invitation itself is untouched by the refused accept.
    expect(await ctx.db.get(invitationId)).toMatchObject({ status: 'pending' });
  });
});

test('a revoked invitation cannot be accepted', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'accept-revoked');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'recruit@example.com',
    role: 'viewer',
  });
  await admin.client.mutation(revokeInvitation, { invitationId });
  const recruit = await provision(t, 'accept-revoked-recruit', 'recruit@example.com');

  await expect(recruit.client.mutation(acceptInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: INVITATION_NOT_PENDING },
  });
  await t.run(async (ctx) => {
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', recruit.userId))
      .unique();
    expect(membership).toBeNull();
  });
});

test('an expired invitation cannot be accepted, and the throw leaves the stored status untouched', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'accept-expired');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'recruit@example.com',
    role: 'viewer',
  });
  // Backdate expiry directly. There is no cron sweep, and a Convex mutation
  // that throws rolls back every write it made — so even after a rejected
  // accept attempt, the row is still stored as `pending`; only `expiresAt`
  // marks it expired.
  await t.run(async (ctx) => {
    await ctx.db.patch(invitationId, { expiresAt: Date.now() - 1000 });
  });
  const recruit = await provision(t, 'accept-expired-recruit', 'recruit@example.com');

  await expect(recruit.client.mutation(acceptInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: INVITATION_EXPIRED },
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(invitationId)).toMatchObject({ status: 'pending' });
  });
  // Trying again fails the exact same way — the check is `expiresAt`, not a
  // one-time transition.
  await expect(recruit.client.mutation(acceptInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: INVITATION_EXPIRED },
  });
});

test('a fabricated or foreign-org invitation id is opaque to acceptInvitation and revokeInvitation', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'invite-fabricated');
  const outsider = await provision(t, 'invite-fabricated-outsider');
  const fakeInvitationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizationInvitations', {
      organizationId,
      email: 'ghost@example.com',
      role: 'viewer',
      status: 'pending',
      invitedByUserId: admin.userId,
      expiresAt: Date.now() + 1000,
    });
    await ctx.db.delete(id);
    return id;
  });

  await expect(admin.client.mutation(revokeInvitation, { invitationId: fakeInvitationId })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });
  await expect(outsider.client.mutation(acceptInvitation, { invitationId: fakeInvitationId })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });
});

test('every public invitation function is opaque to unauthenticated callers', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'invite-unauth');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'someone@example.com',
    role: 'viewer',
  });

  await expect(t.mutation(createInvitation, { organizationId, email: 'x@example.com', role: 'viewer' })).rejects.toMatchObject({
    data: { code: UNAUTHENTICATED },
  });
  await expect(t.mutation(revokeInvitation, { invitationId })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  await expect(t.mutation(acceptInvitation, { invitationId })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  await expect(t.query(listPendingInvitations, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({
    data: { code: UNAUTHENTICATED },
  });
  await expect(t.query(listMyPendingInvitations, { paginationOpts: firstPage })).rejects.toMatchObject({
    data: { code: UNAUTHENTICATED },
  });
});

test('listPendingInvitations is admin-floor, org-scoped, paginated, and only lists pending rows', async () => {
  const t = convexTest(schema, modules);
  const { owner, admin, organizationId } = await orgWithAdmin(t, 'list-pending');
  const viewer = await provision(t, 'list-pending-viewer');
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  const other = await orgWithAdmin(t, 'list-pending-other');

  const keptId = await admin.client.mutation(createInvitation, { organizationId, email: 'kept@example.com', role: 'viewer' });
  const revokedId = await admin.client.mutation(createInvitation, { organizationId, email: 'gone@example.com', role: 'viewer' });
  await admin.client.mutation(revokeInvitation, { invitationId: revokedId });
  await other.admin.client.mutation(createInvitation, { organizationId: other.organizationId, email: 'kept@example.com', role: 'viewer' });

  await expect(viewer.client.query(listPendingInvitations, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });
  // Foreign org: same generic error as a fabricated one.
  await expect(
    other.admin.client.query(listPendingInvitations, { organizationId, paginationOpts: firstPage }),
  ).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });

  const page = await admin.client.query(listPendingInvitations, { organizationId, paginationOpts: firstPage });
  expect(page.page.map((invitation) => invitation._id)).toEqual([keptId]);
  expect(page.page[0]).toMatchObject({ email: 'kept@example.com', status: 'pending' });

  // Pagination actually pages (I6).
  const onePerPage = await admin.client.query(listPendingInvitations, {
    organizationId,
    paginationOpts: { numItems: 1, cursor: null },
  });
  expect(onePerPage.page).toHaveLength(1);
  expect(onePerPage.isDone).toBe(true);
});

test('listMyPendingInvitations returns only invitations addressed to the caller, with the organization name', async () => {
  const t = convexTest(schema, modules);
  const first = await orgWithAdmin(t, 'my-pending-first');
  const second = await orgWithAdmin(t, 'my-pending-second');
  const recruit = await provision(t, 'my-pending-recruit', 'recruit@example.com');
  const stranger = await provision(t, 'my-pending-stranger', 'stranger@example.com');

  await first.admin.client.mutation(createInvitation, { organizationId: first.organizationId, email: 'recruit@example.com', role: 'planner' });
  await second.admin.client.mutation(createInvitation, { organizationId: second.organizationId, email: 'recruit@example.com', role: 'viewer' });
  await first.admin.client.mutation(createInvitation, { organizationId: first.organizationId, email: 'stranger@example.com', role: 'viewer' });

  const mine = await recruit.client.query(listMyPendingInvitations, { paginationOpts: firstPage });
  expect(mine.page).toHaveLength(2);
  const organizationIds = mine.page.map((entry) => entry.organization._id).sort();
  expect(organizationIds).toEqual([first.organizationId, second.organizationId].sort());
  expect(mine.page.every((entry) => entry.invitation.email === 'recruit@example.com')).toBe(true);
  expect(mine.page.find((entry) => entry.organization._id === first.organizationId)?.organization.name).toBe('Acme');
  // Deliberately narrower than the stored row: no organizationId (redundant
  // with `organization`) and no invitedByUserId (a foreign-org user id the
  // caller has no business seeing before they are a member, I9).
  expect(mine.page[0]).not.toHaveProperty('invitation.organizationId');
  expect(mine.page[0]).not.toHaveProperty('invitation.invitedByUserId');

  const strangers = await stranger.client.query(listMyPendingInvitations, { paginationOpts: firstPage });
  expect(strangers.page).toHaveLength(1);
  expect(strangers.page[0]?.invitation.email).toBe('stranger@example.com');

  const nobody = await provision(t, 'my-pending-nobody', 'nobody@example.com');
  const none = await nobody.client.query(listMyPendingInvitations, { paginationOpts: firstPage });
  expect(none.page).toEqual([]);
  expect(none.isDone).toBe(true);
});

test('createInvitation for a foreign organization is opaque, same as a fabricated id', async () => {
  const t = convexTest(schema, modules);
  const { organizationId } = await orgWithAdmin(t, 'invite-foreign-org');
  const other = await orgWithAdmin(t, 'invite-foreign-org-other');

  // other.admin is a genuine admin, just not of `organizationId` — the same
  // generic error as any other caller with no membership in that org (I9).
  await expect(
    other.admin.client.mutation(createInvitation, { organizationId, email: 'nope@example.com', role: 'viewer' }),
  ).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
});

test('an identity claiming an address without provider verification cannot accept an invitation to it', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'accept-unverified');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'intended@example.com',
    role: 'planner',
  });

  // A brand-new identity whose provider claim is NOT verified: ensureUser's
  // insert path (auth/model.ts) stores no email at all in this case, exactly
  // like a claim with no email field — this exercises that INSERT path
  // directly, not the patch-on-existing-user path `auth.test.ts` covers.
  const attacker = t.withIdentity({
    issuer,
    subject: 'accept-unverified-attacker',
    name: 'Attacker',
    email: 'intended@example.com',
    emailVerified: false,
  });
  const attackerUserId = await attacker.mutation(ensureUser, {});
  await t.run(async (ctx) => {
    expect(await ctx.db.get(attackerUserId)).not.toHaveProperty('email');
  });

  await expect(attacker.mutation(acceptInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });
  const mine = await attacker.query(listMyPendingInvitations, { paginationOpts: firstPage });
  expect(mine.page).toEqual([]);

  await t.run(async (ctx) => {
    expect(await ctx.db.get(invitationId)).toMatchObject({ status: 'pending' });
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', attackerUserId))
      .unique();
    expect(membership).toBeNull();
  });
});

test('listMyPendingInvitations returns an empty page (not an error) for a caller with no verified email', async () => {
  const t = convexTest(schema, modules);
  const noEmail = t.withIdentity({ issuer, subject: 'no-email-subject', name: 'No Email' });
  await noEmail.mutation(ensureUser, {});

  const mine = await noEmail.query(listMyPendingInvitations, { paginationOpts: firstPage });
  expect(mine).toMatchObject({ page: [], isDone: true });
});

test("listMyPendingInvitations excludes the caller's own accepted and revoked invitations", async () => {
  const t = convexTest(schema, modules);
  const first = await orgWithAdmin(t, 'my-pending-status-first');
  const second = await orgWithAdmin(t, 'my-pending-status-second');
  const recruit = await provision(t, 'my-pending-status-recruit', 'recruit@example.com');

  const acceptedId = await first.admin.client.mutation(createInvitation, {
    organizationId: first.organizationId,
    email: 'recruit@example.com',
    role: 'viewer',
  });
  await recruit.client.mutation(acceptInvitation, { invitationId: acceptedId });

  const revokedId = await second.admin.client.mutation(createInvitation, {
    organizationId: second.organizationId,
    email: 'recruit@example.com',
    role: 'viewer',
  });
  await second.admin.client.mutation(revokeInvitation, { invitationId: revokedId });

  const mine = await recruit.client.query(listMyPendingInvitations, { paginationOpts: firstPage });
  expect(mine.page).toEqual([]);
});

test('pending lists still surface an effectively-expired row (by expiresAt) rather than silently filtering it', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'list-expired-visible');
  const invitationId = await admin.client.mutation(createInvitation, {
    organizationId,
    email: 'recruit@example.com',
    role: 'viewer',
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(invitationId, { expiresAt: Date.now() - 1000 });
  });
  const recruit = await provision(t, 'list-expired-visible-recruit', 'recruit@example.com');

  // Admin-side list: the row is still `pending` in storage (nothing settled
  // it), so callers must compute "expired" from `expiresAt` themselves.
  const adminSide = await admin.client.query(listPendingInvitations, { organizationId, paginationOpts: firstPage });
  expect(adminSide.page).toHaveLength(1);
  expect(adminSide.page[0]).toMatchObject({ _id: invitationId, status: 'pending' });
  expect(adminSide.page[0]?.expiresAt).toBeLessThan(Date.now());

  // Recipient-side list: same row, same requirement.
  const recipientSide = await recruit.client.query(listMyPendingInvitations, { paginationOpts: firstPage });
  expect(recipientSide.page).toHaveLength(1);
  expect(recipientSide.page[0]).toMatchObject({ invitation: { _id: invitationId, status: 'pending' } });
  expect(recipientSide.page[0]?.invitation.expiresAt).toBeLessThan(Date.now());
});

test('an invitation still grants its role at acceptance even if the inviter was later demoted (documented, deliberate)', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await orgWithAdmin(t, 'stale-inviter-authority');
  const secondOwner = await provision(t, 'stale-inviter-authority-second-owner');
  await owner.client.mutation(addMember, { organizationId, userId: secondOwner.userId, role: 'owner' });

  // The (still-)owner issues an owner-level invitation, matching canAssignRole.
  const invitationId = await owner.client.mutation(createInvitation, {
    organizationId,
    email: 'recruit@example.com',
    role: 'owner',
  });

  // The inviter is demoted below owner. No cascade-revoke exists (documented
  // known gap, docs/deviations.md) — the outstanding invitation is untouched.
  const ownerMembershipId = await t.run(async (ctx) => {
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('userId', owner.userId))
      .unique();
    if (membership === null) throw new Error('Expected owner membership');
    return membership._id;
  });
  await secondOwner.client.mutation(api.organizations.mutations.changeMemberRole, {
    membershipId: ownerMembershipId,
    role: 'admin',
  });

  const recruit = await provision(t, 'stale-inviter-authority-recruit', 'recruit@example.com');
  const membershipId = await recruit.client.mutation(acceptInvitation, { invitationId });
  await t.run(async (ctx) => {
    // Still grants `owner`, per the role authorized at creation time.
    expect(await ctx.db.get(membershipId)).toMatchObject({ organizationId, role: 'owner' });
  });
});

test('an over-length email is rejected the same way a malformed one is', async () => {
  const t = convexTest(schema, modules);
  const { admin, organizationId } = await orgWithAdmin(t, 'invite-email-too-long');

  const tooLong = `${'a'.repeat(250)}@example.com`;
  expect(tooLong.length).toBeGreaterThan(254);
  await expect(
    admin.client.mutation(createInvitation, { organizationId, email: tooLong, role: 'viewer' }),
  ).rejects.toMatchObject({ data: { code: INVITATION_EMAIL_INVALID } });
});
