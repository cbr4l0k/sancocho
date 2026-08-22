import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { modules } from './helpers';

const issuer = 'https://example.clerk.accounts.dev';
const page = { numItems: 10, cursor: null };
const inaccessible = 'notFoundOrInaccessible';
const textConfig = { kind: 'text' } as const;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

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
  // one; archiving an ACTIVE recipe is the only path back down; archiving a
  // still-draft recipe must not move the counter at all. ---
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
  // Archiving a recipe that was never published (still draft) must not touch
  // the active count: it was never counted as active in the first place.
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

  // Now archive projectA: all of its events are already terminal or otherwise
  // done being transitioned, so the freeze cannot block anything left to do.
  await owner.mutation(api.projects.mutations.archiveProject, { projectId: projectA });
  await expect(owner.query(api.statistics.queries.getProjectStatusCounts, { organizationId })).resolves.toEqual([
    { status: 'draft', count: 1 }, { status: 'active', count: 0 }, { status: 'completed', count: 0 }, { status: 'archived', count: 1 },
  ]);

  // --- Upcoming services: window edges. event1 (startsAt 1000) and event2
  // (startsAt 2000, the window's own end) are included; event3 (startsAt
  // 2001, one past the end) is excluded. ---
  const upcoming = await owner.query(api.statistics.queries.getUpcomingServices, {
    organizationId, startsAt: 1_000, endsAt: 2_000, limit: 10,
  });
  expect(upcoming.map((event) => event._id)).toEqual([event1, event2]);

  // --- Project and recipe breakdowns: projectA holds 2 events (event1,
  // event2), projectB holds 1 (event3); every event used the one published
  // recipe, so its breakdown row alone should show count 3. A recipe with no
  // events (draftRecipeId, never published, never used) has no row at all —
  // the breakdown lists what happened, not every recipe that exists. ---
  const projectBreakdown = await owner.query(api.statistics.queries.getProjectBreakdown, { organizationId, paginationOpts: page });
  expect(projectBreakdown.page).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ project: expect.objectContaining({ _id: projectA }), count: 2 }),
      expect.objectContaining({ project: expect.objectContaining({ _id: projectB }), count: 1 }),
    ]),
  );
  expect(projectBreakdown.page).toHaveLength(2);

  const recipeBreakdown = await owner.query(api.statistics.queries.getRecipeBreakdown, { organizationId, paginationOpts: page });
  expect(recipeBreakdown.page).toHaveLength(1);
  expect(recipeBreakdown.page[0]).toMatchObject({ count: 3 });

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

test('every statistics query keeps another organization opaque, and rejects an out-of-range window', async () => {
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
    () => owner.mutation(api.statistics.mutations.backfillOrganizationCounters, { organizationId: orgB, phase: 'clear', cursor: null }),
  ];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ data: { code: inaccessible } });

  // The org id being valid but foreign, not simply malformed, is the case I9
  // cares about — confirmed by a real (but zero) answer on the caller's own org.
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId: orgA })).resolves.toBe(0);

  // A window wider than the server-enforced cap is refused with a stable code,
  // not silently clamped and not a generic Convex validation error.
  await expect(
    owner.query(api.statistics.queries.getUpcomingServices, { organizationId: orgA, startsAt: 0, endsAt: 32 * 24 * 60 * 60 * 1000, limit: 10 }),
  ).rejects.toMatchObject({ data: { code: 'statisticsWindowTooLarge' } });
});

/**
 * `backfillOrganizationCounters` is the write path for data that predates the
 * counters, so it is exercised against rows inserted directly with `ctx.db`
 * (bypassing every mutation, the way genuinely pre-existing production rows
 * would have been written before this feature existed) rather than through
 * the normal mutations, which would have populated the counters already and
 * defeat the point of testing a backfill.
 */
test('backfillOrganizationCounters rebuilds counters from legacy data and is owner-only', async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity('backfill-owner'));
  const member = t.withIdentity(identity('backfill-member'));
  const ownerUserId = await owner.mutation(api.auth.mutations.ensureUser, {});
  const memberUserId = await member.mutation(api.auth.mutations.ensureUser, {});
  const organizationId = await owner.mutation(api.organizations.mutations.createOrganization, { name: 'Legacy Co', slug: 'legacy-co' });
  await owner.mutation(api.organizations.mutations.addMember, { organizationId, userId: memberUserId, role: 'admin' });
  void ownerUserId;

  const { projectId, recipeId, eventId } = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert('projects', { organizationId, name: 'Legacy project', status: 'active' });
    const recipeId = await ctx.db.insert('eventRecipes', { organizationId, key: 'legacy', name: 'Legacy', status: 'active' });
    const recipeVersionId = await ctx.db.insert('recipeVersions', { organizationId, recipeId, versionNumber: 1, status: 'published' });
    const eventId = await ctx.db.insert('events', {
      organizationId, projectId, recipeId, recipeVersionId, name: 'Legacy run', status: 'planned', startsAt: 1_000,
    });
    await ctx.db.insert('locations', { organizationId, name: 'Legacy depot', type: 'depot', status: 'active' });
    return { projectId, recipeId, eventId };
  });
  void eventId;

  // The legacy rows above were inserted with no mutation, so they have no
  // counter yet: location count reads 0 despite the real legacy location.
  // Active recipe count is NOT 0, though — `createOrganization` publishes 4
  // starter recipes through the real mutation path, so those are already
  // correctly counted; only the legacy recipe (inserted directly) is missing.
  await expect(owner.query(api.statistics.queries.getActiveRecipeCount, { organizationId })).resolves.toBe(4);
  await expect(owner.query(api.statistics.queries.getLocationCount, { organizationId })).resolves.toBe(0);

  // A non-owner member cannot run the migration, whether or not there is
  // anything to migrate.
  await expect(
    member.mutation(api.statistics.mutations.backfillOrganizationCounters, { organizationId, phase: 'clear', cursor: null }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  // `clear` first (idempotent even with nothing to clear), then each data
  // phase, following its own cursor until done — exactly as documented.
  for (let cleared = false; !cleared; ) {
    const result = await owner.mutation(api.statistics.mutations.backfillOrganizationCounters, { organizationId, phase: 'clear', cursor: null });
    cleared = result.isDone;
  }
  for (const phase of ['events', 'projects', 'recipes', 'locations'] as const) {
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const result: { continueCursor: string; isDone: boolean } = await owner.mutation(
        api.statistics.mutations.backfillOrganizationCounters,
        { organizationId, phase, cursor },
      );
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
