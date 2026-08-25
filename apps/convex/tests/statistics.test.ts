import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { maxFilteredScan } from '../convex/statistics/model';
import { maxTrackedFieldDefinitions } from '../convex/validators';
import { enableSeedMutations, modules } from './helpers';

const issuer = 'https://example.clerk.accounts.dev';
const page = { numItems: 10, cursor: null };
const inaccessible = 'notFoundOrInaccessible';
const textConfig = { kind: 'text' } as const;
const numberConfig = { kind: 'number', integer: true } as const;
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
    const eventId = await ctx.db.insert('events', {
      organizationId, projectId, recipeId, recipeVersionId, name: 'Legacy run', status: 'planned', startsAt: 1_000,
    });
    await ctx.db.insert('locations', { organizationId, name: 'Legacy depot', type: 'depot', status: 'active' });
    // A legacy semantic value too, inserted with no mutation exactly like the
    // rest of this fixture: the `events` backfill phase must rebuild
    // `statisticsSemanticCounters` from it, not just the plain event counters.
    const legacyFieldId = await ctx.db.insert('fieldDefinitions', {
      scope: 'organization', organizationId, key: 'legacyPax', label: 'Legacy Pax', status: 'active', semanticType: 'passenger.count', config: { kind: 'number' },
    });
    const legacyRecipeFieldId = await ctx.db.insert('recipeFields', {
      organizationId, recipeVersionId, fieldDefinitionId: legacyFieldId, position: 0, required: false, visible: true, config: { kind: 'number' },
    });
    await ctx.db.insert('eventFieldValues', {
      organizationId, eventId, recipeFieldId: legacyRecipeFieldId, fieldDefinitionId: legacyFieldId, value: { kind: 'number', value: 9 },
    });
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
  // The legacy semantic value (9 passengers, inserted with no mutation) must
  // be rebuilt into the grand total by the same `events` phase.
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId })).resolves.toEqual({
    total: { value: 9, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });

  // A second `clear` must drain `statisticsSemanticCounters` too, not just
  // `statisticsCounters`/`statisticsTotals` — otherwise a genuinely fresh
  // backfill afterward would double every semantic total instead of
  // rebuilding it from zero.
  for (let cleared = false; !cleared; ) {
    const result = await t.mutation(backfill, { organizationId, phase: 'clear', cursor: null });
    cleared = result.isDone;
  }
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId })).resolves.toEqual({
    total: { value: 0, isTruncated: false }, eventCount: { value: 0, isTruncated: false },
  });
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

/**
 * The core correctness test for Task 1 (semantic domain metrics). Two field
 * definitions with DIFFERENT keys are each bound to `passenger.count` on two
 * DIFFERENT recipes — the whole point of "semantic" aggregation is that both
 * contribute to the same total, which a field-key-matching implementation
 * could never do. A third recipe carries no field of either tracked semantic
 * type at all, proving such an event is silently and correctly excluded
 * rather than erroring. Every fact here is produced by driving the real
 * public mutations (`createFieldDefinition`, `createEventFromRecipe`,
 * `changeEventStatus`, …), so this fails if the write-path wiring in
 * events/model.ts is ever dropped.
 */
