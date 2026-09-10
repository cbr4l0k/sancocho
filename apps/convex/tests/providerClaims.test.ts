import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const changeMemberRole = api.organizations.mutations.changeMemberRole;
const removeMember = api.organizations.mutations.removeMember;
const createProject = api.projects.mutations.createProject;
const getProject = api.projects.queries.getProject;
const createProvider = api.providers.mutations.createProvider;
const archiveProvider = api.providers.mutations.archiveProvider;
const inviteProviderOrganization = api.providers.mutations.inviteProviderOrganization;
const claimProviderOrganization = api.providers.mutations.claimProviderOrganization;
const revokeProviderClaimInvitation = api.providers.mutations.revokeProviderClaimInvitation;
const revokeProviderOrganizationClaim = api.providers.mutations.revokeProviderOrganizationClaim;
const grantProjectAccessToProvider = api.providers.mutations.grantProjectAccessToProvider;
const revokeProviderAccessGrant = api.providers.mutations.revokeProviderAccessGrant;
const listProviderClaimInvitations = api.providers.queries.listProviderClaimInvitations;
const listProjectProviderAccessGrants = api.providers.queries.listProjectProviderAccessGrants;
const createInvitation = api.invitations.mutations.createInvitation;
const revokeInvitation = api.invitations.mutations.revokeInvitation;
const acceptInvitation = api.invitations.mutations.acceptInvitation;
const getAssignment = api.assignments.queries.getAssignment;

const issuer = 'https://example.clerk.accounts.dev';
const inaccessible = 'notFoundOrInaccessible';
const unauthenticated = 'unauthenticated';
const firstPage = { numItems: 10, cursor: null };

type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;

function identity(subject: string, email = `${subject}@example.com`) {
  return { issuer, subject, name: subject, email, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string, email = `${subject}@example.com`) {
  const client = t.withIdentity(identity(subject, email));
  const userId: Id<'users'> = await client.mutation(ensureUser, {});
  return { client, userId, email };
}

async function baseFixture() {
  const t = convexTest(schema, modules);
  const coordinator = await provision(t, 'claims-coordinator');
  const coordinatorOrganizationId = await coordinator.client.mutation(createOrganization, {
    name: 'Festival Coordinator',
    slug: 'claims-coordinator',
  });
  const providerId = await coordinator.client.mutation(createProvider, {
    organizationId: coordinatorOrganizationId,
    name: 'Andes Transport',
  });
  return { t, coordinator, coordinatorOrganizationId, providerId };
}

async function twoCoordinatorFixture() {
  const first = await baseFixture();
  const secondCoordinator = await provision(first.t, 'claims-second-coordinator');
  const secondCoordinatorOrganizationId = await secondCoordinator.client.mutation(createOrganization, {
    name: 'Second Festival Coordinator',
    slug: 'claims-second-coordinator',
  });
  const secondProviderId = await secondCoordinator.client.mutation(createProvider, {
    organizationId: secondCoordinatorOrganizationId,
    name: 'Andes Transport in Second Directory',
  });
  return {
    ...first,
    secondCoordinator,
    secondCoordinatorOrganizationId,
    secondProviderId,
  };
}

async function addProviderOrganization(
  fixture: Awaited<ReturnType<typeof baseFixture>>,
  subject: string,
) {
  const recipient = await provision(fixture.t, subject);
  const organizationId = await recipient.client.mutation(createOrganization, {
    name: `${subject} firm`,
    slug: subject,
  });
  return { recipient, organizationId };
}

async function inviteAndClaim(
  fixture: Awaited<ReturnType<typeof baseFixture>>,
  subject: string,
) {
  const firm = await addProviderOrganization(fixture, subject);
  const invitationId = await fixture.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: fixture.providerId,
    email: firm.recipient.email,
  });
  await firm.recipient.client.mutation(claimProviderOrganization, {
    invitationId,
    organizationId: firm.organizationId,
  });
  return { ...firm, invitationId };
}

