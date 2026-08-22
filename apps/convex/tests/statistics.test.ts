import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { enableSeedMutations, modules } from './helpers';

const issuer = 'https://example.clerk.accounts.dev';
const page = { numItems: 10, cursor: null };
const inaccessible = 'notFoundOrInaccessible';
const textConfig = { kind: 'text' } as const;
const backfill = internal.statistics.mutations.backfillOrganizationCounters;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

// The backfill is `assertSeedingEnabled()`-gated like every other deployment
// migration in this repo; harmless to enable for every test in this file
// since none of the ordinary public queries/mutations exercised below check
// that flag at all.
enableSeedMutations();

/**
 * The core correctness test. Every fact the statistics surface reports is
 * produced by driving the SAME public mutations every other domain test uses
 * (`createEventFromRecipe`, `changeEventStatus`, `updateProject`,
 * `archiveProject`, `publishRecipeVersion`, `archiveRecipe`, `createLocation`,
 * `archiveLocation`, `deleteLocation`) rather than by seeding the
 * `statisticsCounters`/`statisticsTotals` tables directly. A test that seeds
 * those tables by hand only proves the read side can echo back whatever it is
 * given; it says nothing about whether the write paths that are supposed to
 * maintain them actually do. This test fails if `changeCounter` is ever
 * un-wired from a mutation, or if a status transition only increments the new
 * bucket without decrementing the old one.
 */