test('semantic totals aggregate by semanticType across multiple recipes and different field definitions, with per-project/per-status rollups that move on status transitions', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('semantic-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Semantic Co', slug: 'semantic-co' });

  // Two DIFFERENT field definitions, both `passenger.count`, used by two
  // DIFFERENT recipes — never the same field key twice.
  const paxFieldA = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'transferPax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const paxFieldB = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'shuttlePax', label: 'Shuttle passengers', semanticType: 'passenger.count', config: numberConfig });
  const wheelchairField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'chairs', label: 'Wheelchairs', semanticType: 'accessibility.wheelchairCount', config: numberConfig });
  const noteField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'freeNote', label: 'Note', config: textConfig });

  async function publishedVersion(key: string, fields: { fieldDefinitionId: string; required: boolean }[]) {
    const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key, name: key });
    const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
    for (const field of fields) {
      await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: field.fieldDefinitionId as never, required: field.required, visible: true });
    }
    await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
    return recipeVersionId;
  }
  const recipeVersion1 = await publishedVersion('recipeOne', [{ fieldDefinitionId: paxFieldA, required: true }, { fieldDefinitionId: wheelchairField, required: false }]);
  const recipeVersion2 = await publishedVersion('recipeTwo', [{ fieldDefinitionId: paxFieldB, required: true }]);
  // No `passenger.count` or `accessibility.wheelchairCount` field at all —
  // this is the "event whose recipe has no field of that semantic type" case.
  const recipeVersion3 = await publishedVersion('recipeThree', [{ fieldDefinitionId: noteField, required: false }]);

  const project1 = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Project One' });
  const project2 = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Project Two' });

  const event1 = await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId: project1, recipeVersionId: recipeVersion1, name: 'Recipe one run', startsAt: 1_000,
    values: [{ fieldDefinitionId: paxFieldA, value: { kind: 'number', value: 5 } }, { fieldDefinitionId: wheelchairField, value: { kind: 'number', value: 2 } }],
  });
  const event2 = await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId: project1, recipeVersionId: recipeVersion2, name: 'Recipe two run', startsAt: 2_000,
    values: [{ fieldDefinitionId: paxFieldB, value: { kind: 'number', value: 7 } }],
  });
  await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId: project2, recipeVersionId: recipeVersion1, name: 'Recipe one run, project two', startsAt: 3_000,
    values: [{ fieldDefinitionId: paxFieldA, value: { kind: 'number', value: 3 } }, { fieldDefinitionId: wheelchairField, value: { kind: 'number', value: 1 } }],
  });
  await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId: project1, recipeVersionId: recipeVersion3, name: 'No semantic field here', startsAt: 4_000,
    values: [{ fieldDefinitionId: noteField, value: { kind: 'text', value: 'no passengers tracked' } }],
  });

  // --- Grand totals: 5 + 7 + 3 = 15 passengers across THREE events (the
  // fourth, semantic-field-less event correctly contributes to neither the
  // sum nor the event count). Wheelchairs: 2 + 1 = 3 across two events. ---
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId })).resolves.toEqual({
    total: { value: 15, isTruncated: false }, eventCount: { value: 3, isTruncated: false },
  });
  await expect(owner.query(api.statistics.queries.getAccessibilityRequirements, { organizationId })).resolves.toEqual({
    total: { value: 3, isTruncated: false }, eventCount: { value: 2, isTruncated: false },
  });

  // --- Per-project rollups: project1 holds event1 (5 pax) + event2 (7 pax) = 12; project2 holds only the 3-passenger event. ---
  const paxByProject = await owner.query(api.statistics.queries.getPassengerTotalsByProject, { organizationId, paginationOpts: page });
  expect(paxByProject.page).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ project: expect.objectContaining({ _id: project1 }), sum: 12, count: 2 }),
      expect.objectContaining({ project: expect.objectContaining({ _id: project2 }), sum: 3, count: 1 }),
    ]),
  );
  const wheelchairsByProject = await owner.query(api.statistics.queries.getAccessibilityByProject, { organizationId, paginationOpts: page });
  expect(wheelchairsByProject.page).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ project: expect.objectContaining({ _id: project1 }), sum: 2, count: 1 }),
      expect.objectContaining({ project: expect.objectContaining({ _id: project2 }), sum: 1, count: 1 }),
    ]),
  );

  // --- Per-status rollups start all in `draft` (every event's initial status). ---
  await expect(owner.query(api.statistics.queries.getPassengerTotalsByStatus, { organizationId })).resolves.toEqual([
    { status: 'draft', sum: 15, count: 3 }, { status: 'planned', sum: 0, count: 0 }, { status: 'confirmed', sum: 0, count: 0 },
    { status: 'active', sum: 0, count: 0 }, { status: 'completed', sum: 0, count: 0 }, { status: 'cancelled', sum: 0, count: 0 },
  ]);

  // Moving event1 (5 passengers, 2 wheelchairs) from draft to planned must
  // move its VALUE between status buckets too — bidirectionally, exactly
  // like the plain event-status counter test above: draft must actually
  // DROP by 5/2, not just planned rising.
  await owner.mutation(api.events.mutations.changeEventStatus, { eventId: event1, status: 'planned' });
  await expect(owner.query(api.statistics.queries.getPassengerTotalsByStatus, { organizationId })).resolves.toEqual([
    { status: 'draft', sum: 10, count: 2 }, { status: 'planned', sum: 5, count: 1 }, { status: 'confirmed', sum: 0, count: 0 },
    { status: 'active', sum: 0, count: 0 }, { status: 'completed', sum: 0, count: 0 }, { status: 'cancelled', sum: 0, count: 0 },
  ]);
  await expect(owner.query(api.statistics.queries.getAccessibilityByStatus, { organizationId })).resolves.toEqual([
    { status: 'draft', sum: 1, count: 1 }, { status: 'planned', sum: 2, count: 1 }, { status: 'confirmed', sum: 0, count: 0 },
    { status: 'active', sum: 0, count: 0 }, { status: 'completed', sum: 0, count: 0 }, { status: 'cancelled', sum: 0, count: 0 },
  ]);
  // The project rollup is UNCHANGED by the status move: project is immutable
  // per event, so it needed no update at the status-transition site at all.
  const paxByProjectAfterStatusChange = await owner.query(api.statistics.queries.getPassengerTotalsByProject, { organizationId, paginationOpts: page });
  expect(paxByProjectAfterStatusChange.page).toEqual(
    expect.arrayContaining([expect.objectContaining({ project: expect.objectContaining({ _id: project1 }), sum: 12, count: 2 })]),
  );

  // --- A project filter, well under the truncation cap: the filtered path
  // (a real bounded scan, not the counters) must report the exact SAME
  // per-project numbers, with isTruncated false. project1 now holds event1
  // (planned), event2 (draft) and the semantic-field-less event (draft). ---
  await expect(owner.query(api.statistics.queries.getFilteredServiceStatusCounts, { organizationId, projectId: project1 })).resolves.toEqual([
    { status: 'draft', count: 2, isTruncated: false }, { status: 'planned', count: 1, isTruncated: false }, { status: 'confirmed', count: 0, isTruncated: false },
    { status: 'active', count: 0, isTruncated: false }, { status: 'completed', count: 0, isTruncated: false }, { status: 'cancelled', count: 0, isTruncated: false },
  ]);
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, projectId: project1 })).resolves.toEqual({
    total: { value: 12, isTruncated: false }, eventCount: { value: 2, isTruncated: false },
  });

  // --- Occupancy: sample is the three passenger-bearing events [3, 5, 7]
  // (the semantic-field-less event is correctly excluded from the sample). ---
  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId, threshold: 5 })).resolves.toEqual({
    sampleSize: 3, isTruncated: false, mean: 5, median: 5, max: 7, countAtOrAboveThreshold: 2,
  });
});

/**
 * I1/I9 for every new query: another organization stays opaque, whether the
 * caller supplies a foreign `organizationId` outright, or a legitimate
 * `organizationId` paired with a `projectId` that actually belongs to a
 * DIFFERENT organization — the case the reopening decision calls out by
 * name ("a foreign projectId paired with a legitimate organizationId cannot
 * leak anything").
 */