async function insertAssignment(
  t: SchemaTest,
  organizationId: Id<'organizations'>,
  providerId: Id<'providers'>,
) {
  return t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', {
      organizationId,
      name: 'Claim gate project',
      status: 'active',
    });
    const eventId = await ctx.db.insert('events', {
      organizationId,
      projectId,
      name: 'Claim gate event',
      status: 'active',
      startsAt: 0,
    });
    const serviceKindId = await ctx.db.insert('serviceKinds', {
      organizationId,
      key: 'claimGateKind',
      name: 'Claim gate kind',
      status: 'active',
    });
    const serviceKindVersionId = await ctx.db.insert('serviceKindVersions', {
      organizationId,
      serviceKindId,
      versionNumber: 1,
      status: 'published',
      publishedAt: 1,
    });
    const serviceId = await ctx.db.insert('services', {
      organizationId,
      projectId,
      eventId,
      serviceKindId,
      serviceKindVersionId,
      name: 'Claim gate service',
      status: 'draft',
      startsAt: 1,
    });
    const assignmentId = await ctx.db.insert('assignments', {
      organizationId,
      projectId,
      serviceId,
      providerId,
      position: 10,
      executionStatus: 'unassigned',
    });
    return { projectId, assignmentId };
  });
}

test('Provider-claim coordinator operations authenticate and authorize against the owning organization', async () => {
  const f = await twoCoordinatorFixture();
  const stranger = await provision(f.t, 'claims-operation-stranger');
  const claimedFirm = await inviteAndClaim(f, 'claims-operation-claimed-firm');
  const pendingProviderId = await f.coordinator.client.mutation(createProvider, {
    organizationId: f.coordinatorOrganizationId,
    name: 'Pending Claim Provider',
  });
  const pendingInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: pendingProviderId,
    email: 'claims-operation-pending@example.com',
  });

  // Each object is valid and each owning coordinator can reach its operation,
  // so the refusals below cannot be lifecycle or malformed-id failures.
  await expect(
    f.coordinator.client.query(listProviderClaimInvitations, {
      organizationId: f.coordinatorOrganizationId,
      paginationOpts: firstPage,
    }),
  ).resolves.toMatchObject({ page: [expect.objectContaining({ _id: pendingInvitationId })] });

  for (const caller of [stranger.client, f.secondCoordinator.client]) {
    await expect(
      caller.mutation(inviteProviderOrganization, {
        providerId: pendingProviderId,
        email: 'claims-operation-unauthorized@example.com',
      }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(
      caller.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(
      caller.mutation(revokeProviderClaimInvitation, { invitationId: pendingInvitationId }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(
      caller.query(listProviderClaimInvitations, {
        organizationId: f.coordinatorOrganizationId,
        paginationOpts: firstPage,
      }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  await expect(
    f.t.mutation(inviteProviderOrganization, {
      providerId: pendingProviderId,
      email: 'claims-operation-anonymous@example.com',
    }),
  ).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(
    f.t.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId }),
  ).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(
    f.t.mutation(revokeProviderClaimInvitation, { invitationId: pendingInvitationId }),
  ).rejects.toMatchObject({ data: { code: unauthenticated } });
  await expect(
    f.t.query(listProviderClaimInvitations, {
      organizationId: f.coordinatorOrganizationId,
      paginationOpts: firstPage,
    }),
  ).rejects.toMatchObject({ data: { code: unauthenticated } });

  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBe(claimedFirm.organizationId);
    expect(await ctx.db.get(pendingInvitationId)).toMatchObject({ status: 'pending' });
  });
});

test('Provider-claim coordinator operations require admin rank', async () => {
  const f = await baseFixture();
  const operator = await provision(f.t, 'claims-operation-operator');
  await f.coordinator.client.mutation(addMember, {
    organizationId: f.coordinatorOrganizationId,
    userId: operator.userId,
    role: 'operator',
  });
  const claimed = await inviteAndClaim(f, 'claims-operation-floor-claimed');
  const pendingProviderId = await f.coordinator.client.mutation(createProvider, {
    organizationId: f.coordinatorOrganizationId,
    name: 'Floor Pending Provider',
  });
  const pendingInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: pendingProviderId,
    email: 'claims-operation-floor-pending@example.com',
  });

  await expect(
    operator.client.mutation(inviteProviderOrganization, {
      providerId: pendingProviderId,
      email: 'claims-operation-floor-other@example.com',
    }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    operator.client.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    operator.client.query(listProviderClaimInvitations, {
      organizationId: f.coordinatorOrganizationId,
      paginationOpts: firstPage,
    }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBe(claimed.organizationId);
    expect(await ctx.db.get(pendingInvitationId)).toMatchObject({ status: 'pending' });
  });
});

test('claiming a Provider requires admin rank in the target Organization', async () => {
  const f = await baseFixture();
  const firm = await addProviderOrganization(f, 'claims-target-floor-firm');
  const operator = await provision(f.t, 'claims-target-floor-operator', firm.recipient.email);
  await firm.recipient.client.mutation(addMember, {
    organizationId: firm.organizationId,
    userId: operator.userId,
    role: 'operator',
  });
  const invitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });

  await expect(
    operator.client.mutation(claimProviderOrganization, {
      invitationId,
      organizationId: firm.organizationId,
    }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    firm.recipient.client.mutation(claimProviderOrganization, {
      invitationId,
      organizationId: firm.organizationId,
    }),
  ).resolves.toBeNull();
});

