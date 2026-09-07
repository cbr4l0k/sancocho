import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createCostCentre = api.costCentres.mutations.createCostCentre;
const updateCostCentre = api.costCentres.mutations.updateCostCentre;
const archiveCostCentre = api.costCentres.mutations.archiveCostCentre;
const deleteCostCentre = api.costCentres.mutations.deleteCostCentre;
const getCostCentre = api.costCentres.queries.getCostCentre;
const listCostCentres = api.costCentres.queries.listCostCentres;
const createProject = api.projects.mutations.createProject;
const createEvent = api.events.mutations.createEvent;
const updateEvent = api.events.mutations.updateEvent;

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
  const owner = await provision(t, 'cost-centres-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'cost-centres-test' });
  const costCentreId: Id<'costCentres'> = await owner.client.mutation(createCostCentre, {
    organizationId,
    key: 'clientTransport',
    name: 'Client Transport',
    description: 'Client-facing transport budget',
    externalReference: 'ERP-100',
  });
  return { owner, organizationId, costCentreId };
}

function costCentreAudits(t: SchemaTest, organizationId: Id<'organizations'>, costCentreId: Id<'costCentres'>) {
  return t.run(async (ctx) =>
    ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'costCentre').eq('entityId', costCentreId))
      .collect(),
  );
}

test('Cost Centre creation derives searchable text and rejects duplicate organization keys', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, costCentreId } = await fixture(t);

  await t.run(async (ctx) => {
    expect(await ctx.db.get(costCentreId)).toMatchObject({
      key: 'clientTransport',
      name: 'Client Transport',
      searchText: 'client transport',
      status: 'active',
    });
    expect(
      await ctx.db
        .query('costCentres')
        .withIndex('by_org_key', (q) => q.eq('organizationId', organizationId).eq('key', 'clientTransport'))
        .unique(),
    ).toMatchObject({ _id: costCentreId });
  });
  await expect(
    owner.client.mutation(createCostCentre, { organizationId, key: 'clientTransport', name: 'Duplicate' }),
  ).rejects.toMatchObject({ data: { code: 'conflict' } });
  const otherOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'cost-centres-key-scope' });
  await expect(
    owner.client.mutation(createCostCentre, { organizationId: otherOrganizationId, key: 'clientTransport', name: 'Independent key' }),
  ).resolves.toBeDefined();
});

test('Cost Centre keys, names, and descriptions are validated at their boundaries', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, costCentreId } = await fixture(t);
  for (const key of ['', 'A', 'not-valid', 'x'.repeat(65)]) {
    await expect(owner.client.mutation(createCostCentre, { organizationId, key, name: 'Invalid' })).rejects.toMatchObject({
      data: { code: 'costCentreKeyInvalid' },
    });
  }
  await expect(owner.client.mutation(createCostCentre, { organizationId, key: 'validKey', name: '   ' })).rejects.toMatchObject({
    data: { code: 'entityNameInvalid' },
  });
  await expect(
    owner.client.mutation(createCostCentre, { organizationId, key: 'longDescription', name: 'Long', description: 'x'.repeat(2001) }),
  ).rejects.toMatchObject({ data: { code: 'costCentreDescriptionTooLong' } });
  await expect(owner.client.mutation(updateCostCentre, { costCentreId, description: 'x'.repeat(2001) })).rejects.toMatchObject({
    data: { code: 'costCentreDescriptionTooLong' },
  });
});

test('an admin can manage Cost Centres and lifecycle writes are audited', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await fixture(t);
  const admin = await provision(t, 'cost-centres-admin');
  await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });
  const costCentreId = await admin.client.mutation(createCostCentre, { organizationId, key: 'adminBudget', name: 'Admin budget' });
  await admin.client.mutation(updateCostCentre, { costCentreId, name: '  Admin renamed  ', description: 'Updated', externalReference: 'ERP-200' });
  await admin.client.mutation(archiveCostCentre, { costCentreId });
  await expect(admin.client.mutation(archiveCostCentre, { costCentreId })).resolves.toBeNull();

  const audits = await costCentreAudits(t, organizationId, costCentreId);
  expect(audits.map((audit) => audit.action).sort()).toEqual(['costCentre.archived', 'costCentre.created', 'costCentre.updated']);
  expect(audits.every((audit) => audit.actorUserId === admin.userId)).toBe(true);
  expect(audits.find((audit) => audit.action === 'costCentre.created')?.metadata).toMatchObject({ key: 'adminBudget', name: 'Admin budget' });
  expect(audits.find((audit) => audit.action === 'costCentre.updated')?.metadata).toMatchObject({ changedFields: 'name,description,externalReference' });
  expect(audits.find((audit) => audit.action === 'costCentre.archived')?.metadata).toMatchObject({ previousStatus: 'active' });
  await expect(admin.client.query(getCostCentre, { costCentreId })).resolves.toMatchObject({ name: 'Admin renamed', status: 'archived' });
});