test('every new statistics query keeps another organization opaque, including a foreign projectId paired with a legitimate organizationId', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('new-stats-owner-a'));
  const outsider = t.withIdentity(identity('new-stats-owner-b'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  await outsider.mutation(api.auth.mutations.ensureUser, {});
  const orgA = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'A', slug: 'new-stats-a' });
  const orgB = await outsider.mutation(api.organizations.mutations.createOrganization, { name: 'B', slug: 'new-stats-b' });
  const foreignProjectId = await outsider.mutation(api.projects.mutations.createProject, { organizationId: orgB, name: 'Foreign project' });

  const foreignOrgCalls = [
    () => owner.query(api.statistics.queries.getFilteredServiceStatusCounts, { organizationId: orgB }),
    () => owner.query(api.statistics.queries.getPassengerTotals, { organizationId: orgB }),
    () => owner.query(api.statistics.queries.getPassengerTotalsByProject, { organizationId: orgB, paginationOpts: page }),
    () => owner.query(api.statistics.queries.getPassengerTotalsByStatus, { organizationId: orgB }),
    () => owner.query(api.statistics.queries.getAccessibilityRequirements, { organizationId: orgB }),
    () => owner.query(api.statistics.queries.getAccessibilityByProject, { organizationId: orgB, paginationOpts: page }),
    () => owner.query(api.statistics.queries.getAccessibilityByStatus, { organizationId: orgB }),
    () => owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId: orgB }),
  ];
  for (const call of foreignOrgCalls) await expect(call()).rejects.toMatchObject({ data: { code: inaccessible } });

  // The harder case: the caller's OWN organization, but a `projectId` that
  // belongs to someone else's. Every filter-accepting query must refuse this
  // exactly like a foreign organizationId, not silently ignore the filter or
  // (worse) reveal something about the foreign project.
  const foreignProjectCalls = [
    () => owner.query(api.statistics.queries.getFilteredServiceStatusCounts, { organizationId: orgA, projectId: foreignProjectId }),
    () => owner.query(api.statistics.queries.getPassengerTotals, { organizationId: orgA, projectId: foreignProjectId }),
    () => owner.query(api.statistics.queries.getAccessibilityRequirements, { organizationId: orgA, projectId: foreignProjectId }),
    () => owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId: orgA, projectId: foreignProjectId }),
  ];
  for (const call of foreignProjectCalls) await expect(call()).rejects.toMatchObject({ data: { code: inaccessible } });

  // Cross-org AGGREGATE isolation, not just access-denial: orgB gets a real
  // passenger-bearing service through the real mutation path, and orgA's own
  // totals must stay untouched. A wrong `organizationId` reaching a counter
  // write (e.g. via `version.organizationId`/`event.organizationId` in
  // `applyEventSemanticDelta`) would be invisible to a test that only
  // ever checks an org with zero events of its own.
  const foreignPaxField = await outsider.mutation(api.fields.mutations.createFieldDefinition, {
    organizationId: orgB, key: 'foreignPax', label: 'Foreign Pax', semanticType: 'passenger.count', config: numberConfig,
  });
  const foreignRecipeId = await outsider.mutation(api.recipes.mutations.createRecipe, { organizationId: orgB, key: 'foreignRecipe', name: 'Foreign recipe' });
  const foreignVersionId = await outsider.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId: foreignRecipeId });
  await outsider.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId: foreignVersionId, fieldDefinitionId: foreignPaxField, required: true, visible: true });
  await outsider.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId: foreignVersionId });
  await outsider.mutation(api.events.mutations.createEventFromRecipe, {
    projectId: foreignProjectId, recipeVersionId: foreignVersionId, name: 'Foreign run', startsAt: 1,
    values: [{ fieldDefinitionId: foreignPaxField, value: { kind: 'number', value: 42 } }],
  });

  // Confirmed opaque, not simply malformed: the caller's own org/project still answers normally.
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId: orgA })).resolves.toEqual({
    total: { value: 0, isTruncated: false }, eventCount: { value: 0, isTruncated: false },
  });
  // The outsider's own organization DOES see its real total — proving the
  // zero above is genuine isolation, not a mechanism that reports zero for
  // everyone.
  await expect(outsider.query(api.statistics.queries.getPassengerTotals, { organizationId: orgB })).resolves.toEqual({
    total: { value: 42, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });
});

/**
 * Filter window edges: a service exactly AT the requested `endsAt` is
 * included; one exactly one millisecond past it is not — for BOTH the new
 * filtered service-status-count query and the new semantic-total query, so
 * this covers the two distinct index reads the filtered path uses
 * (`by_project_status_startsAt` and `by_project_startsAt`).
 */
test('getFilteredServiceStatusCounts and getPassengerTotals filter windows are edge-inclusive', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('edge-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Edge Co', slug: 'edge-co' });
  const paxField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'pax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'edgeRecipe', name: 'Edge recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: paxField, required: true, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Edge project' });

  await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Just before the lower edge', startsAt: 999, values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value: 20 } }],
  });
  await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Right at the edge', startsAt: 5_000, values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value: 4 } }],
  });
  await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Just outside', startsAt: 5_001, values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value: 9 } }],
  });

  // Both edges at once: window [1_000, 5_000] must include ONLY the
  // 5_000 event — excluding the 999 event by the LOWER edge and the 5_001
  // event by the upper edge.
  const counts = await owner.query(api.statistics.queries.getFilteredServiceStatusCounts, { organizationId, projectId, startsAt: 1_000, endsAt: 5_000 });
  expect(counts).toEqual(
    expect.arrayContaining([{ status: 'draft', count: 1, isTruncated: false }]),
  );
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, projectId, startsAt: 1_000, endsAt: 5_000 })).resolves.toEqual({
    total: { value: 4, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });

  // Widening the window down to include `startsAt: 999` picks up the third event too.
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, projectId, startsAt: 999, endsAt: 5_000 })).resolves.toEqual({
    total: { value: 24, isTruncated: false }, eventCount: { value: 2, isTruncated: false },
  });

  // Widening the window by one millisecond on the upper edge must pick up the fourth event too.
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, projectId, startsAt: 1_000, endsAt: 5_001 })).resolves.toEqual({
    total: { value: 13, isTruncated: false }, eventCount: { value: 2, isTruncated: false },
  });
});

/**
 * Truncation, both directions, for a FILTERED read specifically (the
 * unfiltered/counter path is exact by construction and covered above).
 * Seeds `maxFilteredScan + 1` real `events`/`eventFieldValues` rows directly
 * with `t.run` rather than through `maxFilteredScan + 1` individual mutation
 * calls — the same "insert legacy-shaped rows directly" pattern the backfill
 * test above uses, and legitimate for the identical reason: the query under
 * test here (`getFilteredServiceStatusCounts` / `getPassengerTotals` /
 * `getOccupancyMetrics`, filtered) reads the real `events`/`eventFieldValues`
 * tables directly, never a counter, so it cannot tell a hand-inserted row
 * from one a mutation would have produced — only the READ side is under test.
 * A raised timeout (default 5s) is genuinely earned: this scans 500+ events,
 * one targeted point lookup per event (see `getTrackedFieldDefinitions`'
 * doc comment in statistics/model.ts), not a bug being papered over.
 */