test('the same Provider cannot be claimed by two different Organizations', async () => {
  const f = await baseFixture();
  const first = await addProviderOrganization(f, 'claims-first-firm');
  const second = await addProviderOrganization(f, 'claims-second-firm');
  const firstInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: first.recipient.email,
  });
  const secondInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: second.recipient.email,
  });

  await first.recipient.client.mutation(claimProviderOrganization, {
    invitationId: firstInvitationId,
    organizationId: first.organizationId,
  });
  await expect(
    second.recipient.client.mutation(claimProviderOrganization, {
      invitationId: secondInvitationId,
      organizationId: second.organizationId,
    }),
  ).rejects.toMatchObject({ data: { code: 'providerClaimAlreadyClaimed' } });
});

test('repeating an accepted claim is idempotent and writes no second audit row', async () => {
  const f = await baseFixture();
  const claimed = await inviteAndClaim(f, 'claims-idempotent-firm');

  const acceptedAudits = () => f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) =>
        q
          .eq('organizationId', f.coordinatorOrganizationId)
          .eq('entityType', 'providerClaimInvitation')
          .eq('entityId', claimed.invitationId),
      )
      .collect();
    return rows.filter((row) => row.action === 'providerClaim.accepted').length;
  });

  expect(await acceptedAudits()).toBe(1);
  await expect(
    claimed.recipient.client.mutation(claimProviderOrganization, {
      invitationId: claimed.invitationId,
      organizationId: claimed.organizationId,
    }),
  ).resolves.toBeNull();
  expect(await acceptedAudits()).toBe(1);
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBe(claimed.organizationId);
  });
});