test('statistics reflect real writes across events, projects, recipes, and locations, including bidirectional status transitions', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('statistics-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, {
    name: 'Statistics Co',
    slug: 'statistics-co',
  });

  // --- Recipes: `createOrganization` provisions and publishes the four
  // starter recipes (recipes/builtins.ts) in the SAME transaction, through the
  // real `publishRecipeVersion` path — so a brand new organization already
  // reports 4, not 0. That baseline is itself a live assertion that the
  // counter is wired into org bootstrap, not just into the mutations this
  // test calls directly below. Publishing one more recipe must add exactly
  // one. ---
  const starterActiveRecipes = 4;
  await expect(owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(starterActiveRecipes);
  const noteFieldId = await owner.mutation(api.fields.mutations.createFieldDefinition, {
    organizationId, key: 'transferNote', label: 'Note', config: textConfig,
  });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'transfer', name: 'Transfer' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: noteFieldId, required: false, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  await expect(owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(starterActiveRecipes + 1);

  // Archiving a still-DRAFT recipe (never published) must not touch the
  // active count: it was never counted as active in the first place.
  const unpublishedFieldId = await owner.mutation(api.fields.mutations.createFieldDefinition, {
    organizationId,
    key: 'unusedNote',
    label: 'Note',
    config: textConfig,
  });
  const draftRecipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'draftOnly', name: 'Draft only' });
  const draftVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId: draftRecipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId: draftVersionId, fieldDefinitionId: unpublishedFieldId, required: false, visible: true });
  await owner.mutation(api.recipes.mutations.archiveRecipe, { recipeId: draftRecipeId });
  await expect(owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(starterActiveRecipes + 1);

  // Archiving an ACTIVE (published) recipe is the only path that lowers the
  // count: publish a third recipe, then archive it, and confirm the total
  // returns exactly to baseline. The check above only exercises the no-op
  // branch (archiving a draft); this is the actual decrement path.
  const retiringFieldId = await owner.mutation(api.fields.mutations.createFieldDefinition, {
    organizationId, key: 'retiringNote', label: 'Note', config: textConfig,
  });
  const retiringRecipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'retiring', name: 'Retiring' });
  const retiringVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId: retiringRecipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId: retiringVersionId, fieldDefinitionId: retiringFieldId, required: false, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId: retiringVersionId });
  await expect(owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(starterActiveRecipes + 2);
  await owner.mutation(api.recipes.mutations.archiveRecipe, { recipeId: retiringRecipeId });
  await expect(owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(starterActiveRecipes + 1);

  // --- Projects: create (draft +1), update to active (draft -1, active +1),
  // archive (active -1, archived +1). Checked at each step so an
  // increment-only bug (which would leave draft's count wrong) cannot pass. ---
  const projectA = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Project A' });
  await expect(owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 1 },
    { status: 'active', count: 0 },
    { status: 'completed', count: 0 },
    { status: 'archived', count: 0 },
  ]);
  await owner.mutation(api.projects.mutations.updateProject, { projectId: projectA, status: 'active' });
  await expect(owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 0 },
    { status: 'active', count: 1 },
    { status: 'completed', count: 0 },
    { status: 'archived', count: 0 },
  ]);

  const projectB = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Project B' });

  // --- Events: created against projectA/projectB while both are writable,
  // then driven through status transitions before projectA is archived
  // (archiving freezes its events, so all transitions must happen first). ---
  const event1 = await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId: projectA,
    recipeVersionId,
    name: 'Airport run',
    startsAt: 1_000,
    values: [],
  });
  await expect(owner.query(api.statistics.queries.getServiceStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 1 }, { status: 'planned', count: 0 }, { status: 'confirmed', count: 0 },
    { status: 'active', count: 0 }, { status: 'completed', count: 0 }, { status: 'cancelled', count: 0 },
  ]);
  await owner.mutation(api.events.mutations.changeEventStatus, { eventId: event1, status: 'planned' });
  // The bidirectional check: draft must drop to 0, not just planned rising to 1.
  await expect(owner.query(api.statistics.queries.getServiceStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 0 }, { status: 'planned', count: 1 }, { status: 'confirmed', count: 0 },
    { status: 'active', count: 0 }, { status: 'completed', count: 0 }, { status: 'cancelled', count: 0 },
  ]);
  await owner.mutation(api.events.mutations.changeEventStatus, { eventId: event1, status: 'confirmed' });
  await owner.mutation(api.events.mutations.changeEventStatus, { eventId: event1, status: 'active' });
  await owner.mutation(api.events.mutations.changeEventStatus, { eventId: event1, status: 'completed' });

  const event2 = await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId: projectA,
    recipeVersionId,
    name: 'Cancelled run',
    startsAt: 2_000,
    values: [],
  });
  await owner.mutation(api.events.mutations.changeEventStatus, { eventId: event2, status: 'cancelled' });

  const event3 = await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId: projectB,
    recipeVersionId,
    name: 'Outside window',
    startsAt: 2_001,
    values: [],
  });

  await expect(owner.query(api.statistics.queries.getServiceStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 1 }, { status: 'planned', count: 0 }, { status: 'confirmed', count: 0 },
    { status: 'active', count: 0 }, { status: 'completed', count: 1 }, { status: 'cancelled', count: 1 },
  ]);

  // A fourth event, still in its upcoming `draft` status, sitting exactly at
  // the window's own end — this is what proves the window's inclusive edge
  // independently of the status filter below (event2 also sits at this exact
  // startsAt, but is `cancelled` and must never be mistaken for the boundary
  // case that decides inclusion).
  const event4 = await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId: projectB,
    recipeVersionId,
    name: 'Right at the edge',
    startsAt: 2_000,
    values: [],
  });

  // Now archive projectA: all of its events are already terminal or otherwise
  // done being transitioned, so the freeze cannot block anything left to do.
  await owner.mutation(api.projects.mutations.archiveProject, { projectId: projectA });
  await expect(owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 1 }, { status: 'active', count: 0 }, { status: 'completed', count: 0 }, { status: 'archived', count: 1 },
  ]);

  // --- Upcoming services: "upcoming" is `draft | planned | confirmed |
  // active` (see docs/statistics.md) — completed and cancelled services are
  // never upcoming work no matter where their `startsAt` falls, and the
  // window's own edges still apply on top of that. Window [1000, 2000]:
  // event1 (completed, startsAt 1000) — excluded by STATUS, despite being
  //   well inside the window.
  // event2 (cancelled, startsAt 2000, the window's own end) — excluded by
  //   STATUS, despite sitting exactly at the inclusive edge.
  // event3 (draft, startsAt 2001) — excluded by WINDOW, one past the end,
  //   despite being an upcoming status.
  // event4 (draft, startsAt 2000, the window's own end) — INCLUDED: upcoming
  //   status, and exactly at the inclusive edge. ---
  const upcoming = await owner.query(api.statistics.queries.getUpcomingServices, {
    organizationId, startsAt: 1_000, endsAt: 2_000, limit: 10,
  });
  expect(upcoming.map((event) => event._id)).toEqual([event4]);

  // --- Project and recipe breakdowns: projectA holds 2 events (event1,
  // event2), projectB holds 2 (event3, event4); every event used the one
  // published recipe, so its breakdown row alone should show count 4. A
  // recipe with no events (draftRecipeId, never published, never used) has
  // no row at all — the breakdown lists what happened, not every recipe that
  // exists. ---
  const projectBreakdown = await owner.query(api.statistics.queries.getProjectBreakdown, { organizationId, paginationOpts: page });
  expect(projectBreakdown.page).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ project: expect.objectContaining({ _id: projectA }), count: 2 }),
      expect.objectContaining({ project: expect.objectContaining({ _id: projectB }), count: 2 }),
    ]),
  );
  expect(projectBreakdown.page).toHaveLength(2);

  const recipeBreakdown = await owner.query(api.statistics.queries.getRecipeBreakdown, { organizationId, paginationOpts: page });
  expect(recipeBreakdown.page).toHaveLength(1);
  expect(recipeBreakdown.page[0]).toMatchObject({ count: 4 });

  // --- Locations: create (+1), archive (unchanged — archived locations stay
  // counted until actually deleted), delete (-1, only legal once archived). ---
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(0);
  const locationA = await owner.mutation(api.locations.mutations.createLocation, { organizationId, name: 'Depot', type: 'depot' });
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(1);
  await owner.mutation(api.locations.mutations.archiveLocation, { locationId: locationA });
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(1);
  await owner.mutation(api.locations.mutations.deleteLocation, { locationId: locationA });
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(0);
  await owner.mutation(api.locations.mutations.createLocation, { organizationId, name: 'Second depot', type: 'depot' });
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(1);
});