test('filtered reads carry an explicit truncation signal: exact under the cap, capped with isTruncated true over it', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('truncation-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Truncation Co', slug: 'truncation-co' });
  const paxField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'pax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'truncationRecipe', name: 'Truncation recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: paxField, required: false, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Truncation project' });
  const { recipeId: resolvedRecipeId, recipeFieldId } = await owner.query(api.recipes.queries.getRecipeVersion, { recipeVersionId }).then((result) => ({
    recipeId: result.version.recipeId,
    recipeFieldId: result.recipeFields[0]?._id,
  }));
  if (recipeFieldId === undefined) throw new Error('test setup: expected exactly one recipe field');

  const overCapCount = maxFilteredScan + 1;
  await t.run(async (ctx) => {
    for (let i = 0; i < overCapCount; i += 1) {
      const eventId = await ctx.db.insert('events', {
        organizationId, projectId, recipeId: resolvedRecipeId, recipeVersionId, name: `Bulk event ${i}`, status: 'draft', startsAt: i,
      });
      await ctx.db.insert('eventFieldValues', {
        organizationId, eventId, recipeFieldId, fieldDefinitionId: paxField, value: { kind: 'number', value: 1 },
      });
    }
  });

  const counts = await owner.query(api.statistics.queries.getFilteredServiceStatusCounts, { organizationId, projectId });
  expect(counts).toEqual(
    expect.arrayContaining([{ status: 'draft', count: maxFilteredScan, isTruncated: true }]),
  );
  for (const row of counts) if (row.status !== 'draft') expect(row).toEqual({ status: row.status, count: 0, isTruncated: false });

  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, projectId })).resolves.toEqual({
    total: { value: maxFilteredScan, isTruncated: true }, eventCount: { value: maxFilteredScan, isTruncated: true },
  });

  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId, projectId, threshold: 1 })).resolves.toEqual({
    sampleSize: maxFilteredScan, isTruncated: true, mean: 1, median: 1, max: 1, countAtOrAboveThreshold: maxFilteredScan,
  });
}, 30_000);

test('getOccupancyMetrics rejects an invalid threshold with a stable code', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('threshold-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Threshold Co', slug: 'threshold-co' });

  await expect(
    owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId, threshold: -1 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsThresholdInvalid' } });
  await expect(
    owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId, threshold: Number.POSITIVE_INFINITY }),
  ).rejects.toMatchObject({ data: { code: 'statisticsThresholdInvalid' } });
});

test('getFilteredServiceStatusCounts and getPassengerTotals reject an inverted filter window with a stable code', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('inverted-window-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Inverted Co', slug: 'inverted-co' });

  await expect(
    owner.query(api.statistics.queries.getFilteredServiceStatusCounts, { organizationId, startsAt: 1_000, endsAt: 500 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsFilterWindowInvalid' } });
  await expect(
    owner.query(api.statistics.queries.getPassengerTotals, { organizationId, startsAt: 0, endsAt: Number.POSITIVE_INFINITY }),
  ).rejects.toMatchObject({ data: { code: 'statisticsFilterWindowInvalid' } });
});

/**
 * `updateEventFields` is a SEPARATE write site from `createEventFromRecipe`,
 * and covers three distinct branches of `applyEventSemanticDelta`'s
 * caller: an existing value CHANGING (patch), an existing value being
 * CLEARED (delete), and a value being set from ABSENT (insert). None of
 * these were exercised anywhere else — a delta bug here (wrong sign, wrong
 * count arithmetic, or the call simply missing) would silently corrupt every
 * semantic total forever the first time anyone edited a service after
 * creating it, with nothing in the rest of this file able to notice.
 */
test('semantic counters follow updateEventFields: a value change, a clear, and a re-set from absent all move the grand total and per-status rollup correctly', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('update-fields-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Update Fields Co', slug: 'update-fields-co' });
  const paxField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'pax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const wheelchairField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'chairs', label: 'Wheelchairs', semanticType: 'accessibility.wheelchairCount', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'updateRecipe', name: 'Update recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: paxField, required: true, visible: true });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: wheelchairField, required: false, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Update fields project' });

  const eventId = await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Editable run', startsAt: 1,
    values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value: 5 } }, { fieldDefinitionId: wheelchairField, value: { kind: 'number', value: 2 } }],
  });
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId })).resolves.toEqual({
    total: { value: 5, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });
  await expect(owner.query(api.statistics.queries.getAccessibilityRequirements, { organizationId })).resolves.toEqual({
    total: { value: 2, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });

  // 1. An EXISTING value CHANGES (the `patch` branch): 5 -> 8.
  await owner.mutation(api.events.mutations.updateEventFields, { eventId, values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value: 8 } }] });
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId })).resolves.toEqual({
    total: { value: 8, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });
  await expect(owner.query(api.statistics.queries.getPassengerTotalsByStatus, { organizationId })).resolves.toEqual([
    { status: 'draft', sum: 8, count: 1 }, { status: 'planned', sum: 0, count: 0 }, { status: 'confirmed', sum: 0, count: 0 },
    { status: 'active', sum: 0, count: 0 }, { status: 'completed', sum: 0, count: 0 }, { status: 'cancelled', sum: 0, count: 0 },
  ]);
  const paxByProjectAfterChange = await owner.query(api.statistics.queries.getPassengerTotalsByProject, { organizationId, paginationOpts: page });
  expect(paxByProjectAfterChange.page).toEqual([expect.objectContaining({ project: expect.objectContaining({ _id: projectId }), sum: 8, count: 1 })]);

  // 2. An EXISTING value is CLEARED (the `delete` branch): the wheelchair
  // value is removed outright — the row disappears, not merely zeroes.
  await owner.mutation(api.events.mutations.updateEventFields, { eventId, values: [{ fieldDefinitionId: wheelchairField, value: null }] });
  await expect(owner.query(api.statistics.queries.getAccessibilityRequirements, { organizationId })).resolves.toEqual({
    total: { value: 0, isTruncated: false }, eventCount: { value: 0, isTruncated: false },
  });
  await expect(owner.query(api.statistics.queries.getAccessibilityByStatus, { organizationId })).resolves.toEqual([
    { status: 'draft', sum: 0, count: 0 }, { status: 'planned', sum: 0, count: 0 }, { status: 'confirmed', sum: 0, count: 0 },
    { status: 'active', sum: 0, count: 0 }, { status: 'completed', sum: 0, count: 0 }, { status: 'cancelled', sum: 0, count: 0 },
  ]);

  // 3. A value is set from ABSENT (the `insert` branch): the SAME field,
  // now genuinely absent after step 2, gets a fresh value.
  await owner.mutation(api.events.mutations.updateEventFields, { eventId, values: [{ fieldDefinitionId: wheelchairField, value: { kind: 'number', value: 6 } }] });
  await expect(owner.query(api.statistics.queries.getAccessibilityRequirements, { organizationId })).resolves.toEqual({
    total: { value: 6, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });
  await expect(owner.query(api.statistics.queries.getAccessibilityByStatus, { organizationId })).resolves.toEqual([
    { status: 'draft', sum: 6, count: 1 }, { status: 'planned', sum: 0, count: 0 }, { status: 'confirmed', sum: 0, count: 0 },
    { status: 'active', sum: 0, count: 0 }, { status: 'completed', sum: 0, count: 0 }, { status: 'cancelled', sum: 0, count: 0 },
  ]);
});