test('a wrong-email claim receives only the generic inaccessible result', async () => {
  const f = await baseFixture();
  const recipient = await addProviderOrganization(f, 'claims-correct-recipient');
  const attacker = await addProviderOrganization(f, 'claims-wrong-recipient');
  const invitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: recipient.recipient.email,
  });

  await expect(
    attacker.recipient.client.mutation(claimProviderOrganization, {
      invitationId,
      organizationId: attacker.organizationId,
    }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('recipient email is checked before invitation kind and lifecycle state', async () => {
  const f = await baseFixture();
  const attacker = await addProviderOrganization(f, 'claims-ordering-attacker');
  const membershipInvitationId = await f.coordinator.client.mutation(createInvitation, {
    organizationId: f.coordinatorOrganizationId,
    email: 'claims-ordering-member@example.com',
    role: 'viewer',
  });

  const revokedProviderId = await f.coordinator.client.mutation(createProvider, {
    organizationId: f.coordinatorOrganizationId,
    name: 'Revoked Ordering Provider',
  });
  const revokedInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: revokedProviderId,
    email: 'claims-ordering-revoked@example.com',
  });
  await f.coordinator.client.mutation(revokeProviderClaimInvitation, { invitationId: revokedInvitationId });

  const accepted = await inviteAndClaim(f, 'claims-ordering-accepted');

  // Ordering is the assertion: a non-recipient must not distinguish these real
  // kind/status states from a fabricated id (I9).
  for (const invitationId of [membershipInvitationId, revokedInvitationId, accepted.invitationId]) {
    await expect(
      attacker.recipient.client.mutation(claimProviderOrganization, {
        invitationId,
        organizationId: attacker.organizationId,
      }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
  }
});

test('an accepted claim checks target-Organization authority before exposing lifecycle state', async () => {
  const f = await twoCoordinatorFixture();
  const claimed = await inviteAndClaim(f, 'claims-accepted-foreign-target');

  // The legitimate recipient still gets the fabricated-id result for a foreign
  // target. `invitationNotPending` here would reveal which Organization holds
  // the accepted link.
  await expect(
    claimed.recipient.client.mutation(claimProviderOrganization, {
      invitationId: claimed.invitationId,
      organizationId: f.secondCoordinatorOrganizationId,
    }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('an identity with no provider-verified stored email cannot claim a Provider', async () => {
  const f = await baseFixture();
  const intendedEmail = 'claims-no-verified-email@example.com';
  const invitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: intendedEmail,
  });
  const noEmail = f.t.withIdentity({
    issuer,
    subject: 'claims-no-verified-email',
    name: 'No verified email',
    email: intendedEmail,
    emailVerified: false,
  });
  const userId = await noEmail.mutation(ensureUser, {});
  const organizationId = await noEmail.mutation(createOrganization, {
    name: 'No Email Firm',
    slug: 'claims-no-verified-email',
  });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(userId)).not.toHaveProperty('email');
  });

  await expect(
    noEmail.mutation(claimProviderOrganization, { invitationId, organizationId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(invitationId)).toMatchObject({ status: 'pending' });
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBeUndefined();
  });
});

test('a claimed Provider with no project grant reads no coordinator assignment', async () => {
  const f = await baseFixture();
  const { projectId, assignmentId } = await insertAssignment(f.t, f.coordinatorOrganizationId, f.providerId);
  const claimed = await inviteAndClaim(f, 'claims-no-grant-firm');

  // This used to be vacuous: the same inaccessible result holds for an
  // unclaimed Provider. Prove the link, then change only the grant and show the
  // exact same read becomes reachable.
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBe(claimed.organizationId);
  });
  await expect(claimed.recipient.client.query(getAssignment, { assignmentId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
  await f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId, providerId: f.providerId });
  await expect(claimed.recipient.client.query(getAssignment, { assignmentId })).resolves.toMatchObject({
    _id: assignmentId,
  });
});

test('revoking a claim independently clears the Provider link', async () => {
  const f = await baseFixture();
  const claimed = await inviteAndClaim(f, 'claims-link-clear-firm');
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBe(claimed.organizationId);
  });

  await f.coordinator.client.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId });

  // This assertion was previously folded into an access test that passed from
  // the grant cascade alone, even if the security-boundary link stayed live.
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBeUndefined();
  });
});

test('revoking a claim removes access on the next gated read and retires active grants', async () => {
  const f = await baseFixture();
  const { projectId, assignmentId } = await insertAssignment(f.t, f.coordinatorOrganizationId, f.providerId);
  const second = await insertAssignment(f.t, f.coordinatorOrganizationId, f.providerId);
  const claimed = await inviteAndClaim(f, 'claims-revoked-firm');
  await f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId, providerId: f.providerId });
  await f.coordinator.client.mutation(grantProjectAccessToProvider, {
    projectId: second.projectId,
    providerId: f.providerId,
  });

  await expect(claimed.recipient.client.query(getAssignment, { assignmentId })).resolves.toMatchObject({
    _id: assignmentId,
  });
  await f.coordinator.client.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId });
  // This read used to make the test vacuous with respect to link clearing: the
  // cascade alone also denies it. The preceding test now pins the link write
  // independently; this test owns only gated-read and grant retirement effects.
  await expect(claimed.recipient.client.query(getAssignment, { assignmentId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
  const grants = await f.coordinator.client.query(listProjectProviderAccessGrants, {
    projectId,
    paginationOpts: firstPage,
  });
  expect(grants.page).toEqual([expect.objectContaining({ providerId: f.providerId, status: 'revoked' })]);
  const secondGrants = await f.coordinator.client.query(listProjectProviderAccessGrants, {
    projectId: second.projectId,
    paginationOpts: firstPage,
  });
  // Exercising 256 grants would make this unit test needlessly expensive. Two
  // rows prove the bounded `.take` result is actually consumed as a cascade,
  // while the source-level limit protects the transaction ceiling itself.
  expect(secondGrants.page).toEqual([expect.objectContaining({ providerId: f.providerId, status: 'revoked' })]);
});

test('revoking a pending claim invitation prevents its recipient from claiming', async () => {
  const f = await baseFixture();
  const firm = await addProviderOrganization(f, 'claims-revoked-invitation-firm');
  const invitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });

  await f.coordinator.client.mutation(revokeProviderClaimInvitation, { invitationId });
  await expect(
    firm.recipient.client.mutation(claimProviderOrganization, {
      invitationId,
      organizationId: firm.organizationId,
    }),
  ).rejects.toMatchObject({ data: { code: 'invitationNotPending' } });
});

