import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { requireOrganizationMembership } from '../lib/access';
import { requireOrganizationRole } from '../lib/access';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import type { eventStatusValidator, projectStatusValidator } from '../validators';

type EventStatus = typeof eventStatusValidator.type;
type ProjectStatus = typeof projectStatusValidator.type;
export type CounterCategory = 'eventStatus' | 'projectStatus' | 'activeRecipe' | 'location' | 'projectEvents' | 'recipeEvents';
type Counter = Doc<'statisticsCounters'>;

export const maxUpcomingWindowMs = 31 * 24 * 60 * 60 * 1000;
export const maxUpcomingServices = 100;
const backfillBatchSize = 100;

/**
 * A discriminated union, not one loose bag of optional fields: each category
 * carries exactly the key that identifies its counter row, so a caller cannot
 * (and the schema does not need to) accept a `status` for a project/recipe
 * breakdown row or a `projectId` for a status counter. This is what lets
 * `statisticsCounters.status` stay a real closed union instead of a
 * catch-all string wide enough to hold every category's key.
 */
type ChangeCounterArgs =
  | { organizationId: Id<'organizations'>; delta: number; category: 'eventStatus'; status: EventStatus }
  | { organizationId: Id<'organizations'>; delta: number; category: 'projectStatus'; status: ProjectStatus }
  | { organizationId: Id<'organizations'>; delta: number; category: 'projectEvents'; projectId: Id<'projects'> }
  | { organizationId: Id<'organizations'>; delta: number; category: 'recipeEvents'; recipeId: Id<'eventRecipes'> }
  | { organizationId: Id<'organizations'>; delta: number; category: 'activeRecipe' }
  | { organizationId: Id<'organizations'>; delta: number; category: 'location' };

/** Applies a delta beside the source write; counters never accept client values. */
export async function changeCounter(ctx: MutationCtx, args: ChangeCounterArgs): Promise<void> {
  if (args.category === 'activeRecipe' || args.category === 'location') {
    const { organizationId, delta } = args;
    // Destructured into locals rather than read as `args.category` again below:
    // TypeScript does not carry control-flow narrowing on a property access
    // through a nested function literal, but a freshly bound local keeps it.
    const metric = args.category;
    const total = await ctx.db.query('statisticsTotals').withIndex('by_org_metric', (q) => q.eq('organizationId', organizationId).eq('metric', metric)).first();
    if (total === null) {
      await ctx.db.insert('statisticsTotals', { organizationId, metric, count: delta });
    } else {
      await ctx.db.patch(total._id, { count: total.count + delta });
    }
    return;
  }
  if (args.category === 'projectEvents') {
    const { organizationId, projectId, delta } = args;
    const counter = await ctx.db.query('statisticsCounters').withIndex('by_org_category_project', (q) => q.eq('organizationId', organizationId).eq('category', 'projectEvents').eq('projectId', projectId)).first();
    if (counter === null) {
      await ctx.db.insert('statisticsCounters', { organizationId, category: 'projectEvents', projectId, count: delta });
      return;
    }
    await ctx.db.patch(counter._id, { count: counter.count + delta });
    return;
  }
  if (args.category === 'recipeEvents') {
    const { organizationId, recipeId, delta } = args;
    const counter = await ctx.db.query('statisticsCounters').withIndex('by_org_category_recipe', (q) => q.eq('organizationId', organizationId).eq('category', 'recipeEvents').eq('recipeId', recipeId)).first();
    if (counter === null) {
      await ctx.db.insert('statisticsCounters', { organizationId, category: 'recipeEvents', recipeId, count: delta });
      return;
    }
    await ctx.db.patch(counter._id, { count: counter.count + delta });
    return;
  }
  // Remaining categories are 'eventStatus' | 'projectStatus', both keyed by status.
  const { organizationId, category, status, delta } = args;
  const counter: Counter | null = await ctx.db.query('statisticsCounters').withIndex('by_org_category_status', (q) => q.eq('organizationId', organizationId).eq('category', category).eq('status', status)).first();
  if (counter === null) {
    await ctx.db.insert('statisticsCounters', { organizationId, category, status, count: delta });
    return;
  }
  await ctx.db.patch(counter._id, { count: counter.count + delta });
}