/**
 * `getOccupancyMetrics` documents that a truncated sample keeps the MOST
 * RECENT matching events (descending `startsAt`), not the oldest. This is
 * only observable once the scan actually truncates, so it needs real
 * over-cap volume: the oldest event (the one truncation must drop) carries a
 * huge outlier value, and every other event carries `1`. If truncation kept
 * the oldest events instead, the outlier would survive into the sample and
 * `mean`/`max` would be far larger than asserted here.
 */
test('getOccupancyMetrics keeps the most recent events when the scan truncates', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('occupancy-order-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Occupancy Order Co', slug: 'occupancy-order-co' });
  const paxField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'pax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'occupancyRecipe', name: 'Occupancy recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: paxField, required: false, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Occupancy order project' });
  const { recipeId: resolvedRecipeId, recipeFieldId } = await owner.query(api.recipes.queries.getRecipeVersion, { recipeVersionId }).then((result) => ({
    recipeId: result.version.recipeId,
    recipeFieldId: result.recipeFields[0]?._id,
  }));
  if (recipeFieldId === undefined) throw new Error('test setup: expected exactly one recipe field');

  const overCapCount = maxFilteredScan + 1;
  await t.run(async (ctx) => {
    for (let i = 0; i < overCapCount; i += 1) {
      const eventId = await ctx.db.insert('events', {
        organizationId, projectId, recipeId: resolvedRecipeId, recipeVersionId, name: `Ordered event ${i}`, status: 'draft', startsAt: i,
      });
      // i === 0 is the OLDEST event (smallest startsAt) and the only one
      // truncation is allowed to drop under the documented "most recent"
      // rule; every other event carries a plain 1.
      const value = i === 0 ? 999_999 : 1;
      await ctx.db.insert('eventFieldValues', { organizationId, eventId, recipeFieldId, fieldDefinitionId: paxField, value: { kind: 'number', value } });
    }
  });

  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId, projectId })).resolves.toEqual({
    sampleSize: maxFilteredScan, isTruncated: true, mean: 1, median: 1, max: 1, countAtOrAboveThreshold: null,
  });
}, 30_000);

/**
 * A small, distinct, real-mutation sample specifically to distinguish an
 * even-count median (average of the two middle values) from an off-by-one
 * "just take one middle value" bug, and to catch a `mean`/`median` field
 * swap — the values here are deliberately skewed so the two statistics are
 * far apart, unlike the symmetric `[3, 5, 7]` sample used elsewhere in this
 * file where mean and median coincide.
 */
test('getOccupancyMetrics computes an even-count median as the average of the two middle values', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('occupancy-median-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Occupancy Median Co', slug: 'occupancy-median-co' });
  const paxField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'pax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'medianRecipe', name: 'Median recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: paxField, required: true, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Median project' });

  for (const value of [1, 2, 4, 100]) {
    await owner.mutation(api.events.mutations.createEventFromRecipe, {
      projectId, recipeVersionId, name: `Median event ${value}`, startsAt: value,
      values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value } }],
    });
  }

  // sorted [1, 2, 4, 100]: median = (2 + 4) / 2 = 3 (NOT 4, which an
  // off-by-one implementation would return); mean = 107 / 4 = 26.75, far
  // enough from the median that a field swap cannot pass unnoticed.
  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId, projectId })).resolves.toEqual({
    sampleSize: 4, isTruncated: false, mean: 26.75, median: 3, max: 100, countAtOrAboveThreshold: null,
  });
});

/** Unauthenticated access is rejected identically across every new query — no query in this file is reachable without a real identity. */
test('every new statistics query rejects an unauthenticated caller', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('unauthenticated-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Unauthenticated Co', slug: 'unauthenticated-co' });

  const unauthenticated = 'unauthenticated';
  const calls = [
    () => t.query(api.statistics.queries.getFilteredServiceStatusCounts, { organizationId }),
    () => t.query(api.statistics.queries.getPassengerTotals, { organizationId }),
    () => t.query(api.statistics.queries.getPassengerTotalsByProject, { organizationId, paginationOpts: page }),
    () => t.query(api.statistics.queries.getPassengerTotalsByStatus, { organizationId }),
    () => t.query(api.statistics.queries.getAccessibilityRequirements, { organizationId }),
    () => t.query(api.statistics.queries.getAccessibilityByProject, { organizationId, paginationOpts: page }),
    () => t.query(api.statistics.queries.getAccessibilityByStatus, { organizationId }),
    () => t.query(api.statistics.queries.getOccupancyMetrics, { organizationId }),
  ];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ data: { code: unauthenticated } });
});

/**
 * The `count` on `statisticsSemanticCounters` means "this many EVENTS carry
 * a defined value for this semantic type" — NOT "this many field rows".
 * Nothing forbids two different field definitions on the SAME recipe
 * version being bound to the same semantic type (`addRecipeField` only
 * rejects a duplicate `fieldDefinitionId`), so one event can carry two
 * `passenger.count` rows. If the write path applied a delta per FIELD row
 * instead of per EVENT, `eventCount` would read 2 for this one event on the
 * unfiltered path while every filtered/occupancy read (which aggregates by
 * event) would read 1 for the same data — a real, silent inconsistency
 * between two ways of reading the identical event.
 */
