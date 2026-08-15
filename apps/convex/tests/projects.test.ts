import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProject = api.projects.mutations.createProject;
const updateProject = api.projects.mutations.updateProject;
const archiveProject = api.projects.mutations.archiveProject;
const getProject = api.projects.queries.getProject;
const listProjects = api.projects.queries.listProjects;

const NOT_FOUND_OR_INACCESSIBLE = 'notFoundOrInaccessible';
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

test('project descriptions are bounded like every other free-text column', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'A', slug: 'projects-description' });
  const tooLong = 'x'.repeat(2001);
  const bound = 'projectDescriptionTooLong';

  // Unbounded, this was the one column a tenant could fill with megabytes:
  // `listProjects` pages whole documents and projects are never deleted, so
  // enough oversized rows make a tenant's project list permanently unreadable.
  await expect(owner.client.mutation(createProject, { organizationId, name: 'Verbose', description: tooLong })).rejects.toMatchObject({ data: { code: bound } });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Bounded', description: 'x'.repeat(2000) });
  await expect(owner.client.mutation(updateProject, { projectId, description: tooLong })).rejects.toMatchObject({ data: { code: bound } });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(projectId))?.description).toBe('x'.repeat(2000));
  });
  // The refusal is the length, not the presence of a description.
  await expect(owner.client.mutation(updateProject, { projectId, description: 'Short enough' })).resolves.toBeNull();
});

