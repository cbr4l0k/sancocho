import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { requireOrganizationMembership } from '../lib/access';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { isOwner } from '../lib/roles';
import { assertSeedingEnabled } from '../lib/seedGuard';
import type { eventStatusValidator, projectStatusValidator } from '../validators';

type EventStatus = typeof eventStatusValidator.type;
type ProjectStatus = typeof projectStatusValidator.type;
export type CounterCategory = 'eventStatus' | 'projectStatus' | 'activeRecipe' | 'location' | 'projectEvents' | 'recipeEvents';
type Counter = Doc<'statisticsCounters'>;

export const maxUpcomingWindowMs = 31 * 24 * 60 * 60 * 1000;
export const maxUpcomingServices = 100;
const defaultBackfillBatchSize = 100;
const maxBackfillBatchSize = 100;

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

/**
 * An exhaustive `Record`, not a hand-written array: `Object.keys` on this
 * gives every `EventStatus` literal in declaration order, and a future
 * seventh status fails `tsc` right here until this map is updated, instead of
 * silently leaving `changeCounter` maintaining a bucket this query never
 * reads (the backend mirror of the exhaustive `Record`s `lib/status.ts`
 * already requires on the web console).
 */
const eventStatusPresence: Record<EventStatus, null> = {
  draft: null,
  planned: null,
  confirmed: null,
  active: null,
  completed: null,
  cancelled: null,
};
const eventStatuses = Object.keys(eventStatusPresence) as EventStatus[];

const projectStatusPresence: Record<ProjectStatus, null> = {
  draft: null,
  active: null,
  completed: null,
  archived: null,
};
const projectStatuses = Object.keys(projectStatusPresence) as ProjectStatus[];

/**
 * "Upcoming" is a product decision about which statuses represent work still
 * ahead, not merely a time window: a cancelled or already-completed service
 * is not upcoming work no matter where its `startsAt` falls (see
 * docs/statistics.md). This is an exhaustive `Record` for the same reason
 * `eventStatusPresence` above is one: a future seventh `EventStatus` must
 * fail `tsc` here and force a deliberate decision about which bucket it
 * joins, rather than silently vanishing from (or silently appearing in) the
 * upcoming-services widget.
 */
const isUpcomingEventStatus: Record<EventStatus, boolean> = {
  draft: true,
  planned: true,
  confirmed: true,
  active: true,
  completed: false,
  cancelled: false,
};
const upcomingEventStatuses = eventStatuses.filter((status) => isUpcomingEventStatus[status]);

export async function getServiceStatusCounts(ctx: QueryCtx, organizationId: Id<'organizations'>) {
  await requireOrganizationMembership(ctx, organizationId);
  return Promise.all(eventStatuses.map(async (status) => ({ status, count: (await ctx.db.query('statisticsCounters').withIndex('by_org_category_status', (q) => q.eq('organizationId', organizationId).eq('category', 'eventStatus').eq('status', status)).first())?.count ?? 0 })));
}

export async function getProjectStatusCounts(ctx: QueryCtx, organizationId: Id<'organizations'>) {
  await requireOrganizationMembership(ctx, organizationId);
  return Promise.all(projectStatuses.map(async (status) => ({ status, count: (await ctx.db.query('statisticsCounters').withIndex('by_org_category_status', (q) => q.eq('organizationId', organizationId).eq('category', 'projectStatus').eq('status', status)).first())?.count ?? 0 })));
}

export async function getActiveRecipeCount(ctx: QueryCtx, organizationId: Id<'organizations'>): Promise<number> {
  await requireOrganizationMembership(ctx, organizationId);
  return (await ctx.db.query('statisticsTotals').withIndex('by_org_metric', (q) => q.eq('organizationId', organizationId).eq('metric', 'activeRecipe')).first())?.count ?? 0;
}
export async function getLocationCount(ctx: QueryCtx, organizationId: Id<'organizations'>): Promise<number> {
  await requireOrganizationMembership(ctx, organizationId);
  return (await ctx.db.query('statisticsTotals').withIndex('by_org_metric', (q) => q.eq('organizationId', organizationId).eq('metric', 'location')).first())?.count ?? 0;
}