export async function getServiceStatusCounts(ctx: QueryCtx, organizationId: Id<'organizations'>) {
  await requireOrganizationMembership(ctx, organizationId);
  const statuses: EventStatus[] = ['draft', 'planned', 'confirmed', 'active', 'completed', 'cancelled'];
  return Promise.all(statuses.map(async (status) => ({ status, count: (await ctx.db.query('statisticsCounters').withIndex('by_org_category_status', (q) => q.eq('organizationId', organizationId).eq('category', 'eventStatus').eq('status', status)).first())?.count ?? 0 })));
}

export async function getProjectStatusCounts(ctx: QueryCtx, organizationId: Id<'organizations'>) {
  await requireOrganizationMembership(ctx, organizationId);
  const statuses: ProjectStatus[] = ['draft', 'active', 'completed', 'archived'];
  return Promise.all(statuses.map(async (status) => ({ status, count: (await ctx.db.query('statisticsCounters').withIndex('by_org_category_status', (q) => q.eq('organizationId', organizationId).eq('category', 'projectStatus').eq('status', status)).first())?.count ?? 0 })));
}

export async function getActiveRecipeCount(ctx: QueryCtx, organizationId: Id<'organizations'>): Promise<number> {
  await requireOrganizationMembership(ctx, organizationId);
  return (await ctx.db.query('statisticsTotals').withIndex('by_org_metric', (q) => q.eq('organizationId', organizationId).eq('metric', 'activeRecipe')).first())?.count ?? 0;
}
export async function getLocationCount(ctx: QueryCtx, organizationId: Id<'organizations'>): Promise<number> {
  await requireOrganizationMembership(ctx, organizationId);
  return (await ctx.db.query('statisticsTotals').withIndex('by_org_metric', (q) => q.eq('organizationId', organizationId).eq('metric', 'location')).first())?.count ?? 0;
}

export async function getUpcomingServices(ctx: QueryCtx, args: { organizationId: Id<'organizations'>; startsAt: number; endsAt: number; limit: number }): Promise<Doc<'events'>[]> {
  await requireOrganizationMembership(ctx, args.organizationId);
  if (!Number.isFinite(args.startsAt) || !Number.isFinite(args.endsAt) || args.endsAt < args.startsAt) return invalidInput('statisticsWindowInvalid', 'Statistics windows must be finite and ordered');
  if (args.endsAt - args.startsAt > maxUpcomingWindowMs) return invalidInput('statisticsWindowTooLarge', 'Statistics windows have a hard maximum');
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > maxUpcomingServices) return invalidInput('statisticsLimitInvalid', 'Statistics limits have a hard maximum');
  return ctx.db.query('events').withIndex('by_org_startsAt', (q) => q.eq('organizationId', args.organizationId).gte('startsAt', args.startsAt).lte('startsAt', args.endsAt)).take(args.limit);
}

export async function getProjectBreakdown(ctx: QueryCtx, organizationId: Id<'organizations'>, paginationOpts: PaginationOptions): Promise<PaginationResult<{ project: Doc<'projects'>; count: number }>> {
  await requireOrganizationMembership(ctx, organizationId);
  const counters = await ctx.db.query('statisticsCounters').withIndex('by_org_category', (q) => q.eq('organizationId', organizationId).eq('category', 'projectEvents')).paginate(paginationOpts);
  const page = await Promise.all(counters.page.map(async (counter) => { const project = counter.projectId === undefined ? null : await ctx.db.get(counter.projectId); if (project === null || project.organizationId !== organizationId) return notFoundOrInaccessible(); return { project, count: counter.count }; }));
  return { ...counters, page };
}