test('cross-organization and fabricated project ids return the generic error', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const orgA = await owner.client.mutation(createOrganization, { name: 'A', slug: 'projects-a' });
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'projects-b' });
  await owner.client.mutation(addMember, { organizationId: orgA, userId: member.userId, role: 'planner' });
  const foreignProjectId = await owner.client.mutation(createProject, { organizationId: orgB, name: 'Foreign' });
  const missingProjectId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('projects', { organizationId: orgA, name: 'Temporary', status: 'draft' });
    await ctx.db.delete(id);
    return id;
  });

  for (const projectId of [foreignProjectId, missingProjectId]) {
    await expect(member.client.query(getProject, { projectId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(member.client.mutation(updateProject, { projectId, name: 'Nope' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(member.client.mutation(archiveProject, { projectId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  }
});

test('project operations are indistinguishable for unauthenticated probes (I9)', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-probe' });
  const realProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Real' });
  const fakeProjectId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('projects', { organizationId, name: 'Temporary', status: 'draft' });
    await ctx.db.delete(id);
    return id;
  });

  // Unauthenticated: identical error for real and fabricated ids.
  for (const projectId of [realProjectId, fakeProjectId]) {
    await expect(t.query(getProject, { projectId })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
    await expect(t.mutation(updateProject, { projectId, name: 'Nope' })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
    await expect(t.mutation(archiveProject, { projectId })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  }

  // The two organization-scoped entry points are closed to the same probe: a
  // real organization id is worth no more than a fabricated one without an
  // identity behind it.
  const fakeOrganizationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', { name: 'Temporary', slug: 'project-probe-ghost' });
    await ctx.db.delete(id);
    return id;
  });
  for (const orgId of [organizationId, fakeOrganizationId]) {
    await expect(t.mutation(createProject, { organizationId: orgId, name: 'Nope' })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
    await expect(t.query(listProjects, { organizationId: orgId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: UNAUTHENTICATED } });
  }
});

test('a user with no memberships anywhere cannot read a project', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const outsider = await provision(t, 'outsider');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-outsider' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Private' });

  await expect(outsider.client.query(getProject, { projectId })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
});

test('listProjects requires membership in the requested organization and never leaks other tenants', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const member = await provision(t, 'member');
  const outsider = await provision(t, 'outsider');
  const orgA = await owner.client.mutation(createOrganization, { name: 'A', slug: 'project-list-a' });
  const orgB = await owner.client.mutation(createOrganization, { name: 'B', slug: 'project-list-b' });
  await owner.client.mutation(addMember, { organizationId: orgA, userId: member.userId, role: 'viewer' });
  const projectA = await owner.client.mutation(createProject, { organizationId: orgA, name: 'Ours' });
  await owner.client.mutation(createProject, { organizationId: orgB, name: 'Theirs' });

  // No memberships at all, and a member of another organization: same error.
  await expect(outsider.client.query(listProjects, { organizationId: orgA, paginationOpts: firstPage })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });
  await expect(member.client.query(listProjects, { organizationId: orgB, paginationOpts: firstPage })).rejects.toMatchObject({
    data: { code: NOT_FOUND_OR_INACCESSIBLE },
  });

  const page = await member.client.query(listProjects, { organizationId: orgA, paginationOpts: firstPage });
  expect(page.page.map((project) => project._id)).toEqual([projectA]);
  expect(page.page.every((project) => project.organizationId === orgA)).toBe(true);
});

test('project authoring is closed to operators and viewers and open from planner up', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const viewer = await provision(t, 'viewer');
  const operator = await provision(t, 'operator');
  const planner = await provision(t, 'planner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-roles' });
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  await owner.client.mutation(addMember, { organizationId, userId: operator.userId, role: 'operator' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const projectId = await planner.client.mutation(createProject, { organizationId, name: 'Planned' });
  const archivable = await planner.client.mutation(createProject, { organizationId, name: 'Archivable' });

  // The floor is planner, not operator: an operator runs events, it does not
  // author the projects they live in. Testing only a viewer would leave the
  // floor free to slip a rank, which is why both ranks below planner are here.
  for (const { client } of [viewer, operator]) {
    await expect(client.mutation(createProject, { organizationId, name: 'Nope' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    await expect(client.mutation(updateProject, { projectId, name: 'Nope' })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
    // Archival is its own operation with its own role check, so it gets its own case.
    await expect(client.mutation(archiveProject, { projectId: archivable })).rejects.toMatchObject({ data: { code: NOT_FOUND_OR_INACCESSIBLE } });
  }
  // Reading stays open to any member, so the rejections above are a floor on
  // authoring, not on visibility.
  await expect(operator.client.query(getProject, { projectId })).resolves.toMatchObject({ _id: projectId });
  await expect(planner.client.mutation(updateProject, { projectId, name: 'Updated' })).resolves.toBeNull();
  await expect(planner.client.mutation(archiveProject, { projectId: archivable })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(archivable)).toMatchObject({ status: 'archived' });
  });
});

test('project dates must remain ordered at creation and update', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-dates' });

  await expect(owner.client.mutation(createProject, { organizationId, name: 'Invalid', startsAt: 20, endsAt: 10 })).rejects.toMatchObject({
    data: { code: 'projectDateRangeInvalid' },
  });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Valid', startsAt: 20, endsAt: 40 });
  await expect(owner.client.mutation(updateProject, { projectId, endsAt: 10 })).rejects.toMatchObject({
    data: { code: 'projectDateRangeInvalid' },
  });
  await expect(owner.client.mutation(updateProject, { projectId, startsAt: 50 })).rejects.toMatchObject({
    data: { code: 'projectDateRangeInvalid' },
  });

  // Equal bounds are a zero-length window, not an ordering violation.
  await expect(owner.client.mutation(createProject, { organizationId, name: 'Instant', startsAt: 30, endsAt: 30 })).resolves.toBeDefined();
  await expect(owner.client.mutation(updateProject, { projectId, startsAt: 25, endsAt: 25 })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(projectId)).toMatchObject({ startsAt: 25, endsAt: 25 });
  });
});

test('non-finite project dates are rejected at creation and update', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-finite' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Finite', startsAt: 10, endsAt: 20 });

  for (const startsAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await expect(owner.client.mutation(createProject, { organizationId, name: 'Bad start', startsAt })).rejects.toMatchObject({
      data: { code: 'projectStartInvalid' },
    });
    await expect(owner.client.mutation(updateProject, { projectId, startsAt })).rejects.toMatchObject({
      data: { code: 'projectStartInvalid' },
    });
  }
  for (const endsAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await expect(owner.client.mutation(createProject, { organizationId, name: 'Bad end', startsAt: 10, endsAt })).rejects.toMatchObject({
      data: { code: 'projectEndInvalid' },
    });
    await expect(owner.client.mutation(updateProject, { projectId, endsAt })).rejects.toMatchObject({
      data: { code: 'projectEndInvalid' },
    });
  }

  // NaN compares false against every bound, so nothing must have been stored.
  await t.run(async (ctx) => {
    expect(await ctx.db.get(projectId)).toMatchObject({ startsAt: 10, endsAt: 20 });
  });
});

