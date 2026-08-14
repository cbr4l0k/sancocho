import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { recordAuditEvent } from '../convex/audit/model';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProject = api.projects.mutations.createProject;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const createRecipe = api.recipes.mutations.createRecipe;
const createInitialDraftVersion = api.recipes.mutations.createInitialDraftVersion;
const publishRecipeVersion = api.recipes.mutations.publishRecipeVersion;
const addRecipeField = api.recipes.fields.mutations.addRecipeField;
const createEventFromRecipe = api.events.mutations.createEventFromRecipe;
const changeEventStatus = api.events.mutations.changeEventStatus;
const updateEventFields = api.events.mutations.updateEventFields;
const listOrganizationAuditEvents = api.audit.queries.listOrganizationAuditEvents;
const listEntityAuditEvents = api.audit.queries.listEntityAuditEvents;

const issuer = 'https://example.clerk.accounts.dev';
const inaccessible = 'Not found or inaccessible';
const unauthenticated = 'Unauthenticated';

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: ReturnType<typeof convexTest>, subject: string) {
  const client = t.withIdentity(identity(subject));
  return { client, userId: await client.mutation(ensureUser, {}) };
}

async function operationalFixture() {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'audit-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Audit', slug: 'audit-log' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Project' });
  const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, {
    organizationId,
    key: 'code',
    label: 'Code',
    config: { kind: 'text' },
  });
  const recipeId = await owner.client.mutation(createRecipe, { organizationId, key: 'recipe', name: 'Recipe' });
  const recipeVersionId = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await owner.client.mutation(addRecipeField, { recipeVersionId, fieldDefinitionId, required: true, visible: true });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId });
  const eventId = await owner.client.mutation(createEventFromRecipe, {
    projectId,
    recipeVersionId,
    name: 'Event',
    startsAt: 1,
    values: [{ fieldDefinitionId, value: { kind: 'text', value: 'x' } }],
  });
  await owner.client.mutation(changeEventStatus, { eventId, status: 'planned' });
  await owner.client.mutation(changeEventStatus, { eventId, status: 'confirmed' });
  return { t, owner, organizationId, projectId, eventId };
}

/** Total rows in the log, read directly: proves what the public API cannot show. */
function countAuditEvents(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => (await ctx.db.query('auditEvents').collect()).length);
}

test('writes a newest-first operational audit log and filters entity history', async () => {
  const { owner, organizationId, projectId, eventId } = await operationalFixture();
  const page = await owner.client.query(listOrganizationAuditEvents, { organizationId, paginationOpts: { numItems: 50, cursor: null } });
  const actions = page.page.map((entry) => entry.action);
  expect(actions.slice(0, 3)).toEqual(['event.statusChanged', 'event.statusChanged', 'event.created']);
  expect(actions).toEqual(expect.arrayContaining([
    'organization.created', 'project.created', 'fieldDefinition.created', 'recipe.created',
    'recipeVersion.created', 'recipeField.added', 'recipeVersion.published',
  ]));
  expect(page.page.every((entry, index) => index === 0 || entry._creationTime <= (page.page[index - 1]?._creationTime ?? Infinity))).toBe(true);

  const secondProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Second project' });
  const projectHistory = await owner.client.query(listEntityAuditEvents, {
    organizationId, entityType: 'project', entityId: secondProjectId, paginationOpts: { numItems: 10, cursor: null },
  });
  expect(projectHistory.page.map((entry) => entry.action)).toEqual(['project.created']);
  expect(projectHistory.page.every((entry) => entry.entityId !== projectId && entry.entityId !== eventId)).toBe(true);
});

