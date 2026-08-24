import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { requireOrganizationMembership } from '../lib/access';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { isOwner } from '../lib/roles';
import { assertSeedingEnabled } from '../lib/seedGuard';
import { semanticTypesForCapability } from '../validators';
import type { eventFieldValueValidator, eventStatusValidator, projectStatusValidator, SemanticType } from '../validators';

type EventStatus = typeof eventStatusValidator.type;
type ProjectStatus = typeof projectStatusValidator.type;
type EventFieldValue = typeof eventFieldValueValidator.type;
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

// ===========================================================================
// Semantic domain metrics (Task 1) and filtered/bounded reads (Task 2).
// See docs/statistics.md "Semantic aggregation" and "Filtered reads" for the
// full design rationale; the summary that matters for reading this code:
//
// - `passengerTotals` / `accessibilityRequirements` grand totals and their
//   per-project rollups are MAINTAINED COUNTERS (like everything above),
//   updated wherever `eventFieldValues` is written — `projectId` never
//   changes for an existing event, so that dimension needs no other site.
// - Their per-status rollup is ALSO a maintained counter, but status is
//   mutable, so it additionally needs updating at the event's own status
//   transition (`moveSemanticStatusBuckets`, wired into
//   `events/model.ts changeEventStatus`).
// - `occupancyMetrics` needs a full distribution (median, max), which a
//   running counter cannot answer at any cardinality — it is ALWAYS a
//   bounded, capped scan, never a counter, regardless of filters.
// - Every FILTERED read (a `projectId` and/or date range supplied) abandons
//   counters for a bounded, capped scan with an explicit truncation signal,
//   because a counter cannot answer an arbitrary range — this is the same
//   `{ value, isTruncated }` contract for a filtered service-status count as
//   for a filtered semantic total.
// ===========================================================================

/** The console renders "500+" past this cap, per the reopening decision. */
export const maxFilteredScan = 500;

/**
 * Semantic types this file maintains counters for, derived from the registry
 * via the capabilities they are bound to (`fields/builtins.ts` binds
 * `passenger.count` → `passengerTotals`/`occupancyMetrics` and
 * `accessibility.wheelchairCount` → `accessibilityRequirements` today) —
 * never a field key or label. `TrackedSemanticType` is a hand-written literal
 * union, not derived from that computation, because it has to be a real
 * TypeScript literal type for `statisticsSemanticCounters.semanticType` and
 * the discriminated `ChangeSemanticCounterArgs` below; the assertion
 * immediately after is what keeps the two from silently drifting apart if
 * the registry ever rebinds a capability to a different (or additional)
 * field.
 */
export type TrackedSemanticType = 'passenger.count' | 'accessibility.wheelchairCount';

const trackedSemanticTypesFromRegistry: readonly SemanticType[] = [
  ...semanticTypesForCapability('passengerTotals'),
  ...semanticTypesForCapability('accessibilityRequirements'),
];
const trackedSemanticTypes: readonly TrackedSemanticType[] = ['passenger.count', 'accessibility.wheelchairCount'];
if (
  trackedSemanticTypesFromRegistry.length !== trackedSemanticTypes.length
  || trackedSemanticTypesFromRegistry.some((type) => !(trackedSemanticTypes as readonly SemanticType[]).includes(type))
) {
  // Loud and immediate (module load, i.e. deploy time), not a silently wrong
  // dashboard number discovered later: the registry's capability bindings no
  // longer match this file's hand-written TrackedSemanticType union above.
  throw new Error('statistics/model.ts TrackedSemanticType is out of sync with the semantic registry capability bindings');
}

function isTrackedSemanticType(type: SemanticType | undefined): type is TrackedSemanticType {
  return type === 'passenger.count' || type === 'accessibility.wheelchairCount';
}

/** `null`/`undefined` and any non-`number` kind (should not occur for a tracked field; see `assertSemanticCompatibility`) both read as "no value". */
function numericValue(value: EventFieldValue | null | undefined): number | undefined {
  if (value === null || value === undefined || value.kind !== 'number') return undefined;
  return value.value;
}