/** An organization with no data of any kind reports clean zeros, not errors. */
test('statistics on a newly created organization are zero or empty except the auto-provisioned starter recipes', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('empty-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Empty', slug: 'empty-org' });

  await expect(owner.query(api.statistics.queries.getServiceStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 0 }, { status: 'planned', count: 0 }, { status: 'confirmed', count: 0 },
    { status: 'active', count: 0 }, { status: 'completed', count: 0 }, { status: 'cancelled', count: 0 },
  ]);
  await expect(owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 0 }, { status: 'active', count: 0 }, { status: 'completed', count: 0 }, { status: 'archived', count: 0 },
  ]);
  // Not 0: `createOrganization` auto-provisions and publishes 4 starter
  // recipes (recipes/builtins.ts) in the same transaction, so every
  // organization is born with this many active recipes.
  await expect(owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(4);
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(0);
  await expect(owner.query(api.statistics.queries.getUpcomingServices, { organizationId, startsAt: 0, endsAt: 1, limit: 10 })).resolves.toEqual([]);
  await expect(owner.query(api.statistics.queries.getProjectBreakdown, { organizationId, paginationOpts: page })).resolves.toMatchObject({ page: [] });
  await expect(owner.query(api.statistics.queries.getRecipeBreakdown, { organizationId, paginationOpts: page })).resolves.toMatchObject({ page: [] });
});

test('every statistics query keeps another organization opaque', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('statistics-owner-a'));
  const outsider = t.withIdentity(identity('statistics-owner-b'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  await outsider.mutation(api.auth.mutations.ensureUser, {});
  const orgA = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'A', slug: 'statistics-a' });
  const orgB = await outsider.mutation(api.organizations.mutations.createOrganization, { name: 'B', slug: 'statistics-b' });

  const calls = [
    () => owner.query(api.statistics.queries.getServiceStatusCounts, { organizationId: orgB }),
    () => owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId: orgB }),
    () => owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId: orgB }),
    () => owner.query(api.statistics.queries.getLocationCount, { organizationId: orgB }),
    () => owner.query(api.statistics.queries.getUpcomingServices, { organizationId: orgB, startsAt: 0, endsAt: 1, limit: 1 }),
    () => owner.query(api.statistics.queries.getProjectBreakdown, { organizationId: orgB, paginationOpts: page }),
    () => owner.query(api.statistics.queries.getRecipeBreakdown, { organizationId: orgB, paginationOpts: page }),
  ];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ data: { code: inaccessible } });

  // The org id being valid but foreign, not simply malformed, is the case I9
  // cares about — confirmed by a real (but zero) answer on the caller's own org.
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId: orgA })).resolves.toBe(0);
});