test('audit reads are admin-only, tenant-isolated, paginated, and append-only', async () => {
  const { t, owner, organizationId, projectId } = await operationalFixture();
  const roles = await Promise.all((['viewer', 'operator', 'planner', 'admin'] as const)
    .map(async (role) => ({ role, member: await provision(t, `audit-${role}`) })));
  for (const { role, member } of roles) await owner.client.mutation(addMember, { organizationId, userId: member.userId, role });
  const foreignOwner = await provision(t, 'audit-foreign-owner');
  const otherOrganizationId = await foreignOwner.client.mutation(createOrganization, { name: 'Other', slug: 'audit-other' });
  const fabricatedOrganizationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', { name: 'Gone', slug: 'audit-gone' });
    await ctx.db.delete(id);
    return id;
  });
  const args = { organizationId, paginationOpts: { numItems: 1, cursor: null } };
  for (const { role, member } of roles) {
    const entityArgs = { ...args, entityType: 'project' as const, entityId: projectId };
    if (role === 'admin') {
      // A non-empty page, not merely a resolved promise: `toBeDefined()` alone
      // would also accept an admin silently reading nothing.
      const organizationPage = await member.client.query(listOrganizationAuditEvents, args);
      const entityPage = await member.client.query(listEntityAuditEvents, entityArgs);
      expect(organizationPage.page.length).toBeGreaterThan(0);
      expect(entityPage.page.length).toBeGreaterThan(0);
    } else {
      await expect(member.client.query(listOrganizationAuditEvents, args)).rejects.toMatchObject({ data: inaccessible });
      await expect(member.client.query(listEntityAuditEvents, entityArgs)).rejects.toMatchObject({ data: inaccessible });
    }
  }
  for (const blockedOrganizationId of [otherOrganizationId, fabricatedOrganizationId]) {
    await expect(owner.client.query(listOrganizationAuditEvents, { ...args, organizationId: blockedOrganizationId })).rejects.toMatchObject({ data: inaccessible });
    await expect(owner.client.query(listEntityAuditEvents, { ...args, organizationId: blockedOrganizationId, entityType: 'project', entityId: projectId })).rejects.toMatchObject({ data: inaccessible });
  }
  await expect(t.query(listOrganizationAuditEvents, args)).rejects.toMatchObject({ data: unauthenticated });
  await expect(t.query(listEntityAuditEvents, { ...args, entityType: 'project', entityId: projectId })).rejects.toMatchObject({ data: unauthenticated });

  let cursor: string | null = null;
  const ids: string[] = [];
  const creationTimes: number[] = [];
  do {
    const auditResult: { page: { _id: string; _creationTime: number }[]; isDone: boolean; continueCursor: string } =
      await owner.client.query(listOrganizationAuditEvents, { organizationId, paginationOpts: { numItems: 1, cursor } });
    ids.push(...auditResult.page.map((entry) => entry._id));
    creationTimes.push(...auditResult.page.map((entry) => entry._creationTime));
    cursor = auditResult.isDone ? null : auditResult.continueCursor;
  } while (cursor !== null);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThan(2);
  // Newest-first must hold ACROSS page boundaries too: with numItems 1 every
  // comparison here is a cross-page one, which a per-page sort check never makes.
  expect(creationTimes.every((time, index) => index === 0 || time <= (creationTimes[index - 1] ?? Infinity))).toBe(true);
  // There are deliberately no audit mutations in the generated public API:
  // audit/model.ts is a helper only, so rows are append-only domain side effects.
  expect(api.audit).not.toHaveProperty('mutations');
});

test('the metadata guard rejects unknown keys and long caller strings, leaving no partial row', async () => {
  const { t, owner, organizationId, projectId } = await operationalFixture();
  const before = await countAuditEvents(t);
  await expect(t.run((ctx) => recordAuditEvent(ctx, {
    organizationId, actorUserId: owner.userId, action: 'project.updated', entityType: 'project', entityId: projectId,
    // @ts-expect-error `token` is not an allowlisted metadata key: the compiler is
    // the first gate (M1), and this test proves the runtime guard behind it.
    metadata: { token: 'secret' },
  }))).rejects.toMatchObject({ data: 'Audit metadata key is not permitted: token' });
  await expect(t.run((ctx) => recordAuditEvent(ctx, {
    organizationId, actorUserId: owner.userId, action: 'project.updated', entityType: 'project', entityId: projectId,
    metadata: { name: 'x'.repeat(513) },
  }))).rejects.toMatchObject({ data: 'Audit metadata string values must not exceed 512 characters' });
  // The guard runs before the insert, so a rejected write must leave the log
  // exactly as it was — no half-written row bearing the rejected metadata.
  expect(await countAuditEvents(t)).toBe(before);
});