type ChangeSemanticCounterArgs =
  | { organizationId: Id<'organizations'>; semanticType: TrackedSemanticType; category: 'total'; deltaSum: number; deltaCount: number }
  | { organizationId: Id<'organizations'>; semanticType: TrackedSemanticType; category: 'eventStatus'; status: EventStatus; deltaSum: number; deltaCount: number }
  | { organizationId: Id<'organizations'>; semanticType: TrackedSemanticType; category: 'project'; projectId: Id<'projects'>; deltaSum: number; deltaCount: number };

/** Applies a (sum, count) delta beside the source write, mirroring `changeCounter` above. */
async function changeSemanticCounter(ctx: MutationCtx, args: ChangeSemanticCounterArgs): Promise<void> {
  if (args.deltaSum === 0 && args.deltaCount === 0) return;
  if (args.category === 'total') {
    const { organizationId, semanticType, deltaSum, deltaCount } = args;
    const counter = await ctx.db.query('statisticsSemanticCounters').withIndex('by_org_semantic_category', (q) => q.eq('organizationId', organizationId).eq('semanticType', semanticType).eq('category', 'total')).first();
    if (counter === null) {
      await ctx.db.insert('statisticsSemanticCounters', { organizationId, semanticType, category: 'total', sum: deltaSum, count: deltaCount });
      return;
    }
    await ctx.db.patch(counter._id, { sum: counter.sum + deltaSum, count: counter.count + deltaCount });
    return;
  }
  if (args.category === 'project') {
    const { organizationId, semanticType, projectId, deltaSum, deltaCount } = args;
    const counter = await ctx.db.query('statisticsSemanticCounters').withIndex('by_org_semantic_category_project', (q) => q.eq('organizationId', organizationId).eq('semanticType', semanticType).eq('category', 'project').eq('projectId', projectId)).first();
    if (counter === null) {
      await ctx.db.insert('statisticsSemanticCounters', { organizationId, semanticType, category: 'project', projectId, sum: deltaSum, count: deltaCount });
      return;
    }
    await ctx.db.patch(counter._id, { sum: counter.sum + deltaSum, count: counter.count + deltaCount });
    return;
  }
  const { organizationId, semanticType, status, deltaSum, deltaCount } = args;
  const counter = await ctx.db.query('statisticsSemanticCounters').withIndex('by_org_semantic_category_status', (q) => q.eq('organizationId', organizationId).eq('semanticType', semanticType).eq('category', 'eventStatus').eq('status', status)).first();
  if (counter === null) {
    await ctx.db.insert('statisticsSemanticCounters', { organizationId, semanticType, category: 'eventStatus', status, sum: deltaSum, count: deltaCount });
    return;
  }
  await ctx.db.patch(counter._id, { sum: counter.sum + deltaSum, count: counter.count + deltaCount });
}

/**
 * Every field definition in this organization (org-scoped + the
 * deployment-wide builtins) whose semantic type is tracked, resolved ONCE
 * per top-level statistics call rather than per event scanned. This is the
 * I6 fix for the per-event fan-out: instead of reading an event's entire
 * (up to `maxFieldsPerVersion`) set of field values and probing each one's
 * definition, every event-level read below does exactly `K` targeted,
 * indexed point lookups — one per entry this function returns — where `K`
 * is the number of DISTINCT field definitions this organization has ever
 * bound to a tracked semantic type. `K` is bounded by configuration (how
 * many fields an admin has created), not by operational volume (how many
 * events exist or how many fields one recipe version composes), which is
 * the same category of bound `resolveOrganizationOwnerUserId`'s membership
 * roster collect above already relies on.
 */
async function getTrackedFieldDefinitions(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<'organizations'>,
): Promise<{ fieldDefinitionId: Id<'fieldDefinitions'>; semanticType: TrackedSemanticType }[]> {
  const [orgFields, builtinFields] = await Promise.all([
    ctx.db.query('fieldDefinitions').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect(),
    ctx.db.query('fieldDefinitions').withIndex('by_org', (q) => q.eq('organizationId', undefined)).collect(),
  ]);
  const tracked: { fieldDefinitionId: Id<'fieldDefinitions'>; semanticType: TrackedSemanticType }[] = [];
  for (const field of [...orgFields, ...builtinFields]) {
    if (isTrackedSemanticType(field.semanticType)) tracked.push({ fieldDefinitionId: field._id, semanticType: field.semanticType });
  }
  return tracked;
}

