import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { modules } from './helpers';

const getCurrentUser = api.auth.queries.getCurrentUser;
const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const listMyOrganizations = api.organizations.queries.listMyOrganizations;
const listBuiltinFieldDefinitions = api.fields.queries.listBuiltinFieldDefinitions;

const UNAUTHENTICATED_ERROR = 'Unauthenticated';
const NOT_FOUND_OR_INACCESSIBLE = 'Not found or inaccessible';
const ISSUER = 'https://example.clerk.accounts.dev';

const clerkIdentity = {
  issuer: ISSUER,
  subject: 'user_123',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  emailVerified: true,
};

test('unauthenticated current-user reads return null and provisioning is rejected', async () => {
  const t = convexTest(schema, modules);

  await expect(t.query(getCurrentUser, {})).resolves.toBeNull();
  await expect(t.mutation(ensureUser, {})).rejects.toMatchObject({
    data: UNAUTHENTICATED_ERROR,
  });
});

test('authenticated but unprovisioned identity resolves to null', async () => {
  const t = convexTest(schema, modules);

  await expect(t.withIdentity(clerkIdentity).query(getCurrentUser, {})).resolves.toBeNull();
});

test('ensureUser creates and resolves the authenticated app user', async () => {
  const t = convexTest(schema, modules);
  const authenticated = t.withIdentity(clerkIdentity);

  const userId = await authenticated.mutation(ensureUser, {});
  const user = await authenticated.query(getCurrentUser, {});

  expect(user).toMatchObject({
    _id: userId,
    name: clerkIdentity.name,
    email: clerkIdentity.email,
  });

  // Identity keys are internal: the row namespaces the subject by full issuer,
  // and the public shape does not expose them.
  await t.run(async (ctx) => {
    const row = await ctx.db.get(userId);
    expect(row).toMatchObject({ authProvider: ISSUER, authSubject: clerkIdentity.subject });
  });
  expect(user).not.toHaveProperty('authProvider');
});

test('ensureUser is idempotent and email is not an identity key', async () => {
  const t = convexTest(schema, modules);
  const firstIdentity = t.withIdentity(clerkIdentity);

  const firstId = await firstIdentity.mutation(ensureUser, {});
  const repeatedId = await firstIdentity.mutation(ensureUser, {});
  const secondId = await t
    .withIdentity({ ...clerkIdentity, subject: 'user_456', name: 'Grace Hopper' })
    .mutation(ensureUser, {});

  expect(repeatedId).toBe(firstId);
  expect(secondId).not.toBe(firstId);
  await t.run(async (ctx) => {
    const users = await ctx.db.query('users').collect();
    expect(users).toHaveLength(2);
  });
});

test('same subject under two issuers resolves to two distinct users', async () => {
  const t = convexTest(schema, modules);

  const prodId = await t.withIdentity(clerkIdentity).mutation(ensureUser, {});
  const stagingId = await t
    .withIdentity({ ...clerkIdentity, issuer: 'https://staging.clerk.accounts.dev' })
    .mutation(ensureUser, {});

  expect(stagingId).not.toBe(prodId);
});

test('a trailing slash on the issuer is normalized, so one identity stays one user', async () => {
  const t = convexTest(schema, modules);

  // Providers are not consistent about the trailing slash on the `iss` claim
  // (Clerk's JWT template and the discovery document differ). If the adapter
  // stored the issuer verbatim, the same person arriving with and without it
  // would silently fork into two app users — and the second one would hold none
  // of the first one's organization memberships.
  const withSlash = await t.withIdentity({ ...clerkIdentity, issuer: `${ISSUER}/` }).mutation(ensureUser, {});
  const withoutSlash = await t.withIdentity(clerkIdentity).mutation(ensureUser, {});

  expect(withoutSlash).toBe(withSlash);
  await t.run(async (ctx) => {
    const users = await ctx.db.query('users').withIndex('by_provider_subject').collect();
    expect(users).toHaveLength(1);
    // The stored provider is the normalized form, whichever spelling arrived first.
    expect(users[0]).toMatchObject({ authProvider: ISSUER, authSubject: clerkIdentity.subject });
    expect(users[0]?.authProvider.endsWith('/')).toBe(false);
  });

  // The consequence that actually matters: an organization created under one
  // spelling is still the caller's under the other.
  await t.withIdentity({ ...clerkIdentity, issuer: `${ISSUER}/` }).mutation(createOrganization, { name: 'Acme', slug: 'issuer-slash' });
  const mine = await t.withIdentity(clerkIdentity).query(listMyOrganizations, {});
  expect(mine.map((entry) => entry.organization.slug)).toEqual(['issuer-slash']);
});

test('an authenticated identity that never called ensureUser is refused with the generic error', async () => {
  const t = convexTest(schema, modules);
  const unprovisioned = t.withIdentity({ ...clerkIdentity, subject: 'user_never_provisioned' });

  // Authenticated is not provisioned: the I1 chain stops at identity → app user,
  // and the caller learns nothing beyond the generic error (I9). `getCurrentUser`
  // is the one deliberate exception, because "are you provisioned?" is its job.
  await expect(unprovisioned.query(getCurrentUser, {})).resolves.toBeNull();
  await expect(unprovisioned.query(listMyOrganizations, {})).rejects.toMatchObject({ data: NOT_FOUND_OR_INACCESSIBLE });
  await expect(unprovisioned.mutation(createOrganization, { name: 'Ghost', slug: 'unprovisioned-org' })).rejects.toMatchObject({
    data: NOT_FOUND_OR_INACCESSIBLE,
  });
  await expect(unprovisioned.query(listBuiltinFieldDefinitions, { paginationOpts: { numItems: 10, cursor: null } })).rejects.toMatchObject({
    data: NOT_FOUND_OR_INACCESSIBLE,
  });
});

test('ensureUser syncs changed name and ignores unverified email', async () => {
  const t = convexTest(schema, modules);

  const userId = await t.withIdentity(clerkIdentity).mutation(ensureUser, {});
  await t
    .withIdentity({
      ...clerkIdentity,
      name: 'Ada King',
      email: 'attacker@example.com',
      emailVerified: false,
    })
    .mutation(ensureUser, {});

  await t.run(async (ctx) => {
    const row = await ctx.db.get(userId);
    expect(row).toMatchObject({ name: 'Ada King', email: clerkIdentity.email });
  });
});