test('archiving is only reachable through archiveProject, and draft/active/completed move freely', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-status' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Lifecycle' });

  await expect(owner.client.mutation(updateProject, { projectId, status: 'archived' })).rejects.toMatchObject({
    data: { code: 'projectArchiveRequired' },
  });
  await expect(owner.client.mutation(updateProject, { projectId, status: 'active' })).resolves.toBeNull();
  await expect(owner.client.mutation(updateProject, { projectId, status: 'completed' })).resolves.toBeNull();
  await t.run(async (ctx) => {
    expect(await ctx.db.get(projectId)).toMatchObject({ status: 'completed' });
  });

  await owner.client.mutation(archiveProject, { projectId });
  for (const status of ['draft', 'active', 'completed'] as const) {
    await expect(owner.client.mutation(updateProject, { projectId, status })).rejects.toMatchObject({
      data: { code: 'projectArchived' },
    });
  }
});

test('archiving twice is idempotent and writes a single audit row', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-rearchive' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Archive twice' });

  await owner.client.mutation(archiveProject, { projectId });
  await expect(owner.client.mutation(archiveProject, { projectId })).resolves.toBeNull();

  await t.run(async (ctx) => {
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'project').eq('entityId', projectId))
      .collect();
    expect(audits.filter((audit) => audit.action === 'project.archived')).toHaveLength(1);
    expect(await ctx.db.get(projectId)).toMatchObject({ status: 'archived' });
  });
});

test('archival preserves the project but makes it read-only', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-archive' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Archive me' });

  await owner.client.mutation(archiveProject, { projectId });
  await expect(owner.client.mutation(updateProject, { projectId, name: 'Nope' })).rejects.toMatchObject({
    data: { code: 'projectArchived' },
  });
  const project = await owner.client.query(getProject, { projectId });
  expect(project).toMatchObject({ _id: projectId, status: 'archived', name: 'Archive me' });
});

test('listProjects paginates projects by organization', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-pages' });
  await owner.client.mutation(createProject, { organizationId, name: 'One' });
  await owner.client.mutation(createProject, { organizationId, name: 'Two' });
  await owner.client.mutation(createProject, { organizationId, name: 'Three' });

  const first = await owner.client.query(listProjects, { organizationId, paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  const second = await owner.client.query(listProjects, {
    organizationId,
    paginationOpts: { numItems: 2, cursor: first.continueCursor },
  });
  expect(second.page).toHaveLength(1);
  expect(second.isDone).toBe(true);
});

test('project lifecycle writes attributed audit rows naming what changed', async () => {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'owner');
  const planner = await provision(t, 'planner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Acme', slug: 'project-audit' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Audited' });
  await planner.client.mutation(updateProject, { projectId, name: 'Audited twice', status: 'active' });
  // A patch that changes nothing must not write an empty audit row.
  await planner.client.mutation(updateProject, { projectId, name: 'Audited twice' });
  await owner.client.mutation(archiveProject, { projectId });

  await t.run(async (ctx) => {
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'project').eq('entityId', projectId))
      .collect();
    expect(audits.map((audit) => audit.action).sort()).toEqual(['project.archived', 'project.created', 'project.updated']);
    expect(audits.every((audit) => audit.organizationId === organizationId)).toBe(true);

    const created = audits.find((audit) => audit.action === 'project.created');
    expect(created?.actorUserId).toBe(owner.userId);
    const updated = audits.find((audit) => audit.action === 'project.updated');
    expect(updated?.actorUserId).toBe(planner.userId);
    expect(updated?.metadata).toMatchObject({ changedFields: 'name,status', previousStatus: 'draft', status: 'active' });
    const archived = audits.find((audit) => audit.action === 'project.archived');
    expect(archived?.actorUserId).toBe(owner.userId);
    expect(archived?.metadata).toMatchObject({ previousStatus: 'active' });
  });
});