/**
 * Resolves the tracked semantic values one event currently carries, via one
 * targeted, indexed point lookup per entry in `trackedFields` — never a
 * `.collect()` of the event's own (up to `maxFieldsPerVersion`) field-value
 * rows. Safe under I3 for the same reason `getTrackedFieldDefinitions`'
 * caller resolved `trackedFields` from LIVE `fieldDefinitions.semanticType`
 * is safe: that type is frozen the instant any published version references
 * the field (`fields/model.ts` `updateFieldDefinition`,
 * `historicalMeaningFields`), and an `eventFieldValues` row can only exist
 * for a field whose recipe version was published, so the freeze is already
 * in effect by the time this function can ever see the row. If two DIFFERENT
 * field definitions on the same event are bound to the same semantic type,
 * their values are summed rather than one overwriting the other — this is
 * also what makes "has a value" (for `count`) mean "the event's aggregate
 * for this semantic type is defined", consistently across every caller.
 */
async function resolveTrackedSemanticValues(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<'events'>,
  trackedFields: readonly { fieldDefinitionId: Id<'fieldDefinitions'>; semanticType: TrackedSemanticType }[],
): Promise<Partial<Record<TrackedSemanticType, number>>> {
  const values: Partial<Record<TrackedSemanticType, number>> = {};
  for (const { fieldDefinitionId, semanticType } of trackedFields) {
    const row = await ctx.db.query('eventFieldValues').withIndex('by_event_field', (q) => q.eq('eventId', eventId).eq('fieldDefinitionId', fieldDefinitionId)).unique();
    if (row === null) continue;
    const value = numericValue(row.value);
    if (value === undefined) continue;
    values[semanticType] = (values[semanticType] ?? 0) + value;
  }
  return values;
}

/**
 * Applies whatever delta a batch of `eventFieldValues` writes made to one
 * event's maintained semantic counters, by comparing the event's AGGREGATE
 * value per tracked semantic type before the writes to its aggregate value
 * after — never a per-field-row delta. This is deliberate, not incidental:
 * `count` means "this many EVENTS carry a defined value for this semantic
 * type" (see the schema doc comment on `statisticsSemanticCounters`), and an
 * event can carry TWO different field definitions bound to the same semantic
 * type (nothing in `addRecipeField` forbids it). A per-field-row delta would
 * double-count such an event's presence — `count` would disagree with every
 * other reader of this table (`moveSemanticStatusBuckets`, the backfill, and
 * every filtered read below all already compute deltas the event-aggregate
 * way). Called ONCE per mutation call (`createEventFromRecipe`,
 * `updateEventFields`), after every `eventFieldValues` write for that event
 * has already landed — never per field.
 */
export async function applyEventSemanticDelta(
  ctx: MutationCtx,
  args: {
    organizationId: Id<'organizations'>;
    projectId: Id<'projects'>;
    status: EventStatus;
    eventId: Id<'events'>;
    before: Partial<Record<TrackedSemanticType, number>>;
    // Optional: the caller may already hold this from an earlier
    // `getEventSemanticValuesBeforeEdit` call in the SAME mutation
    // (`updateEventFields`) and pass it through, so the org's tracked field
    // definitions are resolved once per mutation call, not twice.
    trackedFields?: readonly { fieldDefinitionId: Id<'fieldDefinitions'>; semanticType: TrackedSemanticType }[];
  },
): Promise<void> {
  const trackedFields = args.trackedFields ?? (await getTrackedFieldDefinitions(ctx, args.organizationId));
  const after = await resolveTrackedSemanticValues(ctx, args.eventId, trackedFields);
  for (const semanticType of trackedSemanticTypes) {
    const beforeValue = args.before[semanticType];
    const afterValue = after[semanticType];
    const deltaSum = (afterValue ?? 0) - (beforeValue ?? 0);
    const deltaCount = (afterValue !== undefined ? 1 : 0) - (beforeValue !== undefined ? 1 : 0);
    if (deltaSum === 0 && deltaCount === 0) continue;
    await changeSemanticCounter(ctx, { organizationId: args.organizationId, semanticType, category: 'total', deltaSum, deltaCount });
    await changeSemanticCounter(ctx, { organizationId: args.organizationId, semanticType, category: 'project', projectId: args.projectId, deltaSum, deltaCount });
    await changeSemanticCounter(ctx, { organizationId: args.organizationId, semanticType, category: 'eventStatus', status: args.status, deltaSum, deltaCount });
  }
}