test('an event with two different field definitions bound to the same semantic type counts as ONE event, and both values sum', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('double-field-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Double Field Co', slug: 'double-field-co' });
  const adultPax = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'adultPax', label: 'Adults', semanticType: 'passenger.count', config: numberConfig });
  const childPax = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'childPax', label: 'Children', semanticType: 'passenger.count', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'doubleFieldRecipe', name: 'Double field recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: adultPax, required: true, visible: true });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: childPax, required: true, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Double field project' });

  const eventId = await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Family transfer', startsAt: 1,
    values: [{ fieldDefinitionId: adultPax, value: { kind: 'number', value: 2 } }, { fieldDefinitionId: childPax, value: { kind: 'number', value: 3 } }],
  });

  // Sum is 2 + 3 = 5, but eventCount is 1 (ONE event), not 2 (two field rows).
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId })).resolves.toEqual({
    total: { value: 5, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });
  await expect(owner.query(api.statistics.queries.getPassengerTotalsByStatus, { organizationId })).resolves.toEqual([
    { status: 'draft', sum: 5, count: 1 }, { status: 'planned', sum: 0, count: 0 }, { status: 'confirmed', sum: 0, count: 0 },
    { status: 'active', sum: 0, count: 0 }, { status: 'completed', sum: 0, count: 0 }, { status: 'cancelled', sum: 0, count: 0 },
  ]);
  const paxByProject = await owner.query(api.statistics.queries.getPassengerTotalsByProject, { organizationId, paginationOpts: page });
  expect(paxByProject.page).toEqual([expect.objectContaining({ project: expect.objectContaining({ _id: projectId }), sum: 5, count: 1 })]);

  // The unfiltered (counter) and filtered (live scan) paths must agree on
  // the identical data — this is exactly the disagreement a per-field-row
  // delta would introduce.
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, projectId })).resolves.toEqual({
    total: { value: 5, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });

  // Moving the event to `planned` must move the WHOLE aggregate (5, count 1)
  // as one unit, not double it or leave a fractional remainder in `draft`.
  await owner.mutation(api.events.mutations.changeEventStatus, { eventId, status: 'planned' });
  await expect(owner.query(api.statistics.queries.getPassengerTotalsByStatus, { organizationId })).resolves.toEqual([
    { status: 'draft', sum: 0, count: 0 }, { status: 'planned', sum: 5, count: 1 }, { status: 'confirmed', sum: 0, count: 0 },
    { status: 'active', sum: 0, count: 0 }, { status: 'completed', sum: 0, count: 0 }, { status: 'cancelled', sum: 0, count: 0 },
  ]);
});

/**
 * Every other semantic test in this file creates an ORG-SCOPED field. Every
 * new organization is also born with the deployment-wide BUILT-IN field
 * definitions already usable (`createOrganization` provisions and publishes
 * the four starter recipes, which bind `passengerCount`/`wheelchairCount` —
 * see fields/builtins.ts), and the starter recipes are the actual production
 * path a real client demo runs on. `getTrackedFieldDefinitions` must resolve
 * BOTH `organizationId`-scoped fields and the `organizationId: undefined`
 * builtins, or every semantic statistic on a real, non-test-fixture
 * organization silently reads zero.
 */
test('semantic totals aggregate from deployment-wide built-in field definitions, not just org-scoped ones', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('builtin-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Builtin Co', slug: 'builtin-co' });

  const builtins = await owner.query(api.fields.queries.listBuiltinFieldDefinitions, { paginationOpts: page });
  const passengerCountField = builtins.page.find((field) => field.key === 'passengerCount');
  const wheelchairCountField = builtins.page.find((field) => field.key === 'wheelchairCount');
  if (passengerCountField === undefined || wheelchairCountField === undefined) {
    throw new Error('test setup: expected the builtin passengerCount/wheelchairCount field definitions to exist');
  }

  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'builtinRecipe', name: 'Builtin recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: passengerCountField._id, required: true, visible: true });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: wheelchairCountField._id, required: false, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Builtin project' });

  await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Builtin-field run', startsAt: 1,
    values: [
      { fieldDefinitionId: passengerCountField._id, value: { kind: 'number', value: 7 } },
      { fieldDefinitionId: wheelchairCountField._id, value: { kind: 'number', value: 3 } },
    ],
  });

  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId })).resolves.toEqual({
    total: { value: 7, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });
  await expect(owner.query(api.statistics.queries.getAccessibilityRequirements, { organizationId })).resolves.toEqual({
    total: { value: 3, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });
  // The filtered (project-scoped scan) path must agree — it resolves the
  // org's tracked fields the same way as the unfiltered/counter path.
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, projectId })).resolves.toEqual({
    total: { value: 7, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });
  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId })).resolves.toEqual({
    sampleSize: 1, isTruncated: false, mean: 7, median: 7, max: 7, countAtOrAboveThreshold: null,
  });
});

/**
 * `getOccupancyMetrics` must scope its scan to `projectId` exactly like
 * `getSemanticTotal` already does (see the `getPassengerTotals, { …,
 * projectId: project1 }` assertion above) — dropping the filter and scanning
 * org-wide would silently blend a caller's project into every other
 * project's occupancy, which reads as a correct-looking but wrong number,
 * not an error.
 */
test('getOccupancyMetrics respects its projectId filter, not the whole organization', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('occupancy-scope-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Occupancy Scope Co', slug: 'occupancy-scope-co' });
  const paxField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'pax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'occupancyScopeRecipe', name: 'Occupancy scope recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: paxField, required: true, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectA = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Project A' });
  const projectB = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Project B' });

  for (const value of [10, 20]) {
    await owner.mutation(api.events.mutations.createEventFromRecipe, {
      projectId: projectA, recipeVersionId, name: `A ${value}`, startsAt: value,
      values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value } }],
    });
  }
  for (const value of [2, 4]) {
    await owner.mutation(api.events.mutations.createEventFromRecipe, {
      projectId: projectB, recipeVersionId, name: `B ${value}`, startsAt: value,
      values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value } }],
    });
  }

  // project A: mean of [10, 20] = 15 — must not be pulled toward B's much
  // smaller values by a filter that silently scanned the whole org.
  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId, projectId: projectA })).resolves.toEqual({
    sampleSize: 2, isTruncated: false, mean: 15, median: 15, max: 20, countAtOrAboveThreshold: null,
  });
  // project B: mean of [2, 4] = 3.
  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId, projectId: projectB })).resolves.toEqual({
    sampleSize: 2, isTruncated: false, mean: 3, median: 3, max: 4, countAtOrAboveThreshold: null,
  });
  // No `projectId`: combines both projects — [2, 4, 10, 20], mean 9, median
  // (4 + 10) / 2 = 7. This is also the org-wide (no `projectId`)
  // `by_org_startsAt` scan branch, otherwise unexercised by any occupancy test.
  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId })).resolves.toEqual({
    sampleSize: 4, isTruncated: false, mean: 9, median: 7, max: 20, countAtOrAboveThreshold: null,
  });
});