test('getUpcomingServices rejects an out-of-range window and an invalid limit with stable codes', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('window-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Window Co', slug: 'window-co' });

  // A window wider than the server-enforced cap is refused with a stable
  // code, not silently clamped and not a generic Convex validation error.
  await expect(
    owner.query(api.statistics.queries.getUpcomingServices, { organizationId, startsAt: 0, endsAt: 32 * 24 * 60 * 60 * 1000, limit: 10 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsWindowTooLarge' } });

  // An inverted window (end before start) is a different failure mode from
  // "too large" and gets its own code.
  await expect(
    owner.query(api.statistics.queries.getUpcomingServices, { organizationId, startsAt: 1_000, endsAt: 500, limit: 10 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsWindowInvalid' } });
  await expect(
    owner.query(api.statistics.queries.getUpcomingServices, { organizationId, startsAt: 0, endsAt: Number.POSITIVE_INFINITY, limit: 10 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsWindowInvalid' } });

  // Limits: zero, negative, non-integer, and over the hard maximum are all
  // `statisticsLimitInvalid`, never a bare Convex validator failure.
  await expect(
    owner.query(api.statistics.queries.getUpcomingServices, { organizationId, startsAt: 0, endsAt: 1, limit: 0 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsLimitInvalid' } });
  await expect(
    owner.query(api.statistics.queries.getUpcomingServices, { organizationId, startsAt: 0, endsAt: 1, limit: -1 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsLimitInvalid' } });
  await expect(
    owner.query(api.statistics.queries.getUpcomingServices, { organizationId, startsAt: 0, endsAt: 1, limit: 1.5 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsLimitInvalid' } });
  await expect(
    owner.query(api.statistics.queries.getUpcomingServices, { organizationId, startsAt: 0, endsAt: 1, limit: 101 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsLimitInvalid' } });
});

/**
 * A stale counter row (its target project/recipe deleted or foreign) must not
 * take down the whole breakdown page for every other, perfectly healthy row
 * in the same organization. This is reachable in practice through the dev
 * reset if it is ever missed on a table again (see seed/reset.ts), so the
 * read path must be safe against it regardless of how it happened.
 */
test('a dangling breakdown counter row is skipped rather than aborting the whole page', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('dangling-owner'));
  const other = t.withIdentity(identity('dangling-other'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  await other.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Dangling Co', slug: 'dangling-co' });
  const foreignOrgId = await other.mutation(api.organizations.mutations.createOrganization, { name: 'Foreign Co', slug: 'dangling-foreign' });

  // A genuine, healthy project/recipe breakdown row in THIS organization.
  const fieldId = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'note', label: 'Note', config: textConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'healthy', name: 'Healthy' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: fieldId, required: false, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Healthy project' });
  await owner.mutation(api.events.mutations.createEventFromRecipe, { projectId, recipeVersionId, name: 'Real event', startsAt: 1, values: [] });

  // A dangling counter row for this org, pointing at a PROJECT id from a
  // different organization — simulating exactly the kind of stale reference
  // a missed table in a reset sweep (or any other bug) could leave behind.
  const { foreignProjectId, foreignRecipeId } = await t.run(async (ctx) => {
    const foreignProjectId = await ctx.db.insert('projects', { organizationId: foreignOrgId, name: 'Foreign project', status: 'active' });
    const foreignRecipeId = await ctx.db.insert('eventRecipes', { organizationId: foreignOrgId, key: 'foreign', name: 'Foreign', status: 'active' });
    await ctx.db.insert('statisticsCounters', { organizationId, category: 'projectEvents', projectId: foreignProjectId, count: 7 });
    await ctx.db.insert('statisticsCounters', { organizationId, category: 'recipeEvents', recipeId: foreignRecipeId, count: 9 });
    return { foreignProjectId, foreignRecipeId };
  });
  void foreignProjectId;
  void foreignRecipeId;

  // Neither breakdown throws, and each returns exactly the one healthy row —
  // the dangling one is silently absent, not surfaced as an error to a
  // caller who owns nothing wrong in their own organization.
  const projectBreakdown = await owner.query(api.statistics.queries.getProjectBreakdown, { organizationId, paginationOpts: page });
  expect(projectBreakdown.page).toEqual([expect.objectContaining({ project: expect.objectContaining({ _id: projectId }), count: 1 })]);

  const recipeBreakdown = await owner.query(api.statistics.queries.getRecipeBreakdown, { organizationId, paginationOpts: page });
  expect(recipeBreakdown.page).toEqual([expect.objectContaining({ recipe: expect.objectContaining({ _id: recipeId }), count: 1 })]);
});

/**
 * `backfillOrganizationCounters` is the write path for data that predates the
 * counters, so it is exercised against rows inserted directly with `ctx.db`
 * (bypassing every mutation, the way genuinely pre-existing production rows
 * would have been written before this feature existed) rather than through
 * the normal mutations, which would have populated the counters already and
 * defeat the point of testing a backfill.
 */
test('backfillOrganizationCounters rebuilds counters from legacy data', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('backfill-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Legacy Co', slug: 'legacy-co' });

  const { projectId, recipeId } = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', { organizationId, name: 'Legacy project', status: 'active' });
    const recipeId = await ctx.db.insert('eventRecipes', { organizationId, key: 'legacy', name: 'Legacy', status: 'active' });
    const recipeVersionId = await ctx.db.insert('recipeVersions', { organizationId, recipeId, versionNumber: 1, status: 'published' });
    await ctx.db.insert('events', {
      organizationId, projectId, recipeId, recipeVersionId, name: 'Legacy run', status: 'planned', startsAt: 1_000,
    });
    await ctx.db.insert('locations', { organizationId, name: 'Legacy depot', type: 'depot', status: 'active' });
    return { projectId, recipeId };
  });

  // The legacy rows above were inserted with no mutation, so they have no
  // counter yet: location count reads 0 despite the real legacy location.
  // Active recipe count is NOT 0, though — `createOrganization` publishes 4
  // starter recipes through the real mutation path, so those are already
  // correctly counted; only the legacy recipe (inserted directly) is missing.
  await expect(owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(4);
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(0);

  // `clear` first (idempotent even with nothing to clear), then each data
  // phase, following its own cursor until done — exactly as documented. Note
  // this is `t.mutation`, not an identity-scoped client: `backfillOrganizationCounters`
  // is `internalMutation`, so it has no client-facing door at all — the only
  // "member cannot call it" surface left, and it is a compile-time fact
  // (`api.statistics` has no `backfillOrganizationCounters`) rather than a
  // runtime check to test.
  for (let cleared = false; !cleared; ) {
    const result = await t.mutation(backfill, { organizationId, phase: 'clear', cursor: null });
    cleared = result.isDone;
  }
  for (const phase of ['events', 'projects', 'recipes', 'locations'] as const) {
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const result: { continueCursor: string; isDone: boolean } = await t.mutation(backfill, { organizationId, phase, cursor });
      cursor = result.continueCursor;
      isDone = result.isDone;
    }
  }

  await expect(owner.query(api.statistics.queries.getServiceStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 0 }, { status: 'planned', count: 1 }, { status: 'confirmed', count: 0 },
    { status: 'active', count: 0 }, { status: 'completed', count: 0 }, { status: 'cancelled', count: 0 },
  ]);
  await expect(owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 0 }, { status: 'active', count: 1 }, { status: 'completed', count: 0 }, { status: 'archived', count: 0 },
  ]);
  // `clear` deletes every counter, including the starter recipes' correct
  // ones, and every phase rebuilds strictly from the current entity tables —
  // so the rebuilt total is the 4 starters plus the 1 legacy active recipe.
  await expect(owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(5);
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(1);
  const projectBreakdown = await owner.query(api.statistics.queries.getProjectBreakdown, { organizationId, paginationOpts: page });
  expect(projectBreakdown.page).toEqual([expect.objectContaining({ project: expect.objectContaining({ _id: projectId }), count: 1 })]);
  const recipeBreakdown = await owner.query(api.statistics.queries.getRecipeBreakdown, { organizationId, paginationOpts: page });
  expect(recipeBreakdown.page).toEqual([expect.objectContaining({ recipe: expect.objectContaining({ _id: recipeId }), count: 1 })]);
});

test('backfillOrganizationCounters refuses to run without the deployment opt-in', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('backfill-disabled-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Disabled Co', slug: 'disabled-co' });

  // `enableSeedMutations` sets the flag for every test in this file; drop it
  // to prove the guard is what permits this, not `internalMutation` alone —
  // the same proof `bogotaSeed.test.ts` runs for the other two backfills.
  delete process.env.SANCOCHO_ENABLE_SEED;
  await expect(t.mutation(backfill, { organizationId, phase: 'clear', cursor: null })).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
});

/**
 * Mutation-tested gap: a naive backfill that blindly re-applies `+1` deltas
 * would pass every correctness assertion above and still corrupt a tenant the
 * moment a phase call is replayed. This proves the guard: a completed phase
 * refuses to run again (no silent double count), a cursor that does not match
 * the phase's recorded progress is refused (no silently skipping or
 * replaying a page), and the multi-page path this all depends on actually
 * crosses a page boundary — not just processes everything in one call and
 * calls it covered.
 */
test('backfillOrganizationCounters is idempotent: a completed phase refuses to re-run, a wrong cursor is refused, and paging spans multiple calls', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('backfill-idempotent-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Idempotent Co', slug: 'idempotent-co' });

  // Five legacy projects, forced through a batch size of 2 so the phase
  // genuinely spans three calls (2 + 2 + 1) instead of finishing in one.
  await t.run(async (ctx) => {
    for (let i = 0; i < 5; i += 1) {
      await ctx.db.insert('projects', { organizationId, name: `Legacy project ${i}`, status: 'active' });
    }
  });

  let cursor: string | null = null;
  let isDone = false;
  let callCount = 0;
  let sawIntermediatePage = false;
  while (!isDone) {
    const result: { continueCursor: string; isDone: boolean } = await t.mutation(backfill, {
      organizationId, phase: 'projects', cursor, batchSize: 2,
    });
    callCount += 1;
    if (!result.isDone) sawIntermediatePage = true;
    cursor = result.continueCursor;
    isDone = result.isDone;
  }
  // The whole point of the paginated design (I6): confirms the loop actually
  // crossed a page boundary rather than the phase completing in one call.
  expect(sawIntermediatePage).toBe(true);
  expect(callCount).toBe(3);
  await expect(owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 0 }, { status: 'active', count: 5 }, { status: 'completed', count: 0 }, { status: 'archived', count: 0 },
  ]);

  // Replaying the now-completed phase from the start must be refused outright
  // — not re-applied, which would double every count to 10.
  await expect(
    t.mutation(backfill, { organizationId, phase: 'projects', cursor: null, batchSize: 2 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsBackfillPhaseComplete' } });
  await expect(owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 0 }, { status: 'active', count: 5 }, { status: 'completed', count: 0 }, { status: 'archived', count: 0 },
  ]);

  // A second, independent phase started fresh, then continued with the WRONG
  // cursor (anything other than the one it was actually given back) is
  // refused rather than silently skipping or reprocessing a page.
  await t.run(async (ctx) => {
    await ctx.db.insert('locations', { organizationId, name: 'Legacy depot A', type: 'depot', status: 'active' });
    await ctx.db.insert('locations', { organizationId, name: 'Legacy depot B', type: 'depot', status: 'active' });
  });
  const first = await t.mutation(backfill, { organizationId, phase: 'locations', cursor: null, batchSize: 1 });
  expect(first.isDone).toBe(false);
  await expect(
    t.mutation(backfill, { organizationId, phase: 'locations', cursor: 'not-the-real-cursor', batchSize: 1 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsBackfillCursorInvalid' } });
  // The rejected call did no work: the count is still just the one page
  // already, correctly, processed.
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(1);

  // `clear` resets progress for every phase, so a genuinely fresh backfill —
  // not a replay — is possible afterward.
  for (let cleared = false; !cleared; ) {
    const result = await t.mutation(backfill, { organizationId, phase: 'clear', cursor: null });
    cleared = result.isDone;
  }
  for (let redone = false, redoCursor: string | null = null; !redone; ) {
    const result: { continueCursor: string; isDone: boolean } = await t.mutation(backfill, { organizationId, phase: 'projects', cursor: redoCursor, batchSize: 2 });
    redoCursor = result.continueCursor;
    redone = result.isDone;
  }
  await expect(owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 0 }, { status: 'active', count: 5 }, { status: 'completed', count: 0 }, { status: 'archived', count: 0 },
  ]);
});