/**
 * Resolves an event's tracked semantic values BEFORE a batch of edits is
 * applied to it — the `before` half `applyEventSemanticDelta` needs.
 * Exported for `events/model.ts updateEventFields` to call ahead of its
 * write loop, while the stored rows still reflect the pre-edit state.
 */
export async function getEventSemanticValuesBeforeEdit(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; eventId: Id<'events'> },
): Promise<{
  values: Partial<Record<TrackedSemanticType, number>>;
  trackedFields: readonly { fieldDefinitionId: Id<'fieldDefinitions'>; semanticType: TrackedSemanticType }[];
}> {
  const trackedFields = await getTrackedFieldDefinitions(ctx, args.organizationId);
  const values = await resolveTrackedSemanticValues(ctx, args.eventId, trackedFields);
  return { values, trackedFields };
}

/**
 * Moves every tracked semantic value an event carries from its previous
 * status bucket to its new one. Wired into `events/model.ts
 * changeEventStatus`, right beside the existing `eventStatus`
 * `statisticsCounters` maintenance — needed because
 * `applyEventSemanticDelta` only runs where a VALUE is written, and a pure
 * status transition (no field write at all) would otherwise leave the old
 * bucket permanently overcounted and the new one permanently undercounted.
 * Same I6 bound as `resolveTrackedSemanticValues` (O(K) targeted lookups,
 * not O(the event's field count)).
 */
export async function moveSemanticStatusBuckets(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; eventId: Id<'events'>; previousStatus: EventStatus; newStatus: EventStatus },
): Promise<void> {
  const trackedFields = await getTrackedFieldDefinitions(ctx, args.organizationId);
  const values = await resolveTrackedSemanticValues(ctx, args.eventId, trackedFields);
  for (const semanticType of trackedSemanticTypes) {
    const value = values[semanticType];
    if (value === undefined) continue;
    await changeSemanticCounter(ctx, { organizationId: args.organizationId, semanticType, category: 'eventStatus', status: args.previousStatus, deltaSum: -value, deltaCount: -1 });
    await changeSemanticCounter(ctx, { organizationId: args.organizationId, semanticType, category: 'eventStatus', status: args.newStatus, deltaSum: value, deltaCount: 1 });
  }
}


/** A finite window whose bounds (either may be omitted) are correctly ordered when both are given. */
function assertValidFilterWindow(startsAt: number | undefined, endsAt: number | undefined): void {
  if (startsAt !== undefined && !Number.isFinite(startsAt)) return invalidInput('statisticsFilterWindowInvalid', 'Statistics filter window bounds must be finite');
  if (endsAt !== undefined && !Number.isFinite(endsAt)) return invalidInput('statisticsFilterWindowInvalid', 'Statistics filter window bounds must be finite');
  if (startsAt !== undefined && endsAt !== undefined && endsAt < startsAt) return invalidInput('statisticsFilterWindowInvalid', 'Statistics filter window must be ordered');
}

/**
 * A `projectId` filter is a referenced entity (I1): this proves it belongs to
 * the caller's own organization — already proven a member of by the caller —
 * before any index built on that raw id is ever queried, and refuses a
 * foreign project exactly like a missing one (I9).
 */
async function assertFilterProjectOwnership(ctx: QueryCtx, organizationId: Id<'organizations'>, projectId: Id<'projects'> | undefined): Promise<void> {
  if (projectId === undefined) return;
  const project = await ctx.db.get(projectId);
  if (project === null || project.organizationId !== organizationId) return notFoundOrInaccessible();
}

