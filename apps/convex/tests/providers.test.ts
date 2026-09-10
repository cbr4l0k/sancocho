import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProvider = api.providers.mutations.createProvider;
const updateProvider = api.providers.mutations.updateProvider;
const archiveProvider = api.providers.mutations.archiveProvider;
const deleteProvider = api.providers.mutations.deleteProvider;
const getProvider = api.providers.queries.getProvider;
const listProviders = api.providers.queries.listProviders;

const inaccessible = 'notFoundOrInaccessible';
const unauthenticated = 'unauthenticated';
const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 10, cursor: null };

type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(ensureUser, {});
  return { client, userId };
}

async function fixture(t: SchemaTest) {
  const owner = await provision(t, 'providers-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'providers-test' });
  const providerId: Id<'providers'> = await owner.client.mutation(createProvider, {
    organizationId,
    name: 'Acme SAS',
    legalName: 'Acme Sociedad por Acciones Simplificada',
    taxId: '900123456-7',
    contactName: 'Ana Restrepo',
    contactEmail: 'ana@acme.example',
    contactPhone: '+57 300 000 0000',
    notes: 'Preferred vans supplier',
  });
  return { owner, organizationId, providerId };
}

function providerAudits(t: SchemaTest, organizationId: Id<'organizations'>, providerId: Id<'providers'>) {
  return t.run(async (ctx) =>
    ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'provider').eq('entityId', providerId))
      .collect(),
  );
}

/**
 * Directly establishes claim state because these Provider catalogue tests
 * isolate the derived discriminator from #86's separately-covered invitation
 * flow. The production link remains writable only through that flow.
 */
function linkProvider(t: SchemaTest, providerId: Id<'providers'>, linkedOrganizationId: Id<'organizations'>) {
  return t.run(async (ctx) => ctx.db.patch(providerId, { linkedOrganizationId }));
}

test('Provider creation stores the trimmed name, derives searchable text, and starts unclaimed', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);

  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject({
      organizationId,
      name: 'Acme SAS',
      legalName: 'Acme Sociedad por Acciones Simplificada',
      taxId: '900123456-7',
      contactName: 'Ana Restrepo',
      contactEmail: 'ana@acme.example',
      contactPhone: '+57 300 000 0000',
      notes: 'Preferred vans supplier',
      // Server-derived from `name`; never client-supplied (I4).
      searchText: 'acme sas',
      status: 'active',
    });
    // Every Provider is born unclaimed: `createProvider` never writes the link.
    expect((await ctx.db.get(providerId))?.linkedOrganizationId).toBeUndefined();
  });
  await expect(owner.client.query(getProvider, { providerId })).resolves.toMatchObject({
    _id: providerId,
    name: 'Acme SAS',
    claimState: 'unclaimed',
  });

  const trimmedId = await owner.client.mutation(createProvider, { organizationId, name: '  Andes Buses  ' });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(trimmedId)).toMatchObject({ name: 'Andes Buses', searchText: 'andes buses' });
  });
});

test('Provider names are unique per organization after case normalization', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);

  // Real formatting variants of the same firm, not a byte-identical resubmit:
  // trimming, case folding, and punctuation collapse all resolve to one entry.
  for (const duplicate of ['Acme SAS', '  acme sas  ', 'ACME   Sas']) {
    await expect(owner.client.mutation(createProvider, { organizationId, name: duplicate })).rejects.toMatchObject({
      data: { code: 'conflict' },
    });
  }
  // A genuinely different firm is unaffected...
  const otherId = await owner.client.mutation(createProvider, { organizationId, name: 'Acme Logistics' });
  // ...and the constraint is per-tenant, not global.
  const otherOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'providers-name-scope' });
  await expect(owner.client.mutation(createProvider, { organizationId: otherOrganizationId, name: 'acme sas' })).resolves.toBeDefined();

  // A rename cannot edit its way past the same rule.
  await expect(owner.client.mutation(updateProvider, { providerId: otherId, name: 'ACME sas' })).rejects.toMatchObject({
    data: { code: 'conflict' },
  });
  await expect(owner.client.mutation(updateProvider, { providerId: otherId, name: 'Acme Logistica' })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject({ name: 'Acme SAS' });
  });
});