test('an accepted claim invitation cannot be revoked while its link remains live', async () => {
  const f = await baseFixture();
  const claimed = await inviteAndClaim(f, 'claims-revoke-accepted-firm');

  await expect(
    f.coordinator.client.mutation(revokeProviderClaimInvitation, {
      invitationId: claimed.invitationId,
    }),
  ).rejects.toMatchObject({ data: { code: 'invitationNotPending' } });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(claimed.invitationId)).toMatchObject({ status: 'accepted' });
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBe(claimed.organizationId);
  });
});

test('a non-admin coordinator member cannot revoke a claim invitation', async () => {
  const f = await baseFixture();
  const planner = await provision(f.t, 'claims-revoke-planner');
  await f.coordinator.client.mutation(addMember, {
    organizationId: f.coordinatorOrganizationId,
    userId: planner.userId,
    role: 'planner',
  });
  const firm = await addProviderOrganization(f, 'claims-revoke-authority-firm');
  const invitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });

  await expect(planner.client.mutation(revokeProviderClaimInvitation, { invitationId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
});

test('membership and Provider-claim revoke paths reject the opposite invitation kind', async () => {
  const f = await baseFixture();
  const firm = await addProviderOrganization(f, 'claims-revoke-kind-firm');
  const claimInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });
  const membershipInvitationId = await f.coordinator.client.mutation(createInvitation, {
    organizationId: f.coordinatorOrganizationId,
    email: 'claims-revoke-membership@example.com',
    role: 'viewer',
  });

  await expect(
    f.coordinator.client.mutation(revokeProviderClaimInvitation, { invitationId: membershipInvitationId }),
  ).rejects.toMatchObject({ data: { code: 'invitationKindMismatch' } });
  await expect(
    f.coordinator.client.mutation(revokeInvitation, { invitationId: claimInvitationId }),
  ).rejects.toMatchObject({ data: { code: 'invitationKindMismatch' } });
});

test('the claim invitation list includes pending claims and excludes membership invitations', async () => {
  const f = await baseFixture();
  const firm = await addProviderOrganization(f, 'claims-list-firm');
  const claimInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });
  await f.coordinator.client.mutation(createInvitation, {
    organizationId: f.coordinatorOrganizationId,
    email: 'claims-list-membership@example.com',
    role: 'viewer',
  });

  const invitations = await f.coordinator.client.query(listProviderClaimInvitations, {
    organizationId: f.coordinatorOrganizationId,
    paginationOpts: firstPage,
  });
  expect(invitations.page).toEqual([
    expect.objectContaining({ _id: claimInvitationId, kind: 'providerClaim', status: 'pending' }),
  ]);
});

test('claim acceptance and link revocation audits retain the linked Organization', async () => {
  const f = await baseFixture();
  const claimed = await inviteAndClaim(f, 'claims-audit-firm');
  await f.coordinator.client.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId });

  const rows = await f.t.run(async (ctx) =>
    ctx.db
      .query('auditEvents')
      .withIndex('by_org', (q) => q.eq('organizationId', f.coordinatorOrganizationId))
      .collect(),
  );
  expect(rows.find((row) => row.action === 'providerClaim.accepted')?.metadata).toMatchObject({
    linkedOrganizationId: claimed.organizationId,
  });
  expect(rows.find((row) => row.action === 'providerClaim.revoked')?.metadata).toMatchObject({
    linkedOrganizationId: claimed.organizationId,
  });
});