/**
 * Bounded event scan shared by every filtered semantic/occupancy read: at
 * most `cap + 1` rows off `by_project_startsAt` (a `projectId` filter,
 * already proven above to belong to `organizationId`) or `by_org_startsAt`
 * (no `projectId` filter) — the one extra row is read specifically to detect
 * truncation without a second query (I6). Every event status is included:
 * a cancelled or completed event still carries a real historical value that
 * a passenger/accessibility total must not silently drop.
 */
async function scanEventsForFilter(
  ctx: QueryCtx,
  args: { organizationId: Id<'organizations'>; projectId: Id<'projects'> | undefined; startsAt: number | undefined; endsAt: number | undefined; cap: number; order: 'asc' | 'desc' },
): Promise<{ events: Doc<'events'>[]; isTruncated: boolean }> {
  const { organizationId, projectId, startsAt, endsAt, cap, order } = args;
  const rows =
    projectId === undefined
      ? await ctx.db
          .query('events')
          .withIndex('by_org_startsAt', (q) => {
            const eq = q.eq('organizationId', organizationId);
            if (startsAt !== undefined && endsAt !== undefined) return eq.gte('startsAt', startsAt).lte('startsAt', endsAt);
            if (startsAt !== undefined) return eq.gte('startsAt', startsAt);
            if (endsAt !== undefined) return eq.lte('startsAt', endsAt);
            return eq;
          })
          .order(order)
          .take(cap + 1)
      : await ctx.db
          .query('events')
          .withIndex('by_project_startsAt', (q) => {
            const eq = q.eq('projectId', projectId);
            if (startsAt !== undefined && endsAt !== undefined) return eq.gte('startsAt', startsAt).lte('startsAt', endsAt);
            if (startsAt !== undefined) return eq.gte('startsAt', startsAt);
            if (endsAt !== undefined) return eq.lte('startsAt', endsAt);
            return eq;
          })
          .order(order)
          .take(cap + 1);
  const isTruncated = rows.length > cap;
  return { events: isTruncated ? rows.slice(0, cap) : rows, isTruncated };
}

export type FilteredValue = { value: number; isTruncated: boolean };

/**
 * `getServiceStatusCounts` with optional `projectId`/date-range filters,
 * added rather than changed in place so the existing O(1) unfiltered query
 * (and every test already driving it) is untouched. With no filter supplied
 * it delegates straight to the counters above — the unfiltered headline path
 * stays O(1), never regressed into a scan just to unify the two code paths —
 * and every row's `isTruncated` is trivially `false` because a maintained
 * counter is always exact. With any filter supplied, each status is read as
 * its own bounded, capped range (mirroring `getUpcomingServices`'s per-status
 * shape above), so one status truncating never hides another's exact count.
 */
export async function getFilteredServiceStatusCounts(
  ctx: QueryCtx,
  args: { organizationId: Id<'organizations'>; projectId?: Id<'projects'>; startsAt?: number; endsAt?: number },
): Promise<{ status: EventStatus; count: number; isTruncated: boolean }[]> {
  const { organizationId, projectId, startsAt, endsAt } = args;
  await requireOrganizationMembership(ctx, organizationId);
  await assertFilterProjectOwnership(ctx, organizationId, projectId);
  assertValidFilterWindow(startsAt, endsAt);

  if (projectId === undefined && startsAt === undefined && endsAt === undefined) {
    const counts = await getServiceStatusCounts(ctx, organizationId);
    return counts.map((row) => ({ ...row, isTruncated: false }));
  }

  return Promise.all(
    eventStatuses.map(async (status) => {
      const rows =
        projectId === undefined
          ? await ctx.db
              .query('events')
              .withIndex('by_org_status_startsAt', (q) => {
                const eq = q.eq('organizationId', organizationId).eq('status', status);
                if (startsAt !== undefined && endsAt !== undefined) return eq.gte('startsAt', startsAt).lte('startsAt', endsAt);
                if (startsAt !== undefined) return eq.gte('startsAt', startsAt);
                if (endsAt !== undefined) return eq.lte('startsAt', endsAt);
                return eq;
              })
              .take(maxFilteredScan + 1)
          : await ctx.db
              .query('events')
              .withIndex('by_project_status_startsAt', (q) => {
                const eq = q.eq('projectId', projectId).eq('status', status);
                if (startsAt !== undefined && endsAt !== undefined) return eq.gte('startsAt', startsAt).lte('startsAt', endsAt);
                if (startsAt !== undefined) return eq.gte('startsAt', startsAt);
                if (endsAt !== undefined) return eq.lte('startsAt', endsAt);
                return eq;
              })
              .take(maxFilteredScan + 1);
      const isTruncated = rows.length > maxFilteredScan;
      return { status, count: isTruncated ? maxFilteredScan : rows.length, isTruncated };
    }),
  );
}