/**
 * The identical dangling-row defense `getProjectBreakdown` already has a
 * test for (see "a dangling breakdown counter row is skipped..." above),
 * applied to the semantic per-project rollup: `getSemanticByProject`
 * inherited the `project.organizationId !== organizationId` guard from that
 * code but had no test of its own proving it actually runs (I1/I9 — a
 * cross-tenant project document must never be exposed through a stale row).
 */
test('a dangling semantic per-project counter row pointing at a foreign project is skipped, not exposed', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('dangling-semantic-owner'));
  const other = t.withIdentity(identity('dangling-semantic-other'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  await other.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Dangling Semantic Co', slug: 'dangling-semantic-co' });
  const foreignOrgId = await other.mutation(api.organizations.mutations.createOrganization, { name: 'Foreign Semantic Co', slug: 'dangling-semantic-foreign' });

  // A genuine, healthy per-project semantic row in THIS organization.
  const paxField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'pax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'danglingSemanticRecipe', name: 'Dangling semantic recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: paxField, required: true, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Healthy semantic project' });
  await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Real event', startsAt: 1, values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value: 5 } }],
  });

  // A dangling counter row for THIS org, pointing at a project id from a
  // DIFFERENT organization — simulating the same kind of stale reference
  // `getProjectBreakdown`'s dangling-row test uses, applied here.
  const foreignProjectId = await t.run(async (ctx) => {
    const foreignProjectId = await ctx.db.insert('projects', { organizationId: foreignOrgId, name: 'Foreign project', status: 'active' });
    await ctx.db.insert('statisticsSemanticCounters', { organizationId, semanticType: 'passenger.count', category: 'project', projectId: foreignProjectId, sum: 999, count: 1 });
    return foreignProjectId;
  });
  void foreignProjectId;

  // Neither throws, and the healthy row is the only one returned — the
  // dangling row (and the foreign project it points at) is silently absent,
  // never surfaced to a caller who owns nothing wrong in their own org.
  const paxByProject = await owner.query(api.statistics.queries.getPassengerTotalsByProject, { organizationId, paginationOpts: page });
  expect(paxByProject.page).toEqual([expect.objectContaining({ project: expect.objectContaining({ _id: projectId }), sum: 5, count: 1 })]);
});

/**
 * Every other filter-window test in this file passes a `projectId`, so the
 * org-wide (no `projectId`) `by_org_status_startsAt` / `by_org_startsAt`
 * branches of the filtered scans were never actually exercised with a real
 * date range — only "no filter at all" (routes to the O(1) counters) or
 * "with a project" were.
 */
test('org-wide date-range filters (no projectId) exercise the by_org_* scan branches', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('org-wide-window-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Org Wide Window Co', slug: 'org-wide-window-co' });
  const paxField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'pax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'orgWideRecipe', name: 'Org wide recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: paxField, required: true, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Org wide project' });

  await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Inside the window', startsAt: 5_000, values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value: 6 } }],
  });
  await owner.mutation(api.events.mutations.createEventFromRecipe, {
    projectId, recipeVersionId, name: 'Outside the window', startsAt: 9_000, values: [{ fieldDefinitionId: paxField, value: { kind: 'number', value: 40 } }],
  });

  // No `projectId` at all: this must route through `by_org_status_startsAt` /
  // `by_org_startsAt`, not the project-scoped indexes.
  const counts = await owner.query(api.statistics.queries.getFilteredServiceStatusCounts, { organizationId, startsAt: 0, endsAt: 6_000 });
  expect(counts).toEqual(expect.arrayContaining([{ status: 'draft', count: 1, isTruncated: false }]));
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, startsAt: 0, endsAt: 6_000 })).resolves.toEqual({
    total: { value: 6, isTruncated: false }, eventCount: { value: 1, isTruncated: false },
  });
  // Widening the window picks up the second event too — proving the window
  // bound itself, not just the branch selection, is live on this path.
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, startsAt: 0, endsAt: 9_000 })).resolves.toEqual({
    total: { value: 46, isTruncated: false }, eventCount: { value: 2, isTruncated: false },
  });
});

/**
 * Truncation at exactly `maxFilteredScan`: every other truncation test in
 * this file seeds `maxFilteredScan + 1` rows (one PAST the cap). Nothing
 * asserted the boundary itself — exactly at the cap must still read exact
 * and `isTruncated: false`, not `true` (an off-by-one `>=` instead of `>`
 * would falsely report truncation on a perfectly complete read).
 */
test('filtered reads report an exact count and isTruncated: false at exactly the cap', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('exact-cap-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Exact Cap Co', slug: 'exact-cap-co' });
  const paxField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'pax', label: 'Passengers', semanticType: 'passenger.count', config: numberConfig });
  const recipeId = await owner.mutation(api.recipes.mutations.createRecipe, { organizationId, key: 'exactCapRecipe', name: 'Exact cap recipe' });
  const recipeVersionId = await owner.mutation(api.recipes.mutations.createInitialDraftVersion, { recipeId });
  await owner.mutation(api.recipes.fields.mutations.addRecipeField, { recipeVersionId, fieldDefinitionId: paxField, required: false, visible: true });
  await owner.mutation(api.recipes.mutations.publishRecipeVersion, { recipeVersionId });
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Exact cap project' });
  const { recipeId: resolvedRecipeId, recipeFieldId } = await owner.query(api.recipes.queries.getRecipeVersion, { recipeVersionId }).then((result) => ({
    recipeId: result.version.recipeId,
    recipeFieldId: result.recipeFields[0]?._id,
  }));
  if (recipeFieldId === undefined) throw new Error('test setup: expected exactly one recipe field');

  await t.run(async (ctx) => {
    for (let i = 0; i < maxFilteredScan; i += 1) {
      const eventId = await ctx.db.insert('events', {
        organizationId, projectId, recipeId: resolvedRecipeId, recipeVersionId, name: `Exact cap event ${i}`, status: 'draft', startsAt: i,
      });
      await ctx.db.insert('eventFieldValues', { organizationId, eventId, recipeFieldId, fieldDefinitionId: paxField, value: { kind: 'number', value: 1 } });
    }
  });

  const counts = await owner.query(api.statistics.queries.getFilteredServiceStatusCounts, { organizationId, projectId });
  expect(counts).toEqual(expect.arrayContaining([{ status: 'draft', count: maxFilteredScan, isTruncated: false }]));
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, projectId })).resolves.toEqual({
    total: { value: maxFilteredScan, isTruncated: false }, eventCount: { value: maxFilteredScan, isTruncated: false },
  });
}, 30_000);