test('deleting a Cost Centre records an audit row naming the row it destroyed', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId } = await fixture(t);
  const costCentreId = await owner.client.mutation(createCostCentre, { organizationId, key: 'doomed', name: 'Doomed budget' });
  await owner.client.mutation(archiveCostCentre, { costCentreId });
  await owner.client.mutation(deleteCostCentre, { costCentreId });

  // The row is gone, so the log is the only remaining record of what it was.
  await expect(owner.client.query(getCostCentre, { costCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  const audits = await costCentreAudits(t, organizationId, costCentreId);
  expect(audits.map((audit) => audit.action)).toContain('costCentre.deleted');
  const deleted = audits.find((audit) => audit.action === 'costCentre.deleted');
  expect(deleted).toMatchObject({
    actorUserId: owner.userId,
    entityType: 'costCentre',
    entityId: costCentreId,
    metadata: { name: 'Doomed budget' },
  });
});

test('a planner is below the Cost Centre configuration floor on every write', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, costCentreId } = await fixture(t);
  const planner = await provision(t, 'cost-centres-planner');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });

  await expect(planner.client.mutation(createCostCentre, { organizationId, key: 'forbidden', name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(updateCostCentre, { costCentreId, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(archiveCostCentre, { costCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.mutation(deleteCostCentre, { costCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(planner.client.query(getCostCentre, { costCentreId })).resolves.toMatchObject({ _id: costCentreId });
});

test('every public Cost Centre function is opaque to unauthenticated, fabricated, foreign, and non-member callers', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, costCentreId } = await fixture(t);
  const outsider = await provision(t, 'cost-centres-outsider');
  const missingCostCentreId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('costCentres', {
      organizationId,
      key: 'temporary',
      name: 'Temporary',
      searchText: 'temporary',
      status: 'active',
    });
    await ctx.db.delete(id);
    return id;
  });

  for (const id of [costCentreId, missingCostCentreId]) {
    await expect(t.query(getCostCentre, { costCentreId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(updateCostCentre, { costCentreId: id, name: 'No' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(archiveCostCentre, { costCentreId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(deleteCostCentre, { costCentreId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(outsider.client.query(getCostCentre, { costCentreId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(updateCostCentre, { costCentreId: id, name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(archiveCostCentre, { costCentreId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(deleteCostCentre, { costCentreId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  for (const orgId of [organizationId, await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', { name: 'Gone', slug: 'cost-centres-gone' });
    await ctx.db.delete(id);
    return id;
  })]) {
    await expect(t.query(listCostCentres, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(createCostCentre, { organizationId: orgId, key: 'intruder', name: 'No' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(outsider.client.query(listCostCentres, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(createCostCentre, { organizationId: orgId, key: 'intruder', name: 'No' })).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'cost-centres-foreign' });
  await owner.client.mutation(addMember, { organizationId: foreignOrganizationId, userId: outsider.userId, role: 'owner' });
  await expect(outsider.client.query(getCostCentre, { costCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(updateCostCentre, { costCentreId, name: 'Cross tenant' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(archiveCostCentre, { costCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(deleteCostCentre, { costCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.query(listCostCentres, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.mutation(createCostCentre, { organizationId, key: 'crossTenant', name: 'Cross tenant' })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
});

test('Cost Centre lists paginate with a continuation cursor and remain tenant-isolated', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, costCentreId } = await fixture(t);
  const secondId = await owner.client.mutation(createCostCentre, { organizationId, key: 'production', name: 'Production' });
  const thirdId = await owner.client.mutation(createCostCentre, { organizationId, key: 'hospitality', name: 'Hospitality' });
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'cost-centres-page-foreign' });
  const foreignId = await owner.client.mutation(createCostCentre, { organizationId: foreignOrganizationId, key: 'foreign', name: 'Foreign' });

  const first = await owner.client.query(listCostCentres, { organizationId, paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  expect(first.continueCursor).not.toBe('');
  const second = await owner.client.query(listCostCentres, { organizationId, paginationOpts: { numItems: 2, cursor: first.continueCursor } });
  expect(second.page).toHaveLength(1);
  expect([...first.page, ...second.page].map((row) => row._id).sort()).toEqual([costCentreId, secondId, thirdId].sort());
  expect([...first.page, ...second.page].every((row) => row.organizationId === organizationId)).toBe(true);
  await expect(owner.client.query(listCostCentres, { organizationId: foreignOrganizationId, paginationOpts: firstPage })).resolves.toMatchObject({
    page: [{ _id: foreignId }],
  });
});

test('Cost Centre status filtering is indexed before pagination', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, costCentreId } = await fixture(t);
  const activeTwo = await owner.client.mutation(createCostCentre, { organizationId, key: 'activeTwo', name: 'Active two' });
  const activeThree = await owner.client.mutation(createCostCentre, { organizationId, key: 'activeThree', name: 'Active three' });
  const archivedOne = await owner.client.mutation(createCostCentre, { organizationId, key: 'archivedOne', name: 'Archived one' });
  const archivedTwo = await owner.client.mutation(createCostCentre, { organizationId, key: 'archivedTwo', name: 'Archived two' });
  await owner.client.mutation(archiveCostCentre, { costCentreId: archivedOne });
  await owner.client.mutation(archiveCostCentre, { costCentreId: archivedTwo });

  const first = await owner.client.query(listCostCentres, { organizationId, paginationOpts: { numItems: 2, cursor: null }, status: 'active' });
  const second = await owner.client.query(listCostCentres, { organizationId, paginationOpts: { numItems: 2, cursor: first.continueCursor }, status: 'active' });
  expect([...first.page, ...second.page].map((row) => row._id).sort()).toEqual([costCentreId, activeTwo, activeThree].sort());
  expect([...first.page, ...second.page].every((row) => row.status === 'active')).toBe(true);
  await expect(owner.client.query(listCostCentres, { organizationId, paginationOpts: firstPage, status: 'archived' })).resolves.toMatchObject({
    page: expect.arrayContaining([expect.objectContaining({ _id: archivedOne }), expect.objectContaining({ _id: archivedTwo })]),
  });
});

test('Cost Centre name search uses normalized server-derived text and composes with status', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, costCentreId } = await fixture(t);
  for (let index = 0; index < 4; index += 1) {
    await owner.client.mutation(createCostCentre, { organizationId, key: `ordinary${index}`, name: `Ordinary ${index}` });
  }
  const searchedId = await owner.client.mutation(createCostCentre, { organizationId, key: 'medellin', name: 'Operación Medellín' });
  await owner.client.mutation(updateCostCentre, { costCentreId, name: 'Bogotá Client Transport' });
  await owner.client.mutation(archiveCostCentre, { costCentreId: searchedId });

  const ordinary = await owner.client.query(listCostCentres, { organizationId, paginationOpts: { numItems: 1, cursor: null } });
  expect(ordinary.page.map((row: Doc<'costCentres'>) => row._id)).not.toContain(searchedId);
  await expect(owner.client.query(listCostCentres, { organizationId, paginationOpts: firstPage, search: 'medellin' })).resolves.toMatchObject({
    page: [{ _id: searchedId }],
  });
  await expect(owner.client.query(listCostCentres, { organizationId, paginationOpts: firstPage, search: 'medellin', status: 'active' })).resolves.toMatchObject({ page: [] });
  await expect(owner.client.query(listCostCentres, { organizationId, paginationOpts: firstPage, search: 'bogota' })).resolves.toMatchObject({
    page: [{ _id: costCentreId }],
  });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(costCentreId))?.searchText).toBe('bogota client transport');
  });
});

test('archived Cost Centres stay readable but refuse every update', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, costCentreId } = await fixture(t);
  await owner.client.mutation(archiveCostCentre, { costCentreId });
  await expect(owner.client.mutation(updateCostCentre, { costCentreId, name: 'No' })).rejects.toMatchObject({ data: { code: 'costCentreArchived' } });
  await expect(owner.client.mutation(updateCostCentre, { costCentreId, externalReference: 'No' })).rejects.toMatchObject({ data: { code: 'costCentreArchived' } });
  await expect(owner.client.query(getCostCentre, { costCentreId })).resolves.toMatchObject({ status: 'archived' });
  await expect(owner.client.query(listCostCentres, { organizationId, paginationOpts: firstPage })).resolves.toMatchObject({
    page: [expect.objectContaining({ _id: costCentreId, status: 'archived' })],
  });
});

test('an unreferenced archived Cost Centre deletes successfully', async () => {
  const t = convexTest(schema, modules);
  const { owner, costCentreId } = await fixture(t);
  await expect(owner.client.mutation(deleteCostCentre, { costCentreId })).rejects.toMatchObject({ data: { code: 'costCentreArchiveRequired' } });
  await owner.client.mutation(archiveCostCentre, { costCentreId });
  await expect(owner.client.mutation(deleteCostCentre, { costCentreId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(costCentreId)).toBeNull();
  });
  await expect(owner.client.query(getCostCentre, { costCentreId })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('a Cost Centre an Event names as its client cannot be deleted', async () => {
  const t = convexTest(schema, modules);
  const { owner, organizationId, costCentreId } = await fixture(t);
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Client project' });
  const eventId = await owner.client.mutation(createEvent, {
    projectId,
    name: 'Client event',
    startsAt: 200,
    clientCostCentreId: costCentreId,
  });

  await owner.client.mutation(archiveCostCentre, { costCentreId });
  await expect(owner.client.mutation(deleteCostCentre, { costCentreId })).rejects.toMatchObject({
    data: { code: 'costCentreDeleteBlocked' },
  });

  // Live rather than sticky: releasing the reference releases the Cost Centre.
  await owner.client.mutation(updateEvent, { eventId, clientCostCentreId: null });
  await expect(owner.client.mutation(deleteCostCentre, { costCentreId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(costCentreId)).toBeNull();
  });
});