/**
 * Bounded to `args.limit` events per call, never proportional to tenant size.
 * Only `draft | planned | confirmed | active` count as "upcoming" — see
 * `isUpcomingEventStatus` above and docs/statistics.md. Excluded statuses are
 * never read and filtered afterward: each included status is its own bounded
 * range read off `by_org_status_startsAt`, capped at `args.limit`. That cap is
 * provably sufficient — the true top-`limit` result across every included
 * status can never need more than `limit` rows from any single status, since
 * a status contributing more than that would already exceed the total answer
 * size — whereas taking `limit` rows off the window unfiltered and dropping
 * excluded statuses afterward could silently return fewer than `limit`
 * results even when enough genuinely upcoming ones exist, or in the
 * pathological case be crowded out entirely by a burst of cancelled events.
 */
export async function getUpcomingServices(ctx: QueryCtx, args: { organizationId: Id<'organizations'>; startsAt: number; endsAt: number; limit: number }): Promise<Doc<'events'>[]> {
  await requireOrganizationMembership(ctx, args.organizationId);
  if (!Number.isFinite(args.startsAt) || !Number.isFinite(args.endsAt) || args.endsAt < args.startsAt) return invalidInput('statisticsWindowInvalid', 'Statistics windows must be finite and ordered');
  if (args.endsAt - args.startsAt > maxUpcomingWindowMs) return invalidInput('statisticsWindowTooLarge', 'Statistics windows have a hard maximum');
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > maxUpcomingServices) return invalidInput('statisticsLimitInvalid', 'Statistics limits have a hard maximum');
  const perStatus = await Promise.all(
    upcomingEventStatuses.map((status) =>
      ctx.db
        .query('events')
        .withIndex('by_org_status_startsAt', (q) =>
          q.eq('organizationId', args.organizationId).eq('status', status).gte('startsAt', args.startsAt).lte('startsAt', args.endsAt),
        )
        .take(args.limit),
    ),
  );
  return perStatus.flat().sort((a, b) => a.startsAt - b.startsAt).slice(0, args.limit);
}

export async function getProjectBreakdown(ctx: QueryCtx, organizationId: Id<'organizations'>, paginationOpts: PaginationOptions): Promise<PaginationResult<{ project: Doc<'projects'>; count: number }>> {
  await requireOrganizationMembership(ctx, organizationId);
  const counters = await ctx.db.query('statisticsCounters').withIndex('by_org_category', (q) => q.eq('organizationId', organizationId).eq('category', 'projectEvents')).paginate(paginationOpts);
  const page: { project: Doc<'projects'>; count: number }[] = [];
  for (const counter of counters.page) {
    const project = counter.projectId === undefined ? null : await ctx.db.get(counter.projectId);
    // The org-scoping here is already proven by the index prefix this page
    // was read from (`organizationId` is an `.eq` on the index, not a filter
    // over foreign rows); this `db.get` is a dangling-reference consistency
    // check, not the authorization boundary, so a row that fails it is
    // skipped rather than aborting the caller's own, otherwise-healthy page.
    // (A stale counter is only reachable today through a dev-only reset that
    // hard-deletes projects/events without clearing counters — see
    // seed/reset.ts — but the read must be safe against it regardless.)
    // Actual deletion of the orphan is left to whatever created it: `QueryCtx`
    // has no writable `db`, so pruning is a mutation-context concern, not
    // this read path's.
    if (project === null || project.organizationId !== organizationId) continue;
    page.push({ project, count: counter.count });
  }
  return { ...counters, page };
}

export async function getRecipeBreakdown(ctx: QueryCtx, organizationId: Id<'organizations'>, paginationOpts: PaginationOptions): Promise<PaginationResult<{ recipe: Doc<'eventRecipes'>; count: number }>> {
  await requireOrganizationMembership(ctx, organizationId);
  const counters = await ctx.db.query('statisticsCounters').withIndex('by_org_category', (q) => q.eq('organizationId', organizationId).eq('category', 'recipeEvents')).paginate(paginationOpts);
  const page: { recipe: Doc<'eventRecipes'>; count: number }[] = [];
  for (const counter of counters.page) {
    const recipe = counter.recipeId === undefined ? null : await ctx.db.get(counter.recipeId);
    // See the identical note in `getProjectBreakdown` above.
    if (recipe === null || recipe.organizationId !== organizationId) continue;
    page.push({ recipe, count: counter.count });
  }
  return { ...counters, page };
}