test('a bulk field-value edit succeeds and audits, truncating its own summary instead of failing', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'audit-bulk-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Bulk', slug: 'audit-bulk' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Bulk project' });
  const recipeId = await owner.client.mutation(createRecipe, { organizationId, key: 'bulk', name: 'Bulk' });
  const recipeVersionId = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  // 20 composed fields: `changedFields` then joins 20 document ids (~660 chars),
  // which is what used to exceed the 512-character metadata bound and abort the
  // whole edit with an error blaming the user's input.
  const fieldCount = 20;
  const fieldDefinitionIds: Id<'fieldDefinitions'>[] = [];
  for (let index = 0; index < fieldCount; index += 1) {
    const fieldDefinitionId = await owner.client.mutation(createFieldDefinition, {
      organizationId, key: `bulkField${index}`, label: `Bulk field ${index}`, config: { kind: 'text' },
    });
    await owner.client.mutation(addRecipeField, { recipeVersionId, fieldDefinitionId, required: true, visible: true });
    fieldDefinitionIds.push(fieldDefinitionId);
  }
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId });
  const eventId = await owner.client.mutation(createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Bulk event', startsAt: 1,
    values: fieldDefinitionIds.map((fieldDefinitionId) => ({ fieldDefinitionId, value: { kind: 'text' as const, value: 'before' } })),
  });

  await expect(owner.client.mutation(updateEventFields, {
    eventId,
    values: fieldDefinitionIds.map((fieldDefinitionId) => ({ fieldDefinitionId, value: { kind: 'text' as const, value: 'after' } })),
  })).resolves.toBeNull();

  const stored = await t.run(async (ctx) => (await ctx.db
    .query('eventFieldValues')
    .withIndex('by_event_field', (q) => q.eq('eventId', eventId))
    .collect()).map((row) => row.value));
  expect(stored).toHaveLength(fieldCount);
  expect(stored.every((value) => value.kind === 'text' && value.value === 'after')).toBe(true);

  const history = await owner.client.query(listEntityAuditEvents, {
    organizationId, entityType: 'event', entityId: eventId, paginationOpts: { numItems: 10, cursor: null },
  });
  const updated = history.page.find((entry) => entry.action === 'event.updated');
  expect(updated).toBeDefined();
  const changedFields = updated?.metadata.changedFields;
  expect(typeof changedFields).toBe('string');
  if (typeof changedFields !== 'string') throw new Error('changedFields must be a string');
  // Truncated, not thrown: bounded, still a readable id list, and honest about
  // how many ids it dropped — kept + omitted accounts for every changed field.
  expect(changedFields.length).toBeLessThanOrEqual(512);
  const [, omitted] = /,\+(\d+) more$/.exec(changedFields) ?? [];
  expect(omitted).toBeDefined();
  const kept = changedFields.split(',').slice(0, -1);
  expect(kept.length + Number(omitted)).toBe(fieldCount);
  const changedIds = new Set<string>(fieldDefinitionIds);
  expect(kept.every((id) => changedIds.has(id))).toBe(true);
});

test('audit metadata records the exact documented content for an action', async () => {
  const { owner, organizationId, projectId } = await operationalFixture();
  const history = await owner.client.query(listEntityAuditEvents, {
    organizationId, entityType: 'project', entityId: projectId, paginationOpts: { numItems: 10, cursor: null },
  });
  // Pinned as an exact object: renaming or dropping a metadata key is a change to
  // the log's contract, and must fail here rather than pass silently.
  expect(history.page.map((entry) => entry.metadata)).toEqual([{ name: 'Project' }]);
});