/**
 * `countAtOrAboveThreshold` is deliberately asymmetric with `mean`/`median`/
 * `max` on an empty sample: those three have no answer for zero services
 * (you cannot average zero numbers) and are `null`, but "how many of these
 * services met the bar" has an unambiguous answer even for zero services —
 * `0` — so it does not follow them into `null`. See the matching comment on
 * `getOccupancyMetrics`'s return statement in statistics/model.ts.
 */
test('getOccupancyMetrics on an empty sample returns null statistics, but a defined threshold count of zero (not null)', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('empty-occupancy-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Empty Occupancy Co', slug: 'empty-occupancy-co' });

  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId })).resolves.toEqual({
    sampleSize: 0, isTruncated: false, mean: null, median: null, max: null, countAtOrAboveThreshold: null,
  });
  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId, threshold: 5 })).resolves.toEqual({
    sampleSize: 0, isTruncated: false, mean: null, median: null, max: null, countAtOrAboveThreshold: 0,
  });
});

/**
 * `getTrackedFieldDefinitions{ForType}` resolves a field list on every
 * `createEventFromRecipe`/`updateEventFields`/`changeEventStatus` call.
 * Without a cap, an org binding an unusually large number of custom fields
 * to the same tracked semantic type could push those writes past Convex's
 * per-transaction read limit — service creation would break, not a
 * dashboard get slow. This proves the cap is enforced at CREATE and UPDATE
 * time, with a stable code (never message-text matching), and is scoped per
 * (organization, semanticType) — not a general field-count limit.
 */
test('binding more field definitions than maxTrackedFieldDefinitions to one tracked semantic type is refused at creation and update, with a stable code', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('cap-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Cap Co', slug: 'cap-co' });

  for (let i = 0; i < maxTrackedFieldDefinitions; i += 1) {
    await owner.mutation(api.fields.mutations.createFieldDefinition, {
      organizationId, key: `pax${i}`, label: `Pax ${i}`, semanticType: 'passenger.count', config: numberConfig,
    });
  }
  // The (maxTrackedFieldDefinitions + 1)th binding to the SAME type is refused.
  await expect(owner.mutation(api.fields.mutations.createFieldDefinition, {
    organizationId, key: 'oneTooMany', label: 'One too many', semanticType: 'passenger.count', config: numberConfig,
  })).rejects.toMatchObject({ data: { code: 'fieldSemanticTypeLimitExceeded' } });

  // A DIFFERENT tracked semantic type is entirely unaffected — this is a
  // per-(organization, semanticType) cap, not a general field-count limit.
  await expect(owner.mutation(api.fields.mutations.createFieldDefinition, {
    organizationId, key: 'chairs', label: 'Wheelchairs', semanticType: 'accessibility.wheelchairCount', config: numberConfig,
  })).resolves.not.toBeNull();

  // Updating an EXISTING (currently unbound) field's semanticType onto the
  // already-full type is refused the same way — the check runs on update,
  // not only on creation.
  // A compatible (number, integer) but so-far-unbound field, so the ONLY
  // thing standing between it and success is the capacity check itself.
  const plainField = await owner.mutation(api.fields.mutations.createFieldDefinition, { organizationId, key: 'plain', label: 'Plain', config: numberConfig });
  await expect(owner.mutation(api.fields.mutations.updateFieldDefinition, {
    fieldDefinitionId: plainField, semanticType: 'passenger.count',
  })).rejects.toMatchObject({ data: { code: 'fieldSemanticTypeLimitExceeded' } });

  // Re-saving one of the fields ALREADY in the bucket (unchanged
  // semanticType) is unaffected — the cap only fires when a binding is
  // actually gained, not on every edit to an already-counted field.
  const alreadyBound = await owner.query(api.fields.queries.listFieldDefinitions, { organizationId, paginationOpts: page });
  const existingBoundField = alreadyBound.page.find((field) => field.key === 'pax0');
  if (existingBoundField === undefined) throw new Error('test setup: expected pax0 to exist');
  await expect(owner.mutation(api.fields.mutations.updateFieldDefinition, {
    fieldDefinitionId: existingBoundField._id, label: 'Pax 0 renamed',
  })).resolves.toBeNull();
});

/**
 * The creation-time cap cannot retroactively bound rows written before it
 * existed, so the READ side (`getTrackedFieldDefinitionsForType`) defends
 * itself too: pre-existing data that already exceeds the cap must fail
 * loudly and diagnosably on read, not silently truncate to the cap (which
 * would report a wrong, undercounted total as if it were exact) and not
 * silently blow past it (the exact I6 risk this whole guarantee exists to
 * close). Seeded directly with `t.run`, bypassing `assertSemanticTypeCapacity`
 * entirely — the same "insert legacy-shaped rows directly" pattern the
 * backfill test in this file already uses to simulate pre-existing data.
 */
test('a pre-existing field-definition binding count over the cap is refused on read with a stable code', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('read-cap-owner'));
  await owner.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Read Cap Co', slug: 'read-cap-co' });

  await t.run(async (ctx) => {
    for (let i = 0; i < maxTrackedFieldDefinitions + 1; i += 1) {
      await ctx.db.insert('fieldDefinitions', {
        scope: 'organization', organizationId, key: `legacyPax${i}`, label: `Legacy Pax ${i}`, status: 'active',
        semanticType: 'passenger.count', config: { kind: 'number', integer: true },
      });
    }
  });

  // `getOccupancyMetrics` always takes the scan path (never the maintained
  // counter), so it always resolves tracked field definitions — the
  // cleanest way to exercise the read-side guard directly.
  await expect(owner.query(api.statistics.queries.getOccupancyMetrics, { organizationId })).rejects.toMatchObject({
    data: { code: 'fieldSemanticTypeLimitExceeded' },
  });
  // The filtered `getPassengerTotals` path hits the identical guard.
  const projectId = await owner.mutation(api.projects.mutations.createProject, { organizationId, name: 'Over-cap project' });
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId, projectId })).rejects.toMatchObject({
    data: { code: 'fieldSemanticTypeLimitExceeded' },
  });
  // The UNFILTERED path is unaffected: it reads the maintained counter
  // directly and never resolves the field list at all.
  await expect(owner.query(api.statistics.queries.getPassengerTotals, { organizationId })).resolves.toEqual({
    total: { value: 0, isTruncated: false }, eventCount: { value: 0, isTruncated: false },
  });
});