test('inviting an address reveals nothing about whether an app user exists', async () => {
  const f = await baseFixture();
  const existing = await provision(f.t, 'claims-existing-account');
  const existingInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: existing.email,
  });
  const secondProviderId = await f.coordinator.client.mutation(createProvider, {
    organizationId: f.coordinatorOrganizationId,
    name: 'No Account Transport',
  });
  const absentEmail = 'claims-no-account@example.com';
  const absentInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: secondProviderId,
    email: absentEmail,
  });

  await f.t.run(async (ctx) => {
    const existingRow = await ctx.db.get(existingInvitationId);
    const absentRow = await ctx.db.get(absentInvitationId);
    expect(existingRow).toMatchObject({ kind: 'providerClaim', email: existing.email, status: 'pending' });
    expect(absentRow).toMatchObject({ kind: 'providerClaim', email: absentEmail, status: 'pending' });
  });
});

test('a Provider Organization owner gains no coordinator membership capability', async () => {
  const f = await baseFixture();
  const projectId = await f.coordinator.client.mutation(createProject, {
    organizationId: f.coordinatorOrganizationId,
    name: 'Coordinator-only project',
  });
  const claimed = await inviteAndClaim(f, 'claims-owner-axis-firm');

  await expect(claimed.recipient.client.query(getProject, { projectId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
  await f.t.run(async (ctx) => {
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) =>
        q.eq('organizationId', f.coordinatorOrganizationId).eq('userId', claimed.recipient.userId),
      )
      .unique();
    expect(membership).toBeNull();
  });
});

test('claim acceptance re-authorizes the inviter current admin rank', async () => {
  const f = await baseFixture();
  const inviter = await provision(f.t, 'claims-demoted-inviter');
  const inviterMembershipId = await f.coordinator.client.mutation(addMember, {
    organizationId: f.coordinatorOrganizationId,
    userId: inviter.userId,
    role: 'admin',
  });
  const firm = await addProviderOrganization(f, 'claims-demotion-firm');
  const invitationId = await inviter.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });
  await f.coordinator.client.mutation(changeMemberRole, {
    membershipId: inviterMembershipId,
    role: 'planner',
  });

  // The generic result is the point: the external recipient must not learn
  // that a particular coordinator member was demoted or removed (I9).
  await expect(
    firm.recipient.client.mutation(claimProviderOrganization, {
      invitationId,
      organizationId: firm.organizationId,
    }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('claim acceptance refuses an inviter who was removed from the coordinator', async () => {
  const f = await baseFixture();
  const inviter = await provision(f.t, 'claims-removed-inviter');
  const inviterMembershipId = await f.coordinator.client.mutation(addMember, {
    organizationId: f.coordinatorOrganizationId,
    userId: inviter.userId,
    role: 'admin',
  });
  const firm = await addProviderOrganization(f, 'claims-removed-inviter-firm');
  // Successful creation proves the inviter held the required authority before
  // removal; removal is the only condition introduced before acceptance.
  const invitationId = await inviter.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });
  await f.coordinator.client.mutation(removeMember, { membershipId: inviterMembershipId });

  await expect(
    firm.recipient.client.mutation(claimProviderOrganization, {
      invitationId,
      organizationId: firm.organizationId,
    }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('membership and Provider-claim acceptance paths reject the opposite invitation kind', async () => {
  const f = await baseFixture();
  const firm = await addProviderOrganization(f, 'claims-kind-firm');
  const claimInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });
  await expect(firm.recipient.client.mutation(acceptInvitation, { invitationId: claimInvitationId })).rejects.toMatchObject({
    data: { code: 'invitationKindMismatch' },
  });

  const membershipRecipient = await provision(f.t, 'claims-membership-recipient');
  const membershipInvitationId = await f.coordinator.client.mutation(createInvitation, {
    organizationId: f.coordinatorOrganizationId,
    email: membershipRecipient.email,
    role: 'viewer',
  });
  const recipientOrganizationId = await membershipRecipient.client.mutation(createOrganization, {
    name: 'Membership recipient organization',
    slug: 'claims-membership-recipient-org',
  });
  await expect(
    membershipRecipient.client.mutation(claimProviderOrganization, {
      invitationId: membershipInvitationId,
      organizationId: recipientOrganizationId,
    }),
  ).rejects.toMatchObject({ data: { code: 'invitationKindMismatch' } });
});

test('one coordinator cannot link two Provider rows to the same Organization', async () => {
  const f = await baseFixture();
  const firm = await addProviderOrganization(f, 'claims-unique-firm');
  const firstInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });
  await firm.recipient.client.mutation(claimProviderOrganization, {
    invitationId: firstInvitationId,
    organizationId: firm.organizationId,
  });

  const secondProviderId = await f.coordinator.client.mutation(createProvider, {
    organizationId: f.coordinatorOrganizationId,
    name: 'Duplicate Firm Directory Row',
  });
  const secondInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: secondProviderId,
    email: firm.recipient.email,
  });
  await expect(
    firm.recipient.client.mutation(claimProviderOrganization, {
      invitationId: secondInvitationId,
      organizationId: firm.organizationId,
    }),
  ).rejects.toMatchObject({ data: { code: 'providerClaimOrganizationConflict' } });
});