export type BackfillPhase = 'clear' | 'events' | 'projects' | 'recipes' | 'locations';
type BackfillDataPhase = Exclude<BackfillPhase, 'clear'>;

/**
 * Finds the organization's owner user, the same "find the owner" step
 * `seed/mutations.ts` uses when it needs to act as a real user for
 * provisioning. Used only to attribute the audit row this migration writes;
 * an organization somehow missing an owner (should never happen — the final
 * owner can never be removed, see `lib/roles.ts`) just gets no audit row
 * rather than failing the backfill over it.
 */
async function resolveOrganizationOwnerUserId(ctx: MutationCtx, organizationId: Id<'organizations'>): Promise<Id<'users'> | null> {
  // Bounded by an organization's membership roster (a logistics team's staff
  // count), not by any operational data that grows with tenant usage — the
  // same collect `seed/mutations.ts` already does for the identical lookup.
  const memberships = await ctx.db.query('organizationMemberships').withIndex('by_org_user', (q) => q.eq('organizationId', organizationId)).collect();
  const owner = memberships.find((membership) => isOwner(membership.role));
  return owner?.userId ?? null;
}

async function recordBackfillAudit(ctx: MutationCtx, organizationId: Id<'organizations'>, phase: BackfillPhase, isDone: boolean): Promise<void> {
  const actorUserId = await resolveOrganizationOwnerUserId(ctx, organizationId);
  if (actorUserId === null) return;
  await recordAuditEvent(ctx, {
    organizationId,
    actorUserId,
    action: 'organization.statisticsBackfilled',
    entityType: 'organization',
    entityId: organizationId,
    metadata: { phase: isDone ? `${phase}:done` : phase },
  });
}

async function runBackfillDataPhase(
  ctx: MutationCtx,
  organizationId: Id<'organizations'>,
  phase: BackfillDataPhase,
  cursor: string | null,
  batchSize: number,
): Promise<{ continueCursor: string; isDone: boolean }> {
  if (phase === 'events') {
    const page = await ctx.db.query('events').withIndex('by_org_startsAt', (q) => q.eq('organizationId', organizationId)).paginate({ numItems: batchSize, cursor });
    for (const event of page.page) {
      await changeCounter(ctx, { organizationId, category: 'eventStatus', status: event.status, delta: 1 });
      await changeCounter(ctx, { organizationId, category: 'projectEvents', projectId: event.projectId, delta: 1 });
      await changeCounter(ctx, { organizationId, category: 'recipeEvents', recipeId: event.recipeId, delta: 1 });
    }
    return { continueCursor: page.continueCursor, isDone: page.isDone };
  }
  if (phase === 'projects') {
    const page = await ctx.db.query('projects').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).paginate({ numItems: batchSize, cursor });
    for (const project of page.page) await changeCounter(ctx, { organizationId, category: 'projectStatus', status: project.status, delta: 1 });
    return { continueCursor: page.continueCursor, isDone: page.isDone };
  }
  if (phase === 'recipes') {
    const page = await ctx.db.query('eventRecipes').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).paginate({ numItems: batchSize, cursor });
    for (const recipe of page.page) if (recipe.status === 'active') await changeCounter(ctx, { organizationId, category: 'activeRecipe', delta: 1 });
    return { continueCursor: page.continueCursor, isDone: page.isDone };
  }
  const page = await ctx.db.query('locations').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).paginate({ numItems: batchSize, cursor });
  for (const _location of page.page) await changeCounter(ctx, { organizationId, category: 'location', delta: 1 });
  return { continueCursor: page.continueCursor, isDone: page.isDone };
}