test('Provider free-form columns are bounded', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);

  await expect(owner.client.mutation(createProvider, { organizationId, name: '   ' })).rejects.toMatchObject({
    data: { code: 'entityNameInvalid' },
  });
  const tooLong = 'x'.repeat(201);
  const overlongDetails = [
    { legalName: tooLong },
    { taxId: tooLong },
    { contactName: tooLong },
    { contactEmail: tooLong },
    { contactPhone: tooLong },
  ];
  for (const [index, detail] of overlongDetails.entries()) {
    await expect(owner.client.mutation(createProvider, { organizationId, name: `Bounded ${index}`, ...detail })).rejects.toMatchObject({
      data: { code: 'providerDetailTooLong' },
    });
    await expect(owner.client.mutation(updateProvider, { providerId, ...detail })).rejects.toMatchObject({
      data: { code: 'providerDetailTooLong' },
    });
  }
  await expect(
    owner.client.mutation(createProvider, { organizationId, name: 'Bounded notes', notes: 'x'.repeat(2001) }),
  ).rejects.toMatchObject({ data: { code: 'providerNotesTooLong' } });
  await expect(owner.client.mutation(updateProvider, { providerId, notes: 'x'.repeat(2001) })).rejects.toMatchObject({
    data: { code: 'providerNotesTooLong' },
  });
});

test('an admin can manage Providers and every lifecycle write is audited', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await fixture(t);
  const admin = await provision(t, 'providers-admin');
  await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });

  const providerId = await admin.client.mutation(createProvider, { organizationId, name: '  Andes Fleet  ' });
  await admin.client.mutation(updateProvider, {
    providerId,
    name: '  Andes Fleet SAS  ',
    legalName: 'Andes Fleet SAS',
    contactEmail: 'ops@andes.example',
    notes: 'Night shift only',
  });
  await admin.client.mutation(archiveProvider, { providerId });
  // Archiving is idempotent and records no second row.
  await expect(admin.client.mutation(archiveProvider, { providerId })).resolves.toBeNull();

  const audits = await providerAudits(t, organizationId, providerId);
  expect(audits.map((audit) => audit.action).sort()).toEqual(['provider.archived', 'provider.created', 'provider.updated']);
  expect(audits.every((audit) => audit.actorUserId === admin.userId)).toBe(true);
  expect(audits.every((audit) => audit.entityType === 'provider' && audit.entityId === providerId)).toBe(true);
  expect(audits.find((audit) => audit.action === 'provider.created')?.metadata).toMatchObject({ name: 'Andes Fleet' });
  // Every updated column is actually written, not merely reported as changed.
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject({
      name: 'Andes Fleet SAS',
      legalName: 'Andes Fleet SAS',
      contactEmail: 'ops@andes.example',
      notes: 'Night shift only',
      searchText: 'andes fleet sas',
    });
  });
  expect(audits.find((audit) => audit.action === 'provider.updated')?.metadata).toMatchObject({
    changedFields: 'name,legalName,contactEmail,notes',
  });
  expect(audits.find((audit) => audit.action === 'provider.archived')?.metadata).toMatchObject({ previousStatus: 'active' });
  await expect(admin.client.query(getProvider, { providerId })).resolves.toMatchObject({ name: 'Andes Fleet SAS', status: 'archived' });
});

test('deleting a Provider records an audit row naming the row it destroyed', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await fixture(t);
  const providerId = await owner.client.mutation(createProvider, { organizationId, name: 'Doomed Transport' });
  await owner.client.mutation(archiveProvider, { providerId });
  await owner.client.mutation(deleteProvider, { providerId });

  await expect(owner.client.query(getProvider, { providerId })).rejects.toMatchObject({ data: { code: inaccessible } });
  const audits = await providerAudits(t, organizationId, providerId);
  expect(audits.map((audit) => audit.action)).toContain('provider.deleted');
  expect(audits.find((audit) => audit.action === 'provider.deleted')).toMatchObject({
    actorUserId: owner.userId,
    entityType: 'provider',
    entityId: providerId,
    metadata: { name: 'Doomed Transport' },
  });
});