test('one firm can claim one Provider row in each independent coordinator directory', async () => {
  const f = await twoCoordinatorFixture();
  const firm = await addProviderOrganization(f, 'claims-shared-cross-coordinator-firm');
  const firstInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });
  const secondInvitationId = await f.secondCoordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.secondProviderId,
    email: firm.recipient.email,
  });

  await firm.recipient.client.mutation(claimProviderOrganization, {
    invitationId: firstInvitationId,
    organizationId: firm.organizationId,
  });
  await expect(
    firm.recipient.client.mutation(claimProviderOrganization, {
      invitationId: secondInvitationId,
      organizationId: firm.organizationId,
    }),
  ).resolves.toBeNull();
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBe(firm.organizationId);
    expect((await ctx.db.get(f.secondProviderId))?.linkedOrganizationId).toBe(firm.organizationId);
  });
});

test("revoking one coordinator's claim leaves the other coordinator's grant active", async () => {
  const f = await twoCoordinatorFixture();
  const firm = await addProviderOrganization(f, 'claims-cascade-isolation-firm');
  const firstInvitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });
  const secondInvitationId = await f.secondCoordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.secondProviderId,
    email: firm.recipient.email,
  });
  await firm.recipient.client.mutation(claimProviderOrganization, {
    invitationId: firstInvitationId,
    organizationId: firm.organizationId,
  });
  await firm.recipient.client.mutation(claimProviderOrganization, {
    invitationId: secondInvitationId,
    organizationId: firm.organizationId,
  });
  const firstProjectId = await f.coordinator.client.mutation(createProject, {
    organizationId: f.coordinatorOrganizationId,
    name: 'First coordinator project',
  });
  const secondProjectId = await f.secondCoordinator.client.mutation(createProject, {
    organizationId: f.secondCoordinatorOrganizationId,
    name: 'Second coordinator project',
  });
  const firstGrantId = await f.coordinator.client.mutation(grantProjectAccessToProvider, {
    projectId: firstProjectId,
    providerId: f.providerId,
  });
  const secondGrantId = await f.secondCoordinator.client.mutation(grantProjectAccessToProvider, {
    projectId: secondProjectId,
    providerId: f.secondProviderId,
  });

  await f.coordinator.client.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId });

  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(firstGrantId)).toMatchObject({ status: 'revoked' });
    expect(await ctx.db.get(secondGrantId)).toMatchObject({ status: 'active' });
  });
});

test('an archived Provider cannot be invited for a claim', async () => {
  const f = await baseFixture();
  await f.coordinator.client.mutation(archiveProvider, { providerId: f.providerId });

  await expect(
    f.coordinator.client.mutation(inviteProviderOrganization, {
      providerId: f.providerId,
      email: 'claims-archived-invite@example.com',
    }),
  ).rejects.toMatchObject({ data: { code: 'providerArchived' } });
});

