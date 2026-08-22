import { v } from 'convex/values';

import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { assertSeedingEnabled } from '../lib/seedGuard';

/**
 * Wipes a deployment's Services, Recipes, Field Definitions and Locations so a
 * developer can re-seed from a clean slate.
 *
 * This is a **development reset**, and it is the one operation in the codebase
 * that deliberately ignores the deletion policy the domain models enforce
 * (archive rather than delete; never remove a published version or a referenced
 * field). Those rules protect an operating tenant's history; they are exactly
 * what makes a dev deployment impossible to re-seed. So this bypasses them
 * knowingly, in one place, behind the same `SANCOCHO_ENABLE_SEED` opt-in as the
 * rest of `seed/`, rather than weakening any model.
 *
 * What it does NOT touch: users, organizations, memberships, and projects. A
 * developer's sign-in and their tenant survive the reset; only the operational
 * and configuration data listed above is rebuilt. Audit rows are removed for
 * exactly the entity types being deleted, so the log does not keep pointing at
 * ids that no longer resolve, while organization, membership and project
 * history stays intact.
 *
 * Deletion order is child-before-parent throughout, so no row is ever left
 * referencing a deleted one, even though Convex would not stop us.
 */

/** Audit rows for these entity types are removed alongside their entities. */
const clearedEntityTypes: ReadonlySet<Doc<'auditEvents'>['entityType']> = new Set([
  'event',
  'eventRelationship',
  'eventRecipe',
  'recipeVersion',
  'recipeField',
  'fieldDefinition',
  'location',
]);

async function deleteAll<
  T extends
    | 'events'
    | 'eventFieldValues'
    | 'eventRelationships'
    | 'recipeFields'
    | 'recipeVersions'
    | 'eventRecipes'
    | 'fieldDefinitions'
    | 'locations'
    | 'statisticsCounters'
    | 'statisticsTotals'
    | 'statisticsBackfillProgress',
>(
  ctx: MutationCtx,
  table: T,
): Promise<number> {
  // A deployment-wide administrative sweep, not a tenant-facing read: a full
  // scan is the correct shape here and nowhere else (I6 governs public reads).
  const rows = await ctx.db.query(table).collect();
  for (const row of rows) await ctx.db.delete(row._id as Id<T>);
  return rows.length;
}

export const resetTenantOperations = internalMutation({
  args: {},
  returns: v.object({
    events: v.number(),
    eventFieldValues: v.number(),
    eventRelationships: v.number(),
    recipeFields: v.number(),
    recipeVersions: v.number(),
    eventRecipes: v.number(),
    fieldDefinitions: v.number(),
    locations: v.number(),
    statisticsCounters: v.number(),
    statisticsTotals: v.number(),
    statisticsBackfillProgress: v.number(),
    auditEvents: v.number(),
  }),
  handler: async (ctx) => {
    assertSeedingEnabled();

    // Children first: values and relationships reference events, recipe fields
    // reference versions, versions reference recipes.
    const eventFieldValues = await deleteAll(ctx, 'eventFieldValues');
    const eventRelationships = await deleteAll(ctx, 'eventRelationships');
    const events = await deleteAll(ctx, 'events');
    const recipeFields = await deleteAll(ctx, 'recipeFields');
    const recipeVersions = await deleteAll(ctx, 'recipeVersions');
    const eventRecipes = await deleteAll(ctx, 'eventRecipes');
    // Field definitions and locations last: recipe fields and event values were
    // the things pointing at them.
    const fieldDefinitions = await deleteAll(ctx, 'fieldDefinitions');
    const locations = await deleteAll(ctx, 'locations');
    // Every table the maintained statistics counters mirror was just wiped
    // above; leaving these behind would report stale totals for a "clean
    // slate" tenant, and every reseed generation would silently add onto the
    // last one's counts instead of starting from zero.
    const statisticsCounters = await deleteAll(ctx, 'statisticsCounters');
    const statisticsTotals = await deleteAll(ctx, 'statisticsTotals');
    const statisticsBackfillProgress = await deleteAll(ctx, 'statisticsBackfillProgress');

    const audits = await ctx.db.query('auditEvents').collect();
    let auditEvents = 0;
    for (const audit of audits) {
      if (!clearedEntityTypes.has(audit.entityType)) continue;
      await ctx.db.delete(audit._id);
      auditEvents += 1;
    }

    return {
      events,
      eventFieldValues,
      eventRelationships,
      recipeFields,
      recipeVersions,
      eventRecipes,
      fieldDefinitions,
      locations,
      statisticsCounters,
      statisticsTotals,
      statisticsBackfillProgress,
      auditEvents,
    };
  },
});