test('a planner is below the Provider configuration floor on every write', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  const planner = await provision(t, 'providers-planner');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });

  await expect(planner.client.mutation(createProvider, { organizationId, name: 'Forbidden' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(updateProvider, { providerId, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(archiveProvider, { providerId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(deleteProvider, { providerId })).rejects.toMatchObject({ data: { code: inaccessible } });
  // Reads stay open to any member of the tenant.
  await expect(planner.client.query(getProvider, { providerId })).resolves.toMatchObject({ _id: providerId });
  await expect(planner.client.query(listProviders, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({
    page: [expect.objectContaining({ _id: providerId })],
  });
  // Nothing the planner attempted reached the database.
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject({ name: 'Acme SAS', status: 'active' });
  });
});

test('every public Provider function is opaque to unauthenticated, fabricated, foreign, and non-member callers', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  const outsider = await provision(t, 'providers-outsider');
  const missingProviderId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('providers', {
      organizationId,
      name: 'Temporary',
      searchText: 'temporary',
      status: 'active',
    });
    await ctx.db.delete(id);
    return id;
  });

  for (const id of [providerId, missingProviderId]) {
    await expect(t.query(getProvider, { providerId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(updateProvider, { providerId: id, name: 'No' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(archiveProvider, { providerId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(deleteProvider, { providerId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(outsider.client.query(getProvider, { providerId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(updateProvider, { providerId: id, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(archiveProvider, { providerId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(deleteProvider, { providerId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  const goneOrganizationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', { name: 'Gone', slug: 'providers-gone' });
    await ctx.db.delete(id);
    return id;
  });
  for (const orgId of [organizationId, goneOrganizationId]) {
    await expect(t.query(listProviders, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(createProvider, { organizationId: orgId, name: 'Intruder' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(outsider.client.query(listProviders, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(createProvider, { organizationId: orgId, name: 'Intruder' })).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  // A member in good standing OF ANOTHER TENANT is exactly as opaque as a stranger.
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'providers-foreign' });
  await owner.client.mutation(addMember, { organizationId: foreignOrganizationId, userId: outsider.userId, role: 'owner' });
  await expect(outsider.client.query(getProvider, { providerId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.query(listProviders, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(createProvider, { organizationId, name: 'Cross tenant' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(updateProvider, { providerId, name: 'Cross tenant' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(archiveProvider, { providerId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(deleteProvider, { providerId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject({ name: 'Acme SAS', status: 'active' });
  });
});

test('Provider lists paginate with a continuation cursor and remain tenant-isolated', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  const secondId = await owner.client.mutation(createProvider, { organizationId, name: 'Bogota Vans' });
  const thirdId = await owner.client.mutation(createProvider, { organizationId, name: 'Cartagena Coaches' });
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'providers-page-foreign' });
  const foreignId = await owner.client.mutation(createProvider, { organizationId: foreignOrganizationId, name: 'Foreign Fleet' });

  const first = await owner.client.query(listProviders, { organizationId, paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  expect(first.continueCursor).not.toBe('');
  const second = await owner.client.query(listProviders, { organizationId, paginationOpts: { numItems: 2, cursor: first.continueCursor } });
  expect(second.page).toHaveLength(1);
  expect(second.isDone).toBe(true);
  expect([...first.page, ...second.page].map((row) => row._id).sort()).toEqual([providerId, secondId, thirdId].sort());
  expect([...first.page, ...second.page].every((row) => row.organizationId === organizationId)).toBe(true);
  expect([...first.page, ...second.page].every((row) => row.claimState === 'unclaimed')).toBe(true);
  await expect(owner.client.query(listProviders, { organizationId: foreignOrganizationId, paginationOpts: firstPage })).resolves.toMatchObject({
    page: [{ _id: foreignId }],
  });
});

test('Provider status filtering narrows the query, not an already-fetched page', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await fixture(t);
  // Interleaved on purpose: a filter applied to an already-fetched page would
  // return at most one row for `numItems: 2`, so a short first page is the
  // signature of a post-page filter.
  const active: Id<'providers'>[] = [];
  const archived: Id<'providers'>[] = [];
  for (let index = 0; index < 3; index += 1) {
    active.push(await owner.client.mutation(createProvider, { organizationId, name: `Active ${index}` }));
    const archivedId = await owner.client.mutation(createProvider, { organizationId, name: `Archived ${index}` });
    await owner.client.mutation(archiveProvider, { providerId: archivedId });
    archived.push(archivedId);
  }

  const first = await owner.client.query(listProviders, { organizationId, paginationOpts: { numItems: 2, cursor: null }, status: 'active' });
  expect(first.page).toHaveLength(2);
  expect(first.page.every((row) => row.status === 'active')).toBe(true);
  const second = await owner.client.query(listProviders, {
    organizationId,
    paginationOpts: { numItems: 2, cursor: first.continueCursor },
    status: 'active',
  });
  // The fixture's own Provider is active too, so four active rows in total.
  expect([...first.page, ...second.page]).toHaveLength(4);
  expect([...first.page, ...second.page].map((row) => row._id)).toEqual(expect.arrayContaining(active));

  const archivedPage = await owner.client.query(listProviders, { organizationId, paginationOpts: { numItems: 2, cursor: null }, status: 'archived' });
  expect(archivedPage.page).toHaveLength(2);
  expect(archivedPage.page.every((row) => row.status === 'archived')).toBe(true);
  expect(archived).toHaveLength(3);
});

test('Provider name search narrows the query over server-derived text', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  for (let index = 0; index < 4; index += 1) {
    await owner.client.mutation(createProvider, { organizationId, name: `Ordinary ${index}` });
  }
  const searchedId = await owner.client.mutation(createProvider, { organizationId, name: 'Transportes Medellín' });

  // `numItems: 2` would return nothing at all if the term were applied to an
  // already-fetched page: the match is the last row created.
  await expect(owner.client.query(listProviders, { organizationId, paginationOpts: { numItems: 2, cursor: null }, search: 'medellin' })).resolves.toMatchObject({
    page: [{ _id: searchedId }],
  });
  // Diacritics are folded on both sides by the shared normalizer.
  await expect(owner.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'MEDELLÍN' })).resolves.toMatchObject({
    page: [{ _id: searchedId }],
  });
  // Search composes with the status filter on the same index.
  await owner.client.mutation(archiveProvider, { providerId: searchedId });
  await expect(owner.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'medellin', status: 'active' })).resolves.toMatchObject({ page: [] });
  await expect(owner.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'medellin', status: 'archived' })).resolves.toMatchObject({
    page: [{ _id: searchedId }],
  });

  // A rename re-derives the stored text, so search follows the current name.
  await owner.client.mutation(updateProvider, { providerId, name: 'Bogotá Acme' });
  await expect(owner.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'bogota' })).resolves.toMatchObject({
    page: [{ _id: providerId }],
  });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(providerId))?.searchText).toBe('bogota acme');
  });
  await expect(owner.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'x'.repeat(101) })).rejects.toMatchObject({
    data: { code: 'searchTermTooLong' },
  });
});

test('archived Providers stay readable but refuse every update', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  await owner.client.mutation(archiveProvider, { providerId });

  const archived = { data: { code: 'providerArchived' } };
  await expect(owner.client.mutation(updateProvider, { providerId, name: 'No' })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateProvider, { providerId, notes: 'No' })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateProvider, { providerId, legalName: 'No' })).rejects.toMatchObject(archived);
  await expect(owner.client.mutation(updateProvider, { providerId, contactEmail: 'no@example.com' })).rejects.toMatchObject(archived);
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject({ name: 'Acme SAS', notes: 'Preferred vans supplier' });
  });
  await expect(owner.client.query(getProvider, { providerId })).resolves.toMatchObject({ status: 'archived' });
  await expect(owner.client.query(listProviders, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({
    page: [expect.objectContaining({ _id: providerId, status: 'archived' })],
  });
});

test('an unclaimed, unreferenced Provider deletes only after it is archived', async () => {
  const t = convexTest(schema, modules);
  const { owner, providerId } = await fixture(t);

  await expect(owner.client.mutation(deleteProvider, { providerId })).rejects.toMatchObject({ data: { code: 'providerArchiveRequired' } });
  await owner.client.mutation(archiveProvider, { providerId });
  await expect(owner.client.mutation(deleteProvider, { providerId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toBeNull();
  });
  await expect(owner.client.query(getProvider, { providerId })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('a claimed Provider cannot be deleted', async () => {
  const t = convexTest(schema, modules);
  const { owner, providerId } = await fixture(t);
  const providerOrganizationId = await owner.client.mutation(createOrganization, { name: 'Acme Transport', slug: 'providers-claimed-org' });
  await linkProvider(t, providerId, providerOrganizationId);
  await owner.client.mutation(archiveProvider, { providerId });

  await expect(owner.client.mutation(deleteProvider, { providerId })).rejects.toMatchObject({ data: { code: 'providerDeleteBlocked' } });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).not.toBeNull();
  });

  // Live rather than sticky: releasing the claim (#86's revocation) releases the row.
  await t.run(async (ctx) => ctx.db.patch(providerId, { linkedOrganizationId: undefined }));
  await expect(owner.client.mutation(deleteProvider, { providerId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toBeNull();
  });
});

test('the claim-state discriminator tracks the link in both directions and on every read path', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  const unclaimedId = await owner.client.mutation(createProvider, { organizationId, name: 'Still Unclaimed' });
  const providerOrganizationId = await owner.client.mutation(createOrganization, { name: 'Acme Transport', slug: 'providers-claim-state' });

  await expect(owner.client.query(getProvider, { providerId })).resolves.toMatchObject({ claimState: 'unclaimed' });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(providerId))?.linkedOrganizationId).toBeUndefined();
  });

  await linkProvider(t, providerId, providerOrganizationId);
  await expect(owner.client.query(getProvider, { providerId })).resolves.toMatchObject({
    claimState: 'claimed',
    linkedOrganizationId: providerOrganizationId,
  });
  await expect(owner.client.query(getProvider, { providerId: unclaimedId })).resolves.toMatchObject({ claimState: 'unclaimed' });

  // The list path derives it exactly the same way, for both states at once.
  const listed = await owner.client.query(listProviders, { organizationId, paginationOpts: firstPage });
  expect(listed.page.map((row) => [row._id, row.claimState]).sort()).toEqual(
    [
      [providerId, 'claimed'],
      [unclaimedId, 'unclaimed'],
    ].sort(),
  );

  // Revoking returns it to the unclaimed state; nothing is remembered.
  await t.run(async (ctx) => ctx.db.patch(providerId, { linkedOrganizationId: undefined }));
  await expect(owner.client.query(getProvider, { providerId })).resolves.toMatchObject({ claimState: 'unclaimed' });
});

test('the generic Provider update cannot set, replace, or clear the claim link', async () => {
  const t = convexTest(schema, modules);
  const { owner, providerId } = await fixture(t);
  const providerOrganizationId = await owner.client.mutation(createOrganization, { name: 'Acme Transport', slug: 'providers-claim-write' });
  const rivalOrganizationId = await owner.client.mutation(createOrganization, { name: 'Rival Transport', slug: 'providers-claim-rival' });

  // The argument is not part of the contract: the compiler refuses it (hence
  // the expected type error) and the mutation's own validator refuses it too.
  await expect(
    owner.client.mutation(updateProvider, {
      providerId,
      // @ts-expect-error `linkedOrganizationId` is not an argument of the generic update; #86 owns the claim.
      linkedOrganizationId: providerOrganizationId,
    }),
  ).rejects.toThrow();
  await t.run(async (ctx) => {
    expect((await ctx.db.get(providerId))?.linkedOrganizationId).toBeUndefined();
  });
  await expect(owner.client.query(getProvider, { providerId })).resolves.toMatchObject({ claimState: 'unclaimed' });

  // Once claimed, an ordinary update neither replaces nor clears the link.
  await linkProvider(t, providerId, providerOrganizationId);
  await expect(
    owner.client.mutation(updateProvider, {
      providerId,
      name: 'Acme SAS renamed',
      // @ts-expect-error same contract, attempted as a replacement rather than a first claim.
      linkedOrganizationId: rivalOrganizationId,
    }),
  ).rejects.toThrow();
  await owner.client.mutation(updateProvider, { providerId, name: 'Acme SAS renamed', notes: 'Now claimed' });
  await expect(owner.client.query(getProvider, { providerId })).resolves.toMatchObject({
    name: 'Acme SAS renamed',
    notes: 'Now claimed',
    claimState: 'claimed',
    linkedOrganizationId: providerOrganizationId,
  });
});

test('Provider search is scoped to the caller tenant', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await fixture(t);
  // The same term matches a row in each tenant, so a search expression that
  // lost its `organizationId` filter would return the foreign row too. The
  // status-narrowed variant is exercised for the same reason: it is a second,
  // independently deletable `.eq` on the same expression.
  const localId = await owner.client.mutation(createProvider, { organizationId, name: 'Andes Fleet' });
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Rival', slug: 'providers-search-scope' });
  const foreignId = await owner.client.mutation(createProvider, { organizationId: foreignOrganizationId, name: 'Andes Rival' });

  const local = await owner.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'andes' });
  expect(local.page.map((row) => row._id)).toEqual([localId]);
  const localActive = await owner.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'andes', status: 'active' });
  expect(localActive.page.map((row) => row._id)).toEqual([localId]);

  // ...and symmetrically from the other side, so neither tenant is special.
  const foreign = await owner.client.query(listProviders, { organizationId: foreignOrganizationId, paginationOpts: firstPage, search: 'andes' });
  expect(foreign.page.map((row) => row._id)).toEqual([foreignId]);
});

test('authorization outranks every lifecycle and input error a Provider call could raise', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  const outsider = await provision(t, 'providers-precedence-outsider');
  const planner = await provision(t, 'providers-precedence-planner');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });

  // An ARCHIVED row: `providerArchived` must never be what an unauthorized
  // caller learns, or the archive flag becomes a tenant probe (I9).
  const archivedId = await owner.client.mutation(createProvider, { organizationId, name: 'Archived Probe' });
  await owner.client.mutation(archiveProvider, { providerId: archivedId });
  await expect(outsider.client.mutation(updateProvider, { providerId: archivedId, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(updateProvider, { providerId: archivedId, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });

  // A CLAIMED row: neither `providerDeleteBlocked` nor `providerArchiveRequired` leaks.
  const claimedOrganizationId = await owner.client.mutation(createOrganization, { name: 'Claimed', slug: 'providers-precedence-claim' });
  await linkProvider(t, archivedId, claimedOrganizationId);
  await expect(outsider.client.mutation(deleteProvider, { providerId: archivedId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(deleteProvider, { providerId: archivedId })).rejects.toMatchObject({ data: { code: inaccessible } });
  // An ACTIVE row: `providerArchiveRequired` does not leak either.
  await expect(outsider.client.mutation(deleteProvider, { providerId })).rejects.toMatchObject({ data: { code: inaccessible } });

  // Deliberately invalid INPUT from an unauthorized caller: the generic error
  // must win, or input validation becomes an oracle for organizations the
  // caller cannot reach.
  await expect(outsider.client.mutation(createProvider, { organizationId, name: '   ' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(createProvider, { organizationId, name: '   ' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(createProvider, { organizationId, name: 'Ok', notes: 'x'.repeat(2001) })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(updateProvider, { providerId, legalName: 'x'.repeat(201) })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    outsider.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'x'.repeat(101) }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    t.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'x'.repeat(101) }),
  ).rejects.toMatchObject({ data: { code: unauthenticated } });
});

test('Provider detail columns are stored trimmed and read back in full', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await fixture(t);
  const providerId = await owner.client.mutation(createProvider, {
    organizationId,
    name: 'Detail Firm',
    legalName: '  Detail Firm SAS  ',
    taxId: '  901000000-1  ',
    contactName: '  Beatriz Gómez  ',
    contactEmail: '  beatriz@detail.example  ',
    contactPhone: '  +57 301 111 1111  ',
    notes: '  Two vans on standby  ',
  });
  const stored = {
    legalName: 'Detail Firm SAS',
    taxId: '901000000-1',
    contactName: 'Beatriz Gómez',
    contactEmail: 'beatriz@detail.example',
    contactPhone: '+57 301 111 1111',
    notes: 'Two vans on standby',
  };
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject(stored);
  });
  await expect(owner.client.query(getProvider, { providerId })).resolves.toMatchObject(stored);

  // Each column is independently writable and independently persisted.
  const replaced = {
    legalName: 'Detail Firm Ltda',
    taxId: '901000000-2',
    contactName: 'Carlos Rueda',
    contactEmail: 'carlos@detail.example',
    contactPhone: '+57 302 222 2222',
    notes: 'Three vans on standby',
  };
  await owner.client.mutation(updateProvider, { providerId, ...replaced });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject(replaced);
  });
  await expect(owner.client.query(getProvider, { providerId })).resolves.toMatchObject(replaced);
});

test('Provider bounds accept their exact limit and the trimmed value is what is measured', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await fixture(t);
  const exactName = 'n'.repeat(200);
  const exactDetail = 'd'.repeat(200);
  const exactNotes = 'x'.repeat(2000);

  const providerId = await owner.client.mutation(createProvider, {
    organizationId,
    name: exactName,
    legalName: exactDetail,
    notes: exactNotes,
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject({ name: exactName, legalName: exactDetail, notes: exactNotes });
  });
  // Padding is removed before the bound is applied, so it can never smuggle a
  // value past a rule it was not actually held to.
  await expect(owner.client.mutation(updateProvider, { providerId, legalName: `  ${exactDetail}  ` })).resolves.toBeNull();
  await expect(owner.client.mutation(updateProvider, { providerId, legalName: `${exactDetail}d` })).rejects.toMatchObject({
    data: { code: 'providerDetailTooLong' },
  });
  await expect(owner.client.mutation(updateProvider, { providerId, notes: `${exactNotes}x` })).rejects.toMatchObject({
    data: { code: 'providerNotesTooLong' },
  });
});

test('renaming a Provider to a formatting variant of its own name is permitted', async () => {
  const t = convexTest(schema, modules);
  const { owner, providerId } = await fixture(t);
  // The uniqueness read must not conflict a row against itself: the normalized
  // key is unchanged, so only the displayed name moves.
  await expect(owner.client.mutation(updateProvider, { providerId, name: 'acme sas' })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject({ name: 'acme sas', searchText: 'acme sas' });
  });
  await expect(owner.client.mutation(updateProvider, { providerId, name: '  ACME   SAS  ' })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(providerId)).toMatchObject({ name: 'ACME   SAS', searchText: 'acme sas' });
  });
});