async function readSemanticTotalCounter(ctx: QueryCtx, organizationId: Id<'organizations'>, semanticType: TrackedSemanticType): Promise<{ sum: number; count: number }> {
  const counter = await ctx.db.query('statisticsSemanticCounters').withIndex('by_org_semantic_category', (q) => q.eq('organizationId', organizationId).eq('semanticType', semanticType).eq('category', 'total')).first();
  return { sum: counter?.sum ?? 0, count: counter?.count ?? 0 };
}

/**
 * Grand total (and the event count behind a mean) for one tracked semantic
 * type, filterable by project and/or date range. Unfiltered reads the
 * maintained `total` counter — O(1), exact, `isTruncated` always `false`.
 * Filtered abandons the counter (which cannot answer an arbitrary range) for
 * `scanEventsForFilter` capped at `maxFilteredScan`, most-recent-first —
 * the same order `getOccupancyMetrics` scans in, so a truncated sample from
 * either query describes the SAME set of services, not two different ones —
 * resolving each scanned event's value through `resolveTrackedSemanticValues`
 * with `getTrackedFieldDefinitions` resolved once, not once per event, so
 * the whole read stays within I6 independent of how many fields a recipe
 * version composes.
 */
async function getSemanticTotal(
  ctx: QueryCtx,
  semanticType: TrackedSemanticType,
  args: { organizationId: Id<'organizations'>; projectId?: Id<'projects'>; startsAt?: number; endsAt?: number },
): Promise<{ total: FilteredValue; eventCount: FilteredValue }> {
  const { organizationId, projectId, startsAt, endsAt } = args;
  await requireOrganizationMembership(ctx, organizationId);
  await assertFilterProjectOwnership(ctx, organizationId, projectId);
  assertValidFilterWindow(startsAt, endsAt);

  if (projectId === undefined && startsAt === undefined && endsAt === undefined) {
    const { sum, count } = await readSemanticTotalCounter(ctx, organizationId, semanticType);
    return { total: { value: sum, isTruncated: false }, eventCount: { value: count, isTruncated: false } };
  }

  const trackedFields = await getTrackedFieldDefinitions(ctx, organizationId);
  const { events, isTruncated } = await scanEventsForFilter(ctx, { organizationId, projectId, startsAt, endsAt, cap: maxFilteredScan, order: 'desc' });
  let sum = 0;
  let count = 0;
  for (const event of events) {
    const values = await resolveTrackedSemanticValues(ctx, event._id, trackedFields);
    const value = values[semanticType];
    if (value !== undefined) {
      sum += value;
      count += 1;
    }
  }
  return { total: { value: sum, isTruncated }, eventCount: { value: count, isTruncated } };
}

export function getPassengerTotals(
  ctx: QueryCtx,
  args: { organizationId: Id<'organizations'>; projectId?: Id<'projects'>; startsAt?: number; endsAt?: number },
): Promise<{ total: FilteredValue; eventCount: FilteredValue }> {
  return getSemanticTotal(ctx, 'passenger.count', args);
}

export function getAccessibilityRequirements(
  ctx: QueryCtx,
  args: { organizationId: Id<'organizations'>; projectId?: Id<'projects'>; startsAt?: number; endsAt?: number },
): Promise<{ total: FilteredValue; eventCount: FilteredValue }> {
  return getSemanticTotal(ctx, 'accessibility.wheelchairCount', args);
}