test('an already-claimed Provider cannot receive another claim invitation', async () => {
  const f = await baseFixture();
  await inviteAndClaim(f, 'claims-already-claimed-firm');

  await expect(
    f.coordinator.client.mutation(inviteProviderOrganization, {
      providerId: f.providerId,
      email: 'claims-already-claimed-other@example.com',
    }),
  ).rejects.toMatchObject({ data: { code: 'providerClaimAlreadyClaimed' } });
});

test('a duplicate pending Provider claim invitation for one address is a conflict', async () => {
  const f = await baseFixture();
  const email = 'claims-duplicate-pending@example.com';
  const invitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email,
  });

  await expect(
    f.coordinator.client.mutation(inviteProviderOrganization, { providerId: f.providerId, email }),
  ).rejects.toMatchObject({ data: { code: 'conflict' } });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(invitationId)).toMatchObject({ status: 'pending' });
  });
});

test('a pending claim cannot attach an archived Provider', async () => {
  const f = await baseFixture();
  const firm = await addProviderOrganization(f, 'claims-archived-accept-firm');
  const invitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: firm.recipient.email,
  });
  await f.coordinator.client.mutation(archiveProvider, { providerId: f.providerId });

  await expect(
    firm.recipient.client.mutation(claimProviderOrganization, {
      invitationId,
      organizationId: firm.organizationId,
    }),
  ).rejects.toMatchObject({ data: { code: 'providerArchived' } });
});

test('a coordinator cannot claim its own Organization as an external Provider', async () => {
  const f = await baseFixture();
  const invitationId = await f.coordinator.client.mutation(inviteProviderOrganization, {
    providerId: f.providerId,
    email: f.coordinator.email,
  });

  await expect(
    f.coordinator.client.mutation(claimProviderOrganization, {
      invitationId,
      organizationId: f.coordinatorOrganizationId,
    }),
  ).rejects.toMatchObject({ data: { code: 'providerGrantSelfReference' } });
});

test('revoking an unclaimed Provider writes no provider-claim revocation audit', async () => {
  const f = await baseFixture();

  await expect(
    f.coordinator.client.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId }),
  ).resolves.toBeNull();
  const revocationAudits = await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) =>
        q
          .eq('organizationId', f.coordinatorOrganizationId)
          .eq('entityType', 'provider')
          .eq('entityId', f.providerId),
      )
      .collect();
    return rows.filter((row) => row.action === 'providerClaim.revoked');
  });
  expect(revocationAudits).toEqual([]);
});

test('claim revocation preserves an already-revoked grant timestamp', async () => {
  const f = await baseFixture();
  await inviteAndClaim(f, 'claims-preserve-revoked-at-firm');
  const projectId = await f.coordinator.client.mutation(createProject, {
    organizationId: f.coordinatorOrganizationId,
    name: 'Preserve revokedAt project',
  });
  const grantId = await f.coordinator.client.mutation(grantProjectAccessToProvider, {
    projectId,
    providerId: f.providerId,
  });
  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId });
  const originalRevokedAt = await f.t.run(async (ctx) => (await ctx.db.get(grantId))?.revokedAt);
  expect(originalRevokedAt).toBeTypeOf('number');
  await new Promise<void>((resolve) => setTimeout(resolve, 5));

  await f.coordinator.client.mutation(revokeProviderOrganizationClaim, { providerId: f.providerId });

  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(grantId)).toMatchObject({ status: 'revoked', revokedAt: originalRevokedAt });
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBeUndefined();
  });
});

/**
 * The invitation TTL bounds an unanswered OFFER, not a completed link. Ordering
 * the expiry check ahead of the idempotent replay made every claim stop
 * replaying fourteen days after it was accepted — steady state, not an edge
 * case — and the immediate-retry test above could never see it.
 */
test('an accepted claim still replays idempotently after its own TTL has lapsed', async () => {
  const f = await baseFixture();
  const claimed = await inviteAndClaim(f, 'claims-lapsed-ttl-firm');
  await f.t.run(async (ctx) => {
    await ctx.db.patch(claimed.invitationId, { expiresAt: Date.now() - 1000 });
  });
  await expect(
    claimed.recipient.client.mutation(claimProviderOrganization, {
      invitationId: claimed.invitationId,
      organizationId: claimed.organizationId,
    }),
  ).resolves.toBeNull();
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.providerId))?.linkedOrganizationId).toBe(claimed.organizationId);
  });
});