export async function getRecipeBreakdown(ctx: QueryCtx, organizationId: Id<'organizations'>, paginationOpts: PaginationOptions): Promise<PaginationResult<{ recipe: Doc<'eventRecipes'>; count: number }>> {
  await requireOrganizationMembership(ctx, organizationId);
  const counters = await ctx.db.query('statisticsCounters').withIndex('by_org_category', (q) => q.eq('organizationId', organizationId).eq('category', 'recipeEvents')).paginate(paginationOpts);
  const page = await Promise.all(counters.page.map(async (counter) => { const recipe = counter.recipeId === undefined ? null : await ctx.db.get(counter.recipeId); if (recipe === null || recipe.organizationId !== organizationId) return notFoundOrInaccessible(); return { recipe, count: counter.count }; }));
  return { ...counters, page };
}

/**
 * One bounded step of the operational counter migration. Operators first call
 * `clear`, repeating until done, then repeat the matching data phase with its
 * returned cursor. This keeps the backfill itself within I6 even for legacy
 * tenants that are far larger than a Convex transaction can collect.
 */
export async function backfillOrganizationCounters(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; phase: 'clear' | 'events' | 'projects' | 'recipes' | 'locations'; cursor: string | null },
): Promise<{ continueCursor: string; isDone: boolean }> {
  await requireOrganizationRole(ctx, args.organizationId, 'owner');
  if (args.phase === 'clear') {
    const rows = await ctx.db.query('statisticsCounters').withIndex('by_org_category', (q) => q.eq('organizationId', args.organizationId)).take(backfillBatchSize);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 0) {
      const totals = await ctx.db.query('statisticsTotals').withIndex('by_org_metric', (q) => q.eq('organizationId', args.organizationId)).take(backfillBatchSize);
      for (const total of totals) await ctx.db.delete(total._id);
      return { continueCursor: '', isDone: totals.length === 0 };
    }
    return { continueCursor: '', isDone: rows.length < backfillBatchSize };
  }
  if (args.phase === 'events') {
    const page = await ctx.db.query('events').withIndex('by_org_startsAt', (q) => q.eq('organizationId', args.organizationId)).paginate({ numItems: backfillBatchSize, cursor: args.cursor });
    for (const event of page.page) {
      await changeCounter(ctx, { organizationId: args.organizationId, category: 'eventStatus', status: event.status, delta: 1 });
      await changeCounter(ctx, { organizationId: args.organizationId, category: 'projectEvents', projectId: event.projectId, delta: 1 });
      await changeCounter(ctx, { organizationId: args.organizationId, category: 'recipeEvents', recipeId: event.recipeId, delta: 1 });
    }
    return { continueCursor: page.continueCursor, isDone: page.isDone };
  }
  if (args.phase === 'projects') {
    const page = await ctx.db.query('projects').withIndex('by_org', (q) => q.eq('organizationId', args.organizationId)).paginate({ numItems: backfillBatchSize, cursor: args.cursor });
    for (const project of page.page) await changeCounter(ctx, { organizationId: args.organizationId, category: 'projectStatus', status: project.status, delta: 1 });
    return { continueCursor: page.continueCursor, isDone: page.isDone };
  }
  if (args.phase === 'recipes') {
    const page = await ctx.db.query('eventRecipes').withIndex('by_org', (q) => q.eq('organizationId', args.organizationId)).paginate({ numItems: backfillBatchSize, cursor: args.cursor });
    for (const recipe of page.page) if (recipe.status === 'active') await changeCounter(ctx, { organizationId: args.organizationId, category: 'activeRecipe', delta: 1 });
    return { continueCursor: page.continueCursor, isDone: page.isDone };
  }
  const page = await ctx.db.query('locations').withIndex('by_org', (q) => q.eq('organizationId', args.organizationId)).paginate({ numItems: backfillBatchSize, cursor: args.cursor });
  for (const _location of page.page) await changeCounter(ctx, { organizationId: args.organizationId, category: 'location', delta: 1 });
  return { continueCursor: page.continueCursor, isDone: page.isDone };
}