/** Per-project rollup of one tracked semantic type's values, unfiltered — mirrors `getProjectBreakdown` exactly, including its dangling-row defense. */
async function getSemanticByProject(
  ctx: QueryCtx,
  semanticType: TrackedSemanticType,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<{ project: Doc<'projects'>; sum: number; count: number }>> {
  await requireOrganizationMembership(ctx, organizationId);
  const counters = await ctx.db.query('statisticsSemanticCounters').withIndex('by_org_semantic_category_project', (q) => q.eq('organizationId', organizationId).eq('semanticType', semanticType).eq('category', 'project')).paginate(paginationOpts);
  const page: { project: Doc<'projects'>; sum: number; count: number }[] = [];
  for (const counter of counters.page) {
    const project = counter.projectId === undefined ? null : await ctx.db.get(counter.projectId);
    // See the identical dangling-reference note on `getProjectBreakdown` above.
    if (project === null || project.organizationId !== organizationId) continue;
    page.push({ project, sum: counter.sum, count: counter.count });
  }
  return { ...counters, page };
}

export function getPassengerTotalsByProject(ctx: QueryCtx, organizationId: Id<'organizations'>, paginationOpts: PaginationOptions) {
  return getSemanticByProject(ctx, 'passenger.count', organizationId, paginationOpts);
}
export function getAccessibilityByProject(ctx: QueryCtx, organizationId: Id<'organizations'>, paginationOpts: PaginationOptions) {
  return getSemanticByProject(ctx, 'accessibility.wheelchairCount', organizationId, paginationOpts);
}

/** Per-status rollup of one tracked semantic type's values, unfiltered — mirrors `getServiceStatusCounts` exactly. */
async function getSemanticByStatus(
  ctx: QueryCtx,
  semanticType: TrackedSemanticType,
  organizationId: Id<'organizations'>,
): Promise<{ status: EventStatus; sum: number; count: number }[]> {
  await requireOrganizationMembership(ctx, organizationId);
  return Promise.all(
    eventStatuses.map(async (status) => {
      const counter = await ctx.db.query('statisticsSemanticCounters').withIndex('by_org_semantic_category_status', (q) => q.eq('organizationId', organizationId).eq('semanticType', semanticType).eq('category', 'eventStatus').eq('status', status)).first();
      return { status, sum: counter?.sum ?? 0, count: counter?.count ?? 0 };
    }),
  );
}

export function getPassengerTotalsByStatus(ctx: QueryCtx, organizationId: Id<'organizations'>) {
  return getSemanticByStatus(ctx, 'passenger.count', organizationId);
}
export function getAccessibilityByStatus(ctx: QueryCtx, organizationId: Id<'organizations'>) {
  return getSemanticByStatus(ctx, 'accessibility.wheelchairCount', organizationId);
}

function medianOf(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? 0;
  return (lower + upper) / 2;
}

export type OccupancyMetrics = {
  sampleSize: number;
  isTruncated: boolean;
  mean: number | null;
  median: number | null;
  max: number | null;
  countAtOrAboveThreshold: number | null;
};

/**
 * Occupancy has no capacity denominator in this domain (no fleet/vehicle
 * concept — an explicit non-goal), so "occupancy" is defined here as the
 * DISTRIBUTION of `passenger.count` across services matching the filter:
 * sample size, mean, median, max, and (when `threshold` is supplied) how
 * many services carried at least that many passengers. See
 * docs/statistics.md "occupancyMetrics without a capacity denominator" for
 * the full reasoning.
 *
 * Always a bounded, capped scan — NEVER a maintained counter, filtered or
 * not — because a running counter can maintain a sum or a count but cannot
 * answer a median or a max without materializing (something bounded by) the
 * whole distribution; `mean` is the one statistic here a counter genuinely
 * could answer in O(1) (see `getPassengerTotals`), but it is computed from
 * the same bounded sample as the rest so the reported mean and median always
 * describe the identical set of services, rather than one being exact
 * (org-wide) and the others a sample when a caller reads them together.
 * Scans the `maxFilteredScan` MOST RECENT matching events (descending
 * `startsAt`) so a truncated sample favors current operations over old
 * history.
 */
export async function getOccupancyMetrics(
  ctx: QueryCtx,
  args: { organizationId: Id<'organizations'>; projectId?: Id<'projects'>; startsAt?: number; endsAt?: number; threshold?: number },
): Promise<OccupancyMetrics> {
  const { organizationId, projectId, startsAt, endsAt, threshold } = args;
  await requireOrganizationMembership(ctx, organizationId);
  await assertFilterProjectOwnership(ctx, organizationId, projectId);
  assertValidFilterWindow(startsAt, endsAt);
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0)) {
    return invalidInput('statisticsThresholdInvalid', 'Occupancy threshold must be a finite, non-negative number');
  }

  const trackedFields = await getTrackedFieldDefinitions(ctx, organizationId);
  const { events, isTruncated } = await scanEventsForFilter(ctx, { organizationId, projectId, startsAt, endsAt, cap: maxFilteredScan, order: 'desc' });
  const sample: number[] = [];
  for (const event of events) {
    const values = await resolveTrackedSemanticValues(ctx, event._id, trackedFields);
    const passengerCount = values['passenger.count'];
    if (passengerCount !== undefined) sample.push(passengerCount);
  }
  sample.sort((a, b) => a - b);

  return {
    sampleSize: sample.length,
    isTruncated,
    mean: sample.length === 0 ? null : sample.reduce((total, value) => total + value, 0) / sample.length,
    median: sample.length === 0 ? null : medianOf(sample),
    max: sample.length === 0 ? null : (sample[sample.length - 1] ?? null),
    countAtOrAboveThreshold: threshold === undefined ? null : sample.filter((value) => value >= threshold).length,
  };
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
    // Resolved once for the whole page, not once per event (I6) — see
    // `getTrackedFieldDefinitions`'s doc comment for why this is bounded by
    // configuration rather than by the page's event count.
    const trackedFields = await getTrackedFieldDefinitions(ctx, organizationId);
    for (const event of page.page) {
      await changeCounter(ctx, { organizationId, category: 'eventStatus', status: event.status, delta: 1 });
      await changeCounter(ctx, { organizationId, category: 'projectEvents', projectId: event.projectId, delta: 1 });
      await changeCounter(ctx, { organizationId, category: 'recipeEvents', recipeId: event.recipeId, delta: 1 });
      // Legacy `eventFieldValues` rows already exist (they are written by
      // event creation, independent of any counter); this rebuilds the
      // maintained semantic counters — grand total, per-project, per-status —
      // to match them, exactly as the three calls above rebuild the plain
      // event counters. One delta per semantic type per EVENT (never per
      // field row) — see `applyEventSemanticDelta`'s doc comment for why.
      const values = await resolveTrackedSemanticValues(ctx, event._id, trackedFields);
      for (const semanticType of trackedSemanticTypes) {
        const value = values[semanticType];
        if (value === undefined) continue;
        await changeSemanticCounter(ctx, { organizationId, semanticType, category: 'total', deltaSum: value, deltaCount: 1 });
        await changeSemanticCounter(ctx, { organizationId, semanticType, category: 'project', projectId: event.projectId, deltaSum: value, deltaCount: 1 });
        await changeSemanticCounter(ctx, { organizationId, semanticType, category: 'eventStatus', status: event.status, deltaSum: value, deltaCount: 1 });
      }
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
    if (rows.length > 0) {
      await recordBackfillAudit(ctx, args.organizationId, 'clear', false);
      return { continueCursor: '', isDone: false };
    }

    // Same partial-prefix pattern as `statisticsCounters` above (only
    // `organizationId` supplied, ranging over every `semanticType`/`category`
    // this org has a row for) — a second drain stage between the plain event
    // counters and the running totals below.
    const semanticRows = await ctx.db.query('statisticsSemanticCounters').withIndex('by_org_semantic_category', (q) => q.eq('organizationId', args.organizationId)).take(batchSize);
    for (const row of semanticRows) await ctx.db.delete(row._id);
    if (semanticRows.length > 0) {
      await recordBackfillAudit(ctx, args.organizationId, 'clear', false);
      return { continueCursor: '', isDone: false };
    }

    const totals = await ctx.db.query('statisticsTotals').withIndex('by_org_metric', (q) => q.eq('organizationId', args.organizationId)).take(batchSize);
    for (const total of totals) await ctx.db.delete(total._id);
    const isDone = totals.length === 0;
    await recordBackfillAudit(ctx, args.organizationId, 'clear', isDone);
    return { continueCursor: '', isDone };
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