test('a Provider patch that changes nothing writes neither a document patch nor an audit row', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  const before = await t.run(async (ctx) => ctx.db.get(providerId));

  await expect(
    owner.client.mutation(updateProvider, {
      providerId,
      name: 'Acme SAS',
      legalName: 'Acme Sociedad por Acciones Simplificada',
      taxId: '900123456-7',
      contactName: 'Ana Restrepo',
      contactEmail: 'ana@acme.example',
      contactPhone: '+57 300 000 0000',
      notes: 'Preferred vans supplier',
    }),
  ).resolves.toBeNull();

  expect(await t.run(async (ctx) => ctx.db.get(providerId))).toEqual(before);
  const audits = await providerAudits(t, organizationId, providerId);
  expect(audits.map((audit) => audit.action)).toEqual(['provider.created']);
});

test('a refused Provider write records no audit row', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  const rivalId = await owner.client.mutation(createProvider, { organizationId, name: 'Rival Fleet' });
  const planner = await provision(t, 'providers-refused-planner');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });

  await expect(owner.client.mutation(updateProvider, { providerId: rivalId, name: 'acme sas' })).rejects.toMatchObject({ data: { code: 'conflict' } });
  await expect(planner.client.mutation(updateProvider, { providerId: rivalId, name: 'Denied' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await owner.client.mutation(archiveProvider, { providerId: rivalId });
  await expect(owner.client.mutation(updateProvider, { providerId: rivalId, name: 'Denied' })).rejects.toMatchObject({ data: { code: 'providerArchived' } });

  const audits = await providerAudits(t, organizationId, rivalId);
  expect(audits.map((audit) => audit.action)).toEqual(['provider.created', 'provider.archived']);
});

test('a claimed but still active Provider is refused for the archival reason first', async () => {
  const t = convexTest(schema, modules);
  const { owner, providerId } = await fixture(t);
  const claimedOrganizationId = await owner.client.mutation(createOrganization, { name: 'Claimed', slug: 'providers-claimed-active' });
  await linkProvider(t, providerId, claimedOrganizationId);
  // Both guards refuse; the archival requirement is the outer one, so the
  // caller is told the step they can actually take next.
  await expect(owner.client.mutation(deleteProvider, { providerId })).rejects.toMatchObject({ data: { code: 'providerArchiveRequired' } });
});

test('blank Provider searches fall through and excessively long searches are rejected', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  // Matches the locations catalogue: a term that normalizes to nothing is not
  // a filter, so the unfiltered tenant catalogue is the honest answer.
  await expect(owner.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: '  —_! ' })).resolves.toMatchObject({
    page: [{ _id: providerId }],
  });
  await expect(owner.client.query(listProviders, { organizationId, paginationOpts: firstPage, search: 'x'.repeat(101) })).rejects.toMatchObject({
    data: { code: 'searchTermTooLong' },
  });
});

test('a viewer is at the Provider read floor', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, providerId } = await fixture(t);
  const viewer = await provision(t, 'providers-viewer');
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });

  await expect(viewer.client.query(getProvider, { providerId })).resolves.toMatchObject({ _id: providerId, claimState: 'unclaimed' });
  await expect(viewer.client.query(listProviders, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({
    page: [expect.objectContaining({ _id: providerId })],
  });
  await expect(viewer.client.mutation(createProvider, { organizationId, name: 'Denied' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(viewer.client.mutation(updateProvider, { providerId, name: 'Denied' })).rejects.toMatchObject({ data: { code: inaccessible } });
});