/**
 * One bounded step of the operational counter migration, guarded like the
 * deployment's other two backfills (`seed/mutations.ts`
 * `backfillRecipeVersionPublishedAt` / `backfillSearchText`): an internal
 * function reachable only via `convex run`, and still gated by
 * `assertSeedingEnabled()` behind it, because "it is not part of the public
 * API" does not by itself stop someone running it against production.
 *
 * Idempotency is enforced with `statisticsBackfillProgress`, one row per
 * (organization, phase): a data phase must present the exact cursor that row
 * remembers, and once a phase is marked done it refuses to run again until
 * `clear` resets it. Without this, replaying `phase: 'events'` — a retried
 * client, or an operator re-running a stale command — would permanently
 * double-count every event with nothing in the audit log to explain why.
 * `clear` resets every phase's progress for a fresh generation; it is itself
 * naturally idempotent (a completed clear finds nothing left to delete).
 *
 * Every call is bounded to `batchSize` documents (default and hard maximum
 * 100), so the migration is executable for a legacy tenant far larger than
 * one Convex transaction can collect, and remains a maintenance-window
 * operation an operator drives call by call — never a single unbounded
 * sweep, and never reachable from client code.
 */
export async function backfillOrganizationCounters(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; phase: BackfillPhase; cursor: string | null; batchSize?: number },
): Promise<{ continueCursor: string; isDone: boolean }> {
  assertSeedingEnabled();
  const organization = await ctx.db.get(args.organizationId);
  if (organization === null) return notFoundOrInaccessible();
  const requested = args.batchSize ?? defaultBackfillBatchSize;
  const batchSize = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), maxBackfillBatchSize) : defaultBackfillBatchSize;

  if (args.phase === 'clear') {
    // Bounded at exactly 4 rows per organization by construction — one per
    // `BackfillDataPhase`, enforced by the `by_org_phase` unique index — never
    // proportional to tenant data.
    const progressRows = await ctx.db.query('statisticsBackfillProgress').withIndex('by_org_phase', (q) => q.eq('organizationId', args.organizationId)).collect();
    for (const row of progressRows) await ctx.db.delete(row._id);

    const rows = await ctx.db.query('statisticsCounters').withIndex('by_org_category', (q) => q.eq('organizationId', args.organizationId)).take(batchSize);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 0) {
      const totals = await ctx.db.query('statisticsTotals').withIndex('by_org_metric', (q) => q.eq('organizationId', args.organizationId)).take(batchSize);
      for (const total of totals) await ctx.db.delete(total._id);
      const isDone = totals.length === 0;
      await recordBackfillAudit(ctx, args.organizationId, 'clear', isDone);
      return { continueCursor: '', isDone };
    }
    await recordBackfillAudit(ctx, args.organizationId, 'clear', false);
    return { continueCursor: '', isDone: rows.length < batchSize };
  }

  const phase = args.phase;
  const progress = await ctx.db.query('statisticsBackfillProgress').withIndex('by_org_phase', (q) => q.eq('organizationId', args.organizationId).eq('phase', phase)).unique();
  if (progress !== null) {
    if (progress.done) return invalidInput('statisticsBackfillPhaseComplete', `Phase '${phase}' already completed for this organization; run 'clear' to start a fresh backfill`);
    if (progress.cursor !== args.cursor) return invalidInput('statisticsBackfillCursorInvalid', `Backfill cursor does not match phase '${phase}'s recorded progress`);
  } else if (args.cursor !== null) {
    return invalidInput('statisticsBackfillCursorInvalid', `Phase '${phase}' has not started for this organization; call it with cursor null first`);
  }

  const page = await runBackfillDataPhase(ctx, args.organizationId, phase, args.cursor, batchSize);
  const nextCursor = page.isDone ? null : page.continueCursor;
  if (progress === null) {
    await ctx.db.insert('statisticsBackfillProgress', { organizationId: args.organizationId, phase, cursor: nextCursor, done: page.isDone });
  } else {
    await ctx.db.patch(progress._id, { cursor: nextCursor, done: page.isDone });
  }
  await recordBackfillAudit(ctx, args.organizationId, phase, page.isDone);
  return page;
}