test('entity-scoped audit history paginates across cursors and isolates unknown entities', async () => {
  const { t, owner, organizationId, eventId } = await operationalFixture();
  let cursor: string | null = null;
  const actions: string[] = [];
  const creationTimes: number[] = [];
  do {
    const page: { page: { action: string; _creationTime: number }[]; isDone: boolean; continueCursor: string } =
      await owner.client.query(listEntityAuditEvents, {
        organizationId, entityType: 'event', entityId: eventId, paginationOpts: { numItems: 1, cursor },
      });
    expect(page.page.length).toBeLessThanOrEqual(1);
    actions.push(...page.page.map((entry) => entry.action));
    creationTimes.push(...page.page.map((entry) => entry._creationTime));
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  expect(actions).toEqual(['event.statusChanged', 'event.statusChanged', 'event.created']);
  expect(creationTimes.every((time, index) => index === 0 || time <= (creationTimes[index - 1] ?? Infinity))).toBe(true);

  // An entity id that never existed is not an authorization failure: inside an
  // organization the caller may read, it is simply an empty history. Keeping the
  // two outcomes distinguishable is what makes the I9 rejection above meaningful.
  const fabricatedProjectId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('projects', { organizationId, name: 'Gone', status: 'active' });
    await ctx.db.delete(id);
    return id;
  });
  const empty = await owner.client.query(listEntityAuditEvents, {
    organizationId, entityType: 'project', entityId: fabricatedProjectId, paginationOpts: { numItems: 10, cursor: null },
  });
  expect(empty.page).toEqual([]);
  expect(empty.isDone).toBe(true);

  // The one free-form public input is bounded rather than passed to the index.
  await expect(owner.client.query(listEntityAuditEvents, {
    organizationId, entityType: 'event', entityId: 'x'.repeat(129), paginationOpts: { numItems: 10, cursor: null },
  })).rejects.toMatchObject({ data: 'Audit entity id must not exceed 128 characters' });
});

test('an admin reads only their own organization rows while another tenant is active', async () => {
  const { t, owner, organizationId } = await operationalFixture();
  const admin = await provision(t, 'audit-isolated-admin');
  await owner.client.mutation(addMember, { organizationId, userId: admin.userId, role: 'admin' });

  // A second tenant with its own activity, so an unfiltered read would visibly
  // mix organizations instead of merely returning nothing.
  const foreignOwner = await provision(t, 'audit-isolated-foreign');
  const foreignOrganizationId = await foreignOwner.client.mutation(createOrganization, { name: 'Foreign', slug: 'audit-isolated' });
  await foreignOwner.client.mutation(createProject, { organizationId: foreignOrganizationId, name: 'Foreign project' });
  await foreignOwner.client.mutation(createFieldDefinition, {
    organizationId: foreignOrganizationId, key: 'foreign', label: 'Foreign', config: { kind: 'text' },
  });

  const page = await admin.client.query(listOrganizationAuditEvents, { organizationId, paginationOpts: { numItems: 100, cursor: null } });
  expect(page.page.length).toBeGreaterThan(0);
  expect(page.page.every((entry) => entry.organizationId === organizationId)).toBe(true);
  const foreignPage = await foreignOwner.client.query(listOrganizationAuditEvents, {
    organizationId: foreignOrganizationId, paginationOpts: { numItems: 100, cursor: null },
  });
  expect(foreignPage.page.length).toBeGreaterThan(0);
  expect(foreignPage.page.every((entry) => entry.organizationId === foreignOrganizationId)).toBe(true);
  // Both tenants wrote rows, so the two result sets are disjoint by construction.
  const foreignIds = new Set(foreignPage.page.map((entry) => entry._id));
  expect(page.page.some((entry) => foreignIds.has(entry._id))).toBe(false);
});

test('signed-in callers without an app user or a membership get the same generic error', async () => {
  const { t, organizationId, projectId } = await operationalFixture();
  const entityArgs = { organizationId, entityType: 'project' as const, entityId: projectId, paginationOpts: { numItems: 10, cursor: null } };
  const args = { organizationId, paginationOpts: { numItems: 10, cursor: null } };

  // Authenticated but never provisioned: no `users` row at all.
  const unprovisioned = t.withIdentity(identity('audit-unprovisioned'));
  await expect(unprovisioned.query(listOrganizationAuditEvents, args)).rejects.toMatchObject({ data: inaccessible });
  await expect(unprovisioned.query(listEntityAuditEvents, entityArgs)).rejects.toMatchObject({ data: inaccessible });

  // Provisioned but a member of nothing: a different failure point on the I1
  // chain that must be indistinguishable from the outside (I9).
  const stranger = await provision(t, 'audit-zero-membership');
  await expect(stranger.client.query(listOrganizationAuditEvents, args)).rejects.toMatchObject({ data: inaccessible });
  await expect(stranger.client.query(listEntityAuditEvents, entityArgs)).rejects.toMatchObject({ data: inaccessible });
});
