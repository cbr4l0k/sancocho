# Statistics aggregation

The statistics API uses maintained counter rows. Each counter is updated in the
same Convex mutation that changes the fact it represents: event status and its
project/recipe totals, project status, active recipes, and locations. Reads of
organization-wide headline totals are consequently indexed point reads, not a
scan whose cost grows with the tenant. Project and recipe breakdowns are
paginated counter rows.

This is an I6 requirement, not a seed-data optimisation. An organization can
accumulate events indefinitely, so collecting even a status-filtered slice on
every dashboard load is an unbounded read. Counter updates are in the source
mutation transaction, so Convex's serializable retry semantics preserve totals
under concurrent writers. Counters contain only tenant-owned ids and every
read begins with `requireOrganizationMembership`, satisfying I1/I9.

This correctness comes with a throughput cost worth naming: every event write
in an organization contends on the same handful of counter documents (its
status bucket, its project's row, its recipe's row), so concurrent writers to
the same organization serialize on those rows and retry under OCC conflicts.
This bounds bulk-import throughput per organization; it is not a concern for
ordinary interactive use, but a future bulk-import feature should not assume
this design scales to writing many events per organization in parallel.

`statisticsCounters.category` and `.status` are closed Convex unions, not
`v.string()`: `category` is exactly the four category keys `changeCounter`
ever writes to this table (`activeRecipe`/`location` are single running totals
kept in `statisticsTotals` instead), and `status` is `eventStatusValidator |
projectStatusValidator`, present only on the two status-keyed categories — a
`projectEvents`/`recipeEvents` row is keyed by `projectId`/`recipeId` and
carries no status at all, rather than a meaningless filler value. `changeCounter`
takes a discriminated union of arguments (one variant per category) so each
call site can only supply the key its category actually uses; this is what
lets the schema stay a real closed set instead of one column wide enough to
hold every category's key.

Every organization is born with `getActiveRecipeCount` already at 4, not 0:
`organizations.createOrganization` provisions and publishes the four starter
recipes (`recipes/builtins.ts`) in the same transaction, through the same
`publishRecipeVersion` path any other recipe publish uses, so they are counted
like any other active recipe from the moment the organization exists.

`getServiceStatusCounts` and `getProjectStatusCounts` derive the statuses they
report from an exhaustive `Record<EventStatus, null>` / `Record<ProjectStatus,
null>`, not a hand-written array. A hand-written array type-checks against any
*subset* of the union, so a future seventh `EventStatus` could leave
`changeCounter` maintaining a bucket these queries never read — a silent
under-count with a green `tsc`. The `Record` form fails compilation the moment
a new status literal is added, until this file is updated to say where it
goes — the backend counterpart to the exhaustive `Record`s `lib/status.ts`
already requires on the web console.

## "Upcoming" is a status contract, not just a time window

`getUpcomingServices` returns events whose status is `draft | planned |
confirmed | active` — a cancelled or already-completed service is never
"upcoming work," no matter where its `startsAt` falls inside the requested
window. This is a deliberate product decision (steered by the user during
review of this issue), not an implementation detail: a cancelled service
surfacing in an upcoming-work widget reads as a bug to an operator, and #35's
UI is built against this contract, not against "everything in the window."

Like the exhaustive status lists above, the included set is an exhaustive
`Record<EventStatus, boolean>` (`isUpcomingEventStatus` in `statistics/model.ts`),
so a future seventh status forces a `tsc` failure and a deliberate decision
about which bucket it joins, instead of silently vanishing from (or silently
appearing in) the widget.

The query does **not** read the window unfiltered and drop excluded statuses
afterward — that reintroduces exactly the problem this issue exists to solve:
it could silently return fewer than the caller's requested `limit` even when
enough genuinely-upcoming events exist in the window, and in the pathological
case a burst of cancelled events could crowd out every real upcoming service.
Instead, `events` carries a `by_org_status_startsAt` index (organization,
status, startsAt), and each included status is read as its own bounded range
— `.take(limit)` — then the (at most four) bounded lists are merged and
re-sliced to `limit`. This is provably sufficient: the true top-`limit` result
across every included status can never need more than `limit` rows from any
single status, because a status contributing more than that would already
exceed the total answer size. Reading one bounded range per included status
(a small, fixed constant) is a different shape from reading one row per event
in the tenant, so this stays within I6 as the organization's event count
grows.

## Write paths, resets, and dangling counter rows

`events/model.ts` updates event-status, project-event, and recipe-event
counters on creation and status change. `projects/model.ts` updates project
status counters on creation, status change, and archival. `recipes/model.ts`
updates the active-recipe counter on the draft-to-active publish transition and
on archival. `locations/model.ts` updates its total on creation and hard delete
(archival deliberately does not change the total, because the statistics
surface asks for location count, not active-location count).

`seed/reset.ts`'s development reset sweeps every table these counters mirror
(`events`, `eventRecipes`, `recipeVersions`, `locations`), so it also sweeps
`statisticsCounters`, `statisticsTotals`, and `statisticsBackfillProgress` in
the same pass. Missing this was a real bug during development: the reset
deleted the entities but left their counters standing, so statistics kept
reporting deleted data, and every subsequent reset+reseed generation added
onto the previous one's stale counts instead of starting from zero. Any table
added to the reset sweep in the future must be checked against this list.

A project/recipe breakdown counter row can, in principle, point at a project
or recipe that no longer resolves in this organization — today this is only
reachable through a reset that misses a table (as above), but the read must be
defensive against it regardless of cause. `getProjectBreakdown` /
`getRecipeBreakdown` treat that as a data-consistency question, not an
authorization one: the organization-scoping is already proven by the index
prefix the page was read from, so a row whose target does not resolve (or
resolves in a different organization) is skipped, not thrown as
`notFoundOrInaccessible` — one stale row must never take down the whole
breakdown page for every other, healthy row in the same organization. Actual
deletion of the orphan is left to whatever created it, since a Convex query
has no writable `db` to prune it with; this is a read-side defense, not a
repair mechanism.

## Backfill: an internal, idempotent migration

Existing deployments must run the one-time administrative
`statistics.mutations.backfillOrganizationCounters` for every organization,
after deploying the schema and before exposing statistics. It is deliberately
**`internalMutation`, plus `assertSeedingEnabled()`** — the same two-layer
guard as this repo's other two backfills (`seed/mutations.ts`
`backfillRecipeVersionPublishedAt` / `backfillSearchText`), whose own reasoning
is written down there: *"`internalMutation` alone does not guard against
someone running `convex run --prod`."* An earlier version of this mutation was
a plain owner-gated `mutation` — reachable over the wire, replayable by any
client, and unaudited. Owner-gating a destructive, replayable migration is not
enough on its own; matching the stronger pattern this repo already uses for
comparable operations is.

It is invoked with `convex run` by a deployment operator, not by an owner
through the console — there is no button for it. Invoke `phase: 'clear'`
until it returns `isDone`, then invoke each of `events`, `projects`,
`recipes`, and `locations`, feeding the returned cursor back until each phase
reports done. Every call processes at most `batchSize` documents (default and
hard maximum 100; the parameter exists so tests can force the multi-page
cursor path without seeding hundreds of rows), so the migration is executable
for a legacy tenant far larger than one Convex transaction can collect.

**Idempotency** is enforced with `statisticsBackfillProgress`, one row per
(organization, phase):

- A data phase must present the exact cursor that row remembers. Presenting
  anything else — including `null` when a phase is mid-flight — is refused
  with `statisticsBackfillCursorInvalid`.
- Once a phase is marked done, it refuses to run again with
  `statisticsBackfillPhaseComplete` until `clear` resets it.
- `clear` deletes every progress row for the organization (as well as every
  counter and total), so a genuinely fresh backfill is always possible
  afterward. `clear` is itself naturally idempotent — a completed clear simply
  finds nothing left to delete.

Without this, replaying `phase: 'events'` — a retried client, or an operator
re-running a stale command — would have permanently double-counted every
event, with nothing in the audit log to explain why. Every call also records
an `organization.statisticsBackfilled` audit event (attributed to the
organization's owner), so the migration leaves the same trail every other
mutation in this repo does.

## Semantic aggregation (issue #34, reopened scope)

Two new dimensions read `eventFieldValues` by `semanticType` instead of by
event/project/recipe: `passengerTotals` and `accessibilityRequirements`
(`statistics/queries.ts` `getPassengerTotals`/`getAccessibilityRequirements`
plus their `…ByProject`/`…ByStatus` breakdowns). `semanticType` lives on
`fieldDefinitions`; the values it describes live on `eventFieldValues`, keyed
by `fieldDefinitionId` — the largest table in the system. A naive
implementation joining the two on every read is exactly the I6 violation this
issue exists to prevent, so the mechanism is the same one already established
for everything else in this file: **maintained counters, updated where
`eventFieldValues` is written**, in a new `statisticsSemanticCounters` table
(`schema.ts`). This was the "obvious candidate" the reopening issue named,
and nothing in the domain argued for anything else — the existing
architecture already treats "materialize a running fact beside the mutation
that changes it" as the house style for every other statistic.

The set of tracked semantic types is computed from the registry, not
hand-matched on a field's key or label: `semanticTypesForCapability` in
`validators/index.ts` filters `semanticRegistry` for whichever type(s) declare
a given capability (`passengerTotals`, `accessibilityRequirements`) —
`passenger.count` and `accessibility.wheelchairCount` today. Notably,
`luggage.count` is numeric but its registry entry declares no capability
(`capabilities: []`), so it correctly earns no statistic here; the registry
itself, not this file, is what decided that. `statisticsSemanticCounters.semanticType`
is still a hand-written literal union (Convex schema fields must be real
literal types), so `statistics/model.ts` asserts at module load that the
hand-written `TrackedSemanticType` union exactly equals what the registry
computes — a future capability rebinding that isn't mirrored here fails
immediately and loudly (a thrown error at deploy time), not as a silently
wrong dashboard number discovered later.

**Why this is safe under I3.** A maintained counter keyed by semantic type is
only trustworthy if a field's semantic type can never change out from under
values already summed into it. This is true, and it is enforced one layer
below the counters, not assumed by them: `fields/model.ts`
`updateFieldDefinition` (around `apps/convex/convex/fields/model.ts:143-159`)
treats `semanticType` as one of three `historicalMeaningFields`, and refuses
to change any of them once `isReferencedByPublishedVersion` is true for that
field. Separately, `events/model.ts` `createEventFromRecipe` only ever
creates an `eventFieldValues` row for a field that is part of the event's own
`recipeVersionId`, and that version must already be `published`
(`apps/convex/convex/events/model.ts:94`) — so by the time any
`eventFieldValues` row can exist for a field, that field is already
referenced by a published version, and its `semanticType` is already frozen.
There is no window in which a value is summed under one semantic type and
later silently reinterpreted under another.

Three dimensions are maintained, each updated at the narrowest site that can
actually keep it correct:

- **`total`** (grand, org-wide) and **`project`** (per-project) are updated
  only where an `eventFieldValues` row is written — `createEventFromRecipe`'s
  insert loop, and `updateEventFields`'s insert/patch/delete branches (both
  in `events/model.ts`, via `applyEventSemanticDelta`). A `projectId` never
  changes for an existing event, so no other site can ever affect this
  dimension.
- **`eventStatus`** is keyed by an event's CURRENT status, which unlike
  `projectId` genuinely can change after a value is written. A pure status
  transition writes no `eventFieldValues` row at all, so
  `applyEventSemanticDelta` never runs for it; `changeEventStatus`
  additionally calls `moveSemanticStatusBuckets`, which reads the event's own
  tracked field values and moves each one from its previous status bucket to
  its new one — the same bidirectional "decrement the old bucket, increment
  the new one" shape `changeCounter` already uses for the plain event-status
  counters beside it.

**The delta is computed per EVENT, never per field row — this was a real bug
caught by review, not a hypothetical.** `count` means "this many *events*
carry a defined value for this semantic type" (the schema doc comment on
`statisticsSemanticCounters` says so explicitly), and nothing forbids two
*different* field definitions on one recipe version being bound to the same
semantic type (`addRecipeField` only rejects a duplicate `fieldDefinitionId`)
— "adult passengers" and "child passengers" both bound to `passenger.count`
is an ordinary tenant modelling choice. An earlier version of this code
called a per-field delta function once per `eventFieldValues` row written,
which double-counted exactly that event (`eventCount: 2` for one event, while
every read that aggregates by event — the filtered scan, the backfill, the
status-transition mover — reported `1` for the identical data: the filtered
and unfiltered variants of the same query disagreeing on the same tenant).

The fix, and the shape every write site now uses: `applyEventSemanticDelta`
takes a `before` snapshot of the event's AGGREGATE value per tracked semantic
type (summing every tracked field the event carries, computed by
`getEventSemanticValuesBeforeEdit` ahead of `updateEventFields`'s write loop,
or the empty aggregate for a brand-new event in `createEventFromRecipe`),
re-resolves the AFTER aggregate once every write in the batch has landed, and
applies exactly one delta per semantic type per mutation call — never one per
field. This is the identical event-level computation
`moveSemanticStatusBuckets`, the backfill, and every filtered read already
used; the fix made the live write path agree with them, not the other way
around. `apps/convex/tests/statistics.test.ts` — "an event with two different
field definitions bound to the same semantic type counts as ONE event, and
both values sum" — is a permanent regression test for this, verified against
the reintroduced bug (see the issue's mutation-testing report).

**Resolving an event's aggregate stays within I6 without depending on how
many fields the event's recipe version happens to compose.** The naive join
— collect every `eventFieldValues` row the event has (bounded by
`maxFieldsPerVersion` = 200, but 200 is still 200) and `db.get` each row's
field definition — costs up to `2 × 200` reads per event, which is fine for
one event but not for the up-to-`maxFilteredScan` (500) events a filtered
read or `occupancyMetrics` may scan: worst case, `500 × 400` = 200,000 reads,
comfortably over Convex's per-transaction read ceiling. `getTrackedFieldDefinitions`
fixes this by resolving, ONCE per top-level query (not once per event), the
small set of field definitions this organization has EVER bound to a tracked
semantic type — bounded by configuration (how many fields an admin created),
not by operational volume (how many events exist, or how many fields one
recipe version composes) — the same category of bound
`resolveOrganizationOwnerUserId`'s membership-roster collect already relies
on elsewhere in this file. Every event-level read then does exactly one
targeted, indexed point lookup (`by_event_field`, `.eq('eventId',
…).eq('fieldDefinitionId', …)`) per entry that function returns, instead of
scanning the event's entire field set — `O(scanned events × distinct tracked
fields)`, not `O(scanned events × fields per recipe version)`.

`backfillOrganizationCounters`'s `events` phase and `clear` phase were
extended to cover `statisticsSemanticCounters` the same way they already
cover `statisticsCounters` (the `events` phase resolves `trackedFields` once
per page, not once per event, for the identical reason), and
`seed/reset.ts`'s dev-reset sweep now includes the new table too (see "Write
paths, resets, and dangling counter rows" above — the exact bug that section
warns about, applied here).

## `occupancyMetrics` without a capacity denominator

Vehicle capacity is an explicit non-goal (no fleet/vehicle management
anywhere in the domain), so there is no denominator for "how full was this
service" in the literal sense. `getOccupancyMetrics` instead defines
occupancy as the **distribution of `passenger.count` across matching
services**: sample size, mean, median, max, and (given an optional
`threshold` argument) how many services carried at least that many
passengers. This is meaningful without a capacity concept — "our median
service carries 6 passengers, and 3 services this month carried 12+" is a
real operational answer — and it introduces no vehicles table or fabricated
capacity field.

This is the one statistic in this file that is **never** a maintained
counter, filtered or not. A running counter can maintain a sum and a count in
O(1) (which is exactly what `passengerTotals`'s grand total does), but it
cannot answer a median or a max without materializing something bounded by
the whole distribution — there is no incremental update rule for "the middle
value" the way there is for a sum. `getOccupancyMetrics` is therefore always
a bounded, capped scan (`scanEventsForFilter`, the same primitive the
filtered reads below use), reading the `maxFilteredScan` most recent matching
events (descending `startsAt`, so a truncated sample favors current
operations over old history) and resolving each one's `passenger.count`
value through the same targeted semantic lookup (`getTrackedFieldDefinitions`
/ `resolveTrackedSemanticValues`) the write path resolves its deltas through. `mean` is computed from that identical bounded sample rather than
from the exact O(1) counter, even though the counter could answer it exactly
— so a caller reading `mean` and `median` together always describes the same
set of services, instead of one being an exact org-wide figure and the other
a sample.

## Filtered reads and the truncation signal (issue #35 dependency)

`#35` needs date-range and project filters, and — a deliberate product
decision — **filters apply to every headline number that has a real
project/date dimension, not just to detail views.** A dashboard whose
filters do not move the big numbers misleads an operator asking "how many
services are confirmed in September for project X."

Maintained counters answer an organization-wide, all-time question in O(1)
precisely by giving up the ability to answer an arbitrary range — that
trade-off is the entire point of counters, and it cannot be patched around.
So every filtered read abandons counters for a second mechanism: a bounded,
capped scan (`scanEventsForFilter` in `statistics/model.ts`) reading at most
`maxFilteredScan` (500) rows off an index scoped to the filter — 
`by_project_startsAt` when a `projectId` filter is given (already proven to
belong to the caller's organization — see I1 below), `by_org_startsAt`
otherwise — with the date range applied as an optional `.gte`/`.lte` on the
same index. One extra row is read past the cap specifically to detect
truncation without a second query. `getFilteredServiceStatusCounts` uses the
identical shape per status, off `by_project_status_startsAt` /
`by_org_status_startsAt` (a new index added beside the existing
`by_org_status_startsAt`), mirroring `getUpcomingServices`'s already-proven
"one bounded range read per included bucket" pattern above.

Every filtered read's return shape carries the signal explicitly —
`{ value, isTruncated }` for a scalar total (`FilteredValue` in
`statistics/model.ts`), `{ status, count, isTruncated }` per bucket for the
service-status breakdown, `{ isTruncated, sampleSize, … }` for occupancy —
so the console can honestly render "500+" instead of a wrong number, which
is worse than an admittedly-incomplete one because it looks exact. Producing
a truly exact total for an arbitrary range would mean scanning the whole
range, which is the exact I6 violation this issue exists to prevent.

**The unfiltered headline path is untouched and stays O(1).** Rather than
changing the seven existing queries' signatures, the filtered
read is a new, additively-added query alongside each: calling
`getFilteredServiceStatusCounts`/`getPassengerTotals`/
`getAccessibilityRequirements` with no `projectId` and no date bounds
delegates straight to the same maintained counters `getServiceStatusCounts`/
the semantic `total` counter already answer, wrapped as `isTruncated: false`
(a maintained counter is exact by construction) — never regressed into a
scan just to unify the filtered and unfiltered code paths into one function
body. Every existing query, and every test already driving it, is unchanged.

**Which existing queries did NOT get a filter, and why.** Only queries whose
answer has a genuine project/date dimension were extended:
`getFilteredServiceStatusCounts`, `getPassengerTotals`,
`getAccessibilityRequirements`, and `getOccupancyMetrics` (all keyed off
`events`, which has both `projectId` and `startsAt`). `getActiveRecipeCount`
and `getLocationCount` were deliberately left alone: a recipe is not
associated with a project, and neither a recipe nor a location carries a
`startsAt` — a "date range" filter on "how many locations exist" has no
domain meaning to honor, and adding the parameter anyway would be a filter
that silently does nothing, which is worse than not offering it.
`getProjectStatusCounts` was left alone for the same reason on the project
axis (a `projectId` filter on "count of projects by status" is asking to
filter projects by project) and because `projects` carries no comparable
`startsAt` for a date filter either. `getProjectBreakdown`/`getRecipeBreakdown`
and `getUpcomingServices` were left exactly as they already were: the
breakdowns are already unfiltered-by-design precedent (see above), and
`getUpcomingServices` already IS a mandatory, capped date-window query with
its own status contract — extending it with an independent optional filter
system was judged out of scope for this issue rather than folded in
speculatively.

**I1 for the `projectId` filter.** A `projectId` filter argument is a
referenced entity like any other: `assertFilterProjectOwnership` loads it and
confirms `project.organizationId === organizationId` before any index built
on the raw id is ever queried, refusing a foreign project with the same
generic `notFoundOrInaccessible` a missing one gets (I9) — proven by a
dedicated test that pairs a legitimate `organizationId` with another
organization's real `projectId`.

## Known limitation: `getTrackedFieldDefinitions`'s bound assumes a small field catalogue

`getTrackedFieldDefinitions` collects EVERY field definition in the organization
plus every deployment-wide builtin, then filters to the tracked semantic
types in memory — not a targeted read of only the tracked ones. This is
bounded by configuration size (how many fields an admin has created), not by
operational volume, which is the right category of bound, but nothing in the
codebase enforces a cap on field definitions per organization
(`maxFieldsPerVersion` caps fields per RECIPE VERSION, not per org). A tenant
with an unusually large field catalogue would pay a correspondingly larger
read cost on every statistics call AND on every `createEventFromRecipe`/
`updateEventFields` write (since `applyEventSemanticDelta` calls it too) —
a single-tenant performance/availability concern, not a cross-tenant leak.
The straightforward fix — an index on `fieldDefinitions` keyed by
`(organizationId, semanticType)`, read directly for just the two tracked
types — was identified but deferred rather than rushed into this change set;
tracked as follow-up work, not shipped as "done."

## Rejected alternatives

`@convex-dev/aggregate` was rejected because this repository has a small,
closed set of aggregate dimensions and already owns every relevant mutation.
Adding a component, its configuration, and component-specific backfill would
add an external operational dependency without removing a write path. It also
does not make the project/recipe breakdown ordering or API contract simpler.

Bounded indexed queries were rejected as the sole strategy. They work for
`getUpcomingServices`, which is why that query uses one (see above), but they
cannot truthfully answer the requested organization-wide status and location
totals. A hard date range would silently change those totals into window
totals, and a per-status collect over the full tenant would violate I6 and
degrade as the tenant grows.

A per-status maintained semantic counter (mirroring `eventStatus` exactly,
including the bucket-move on transition) was considered for
`passengerTotals`/`accessibilityRequirements` and, after weighing it against
the bounded-scan alternative, built anyway — see "Semantic aggregation"
above. A pure sum-and-count semantic counter with NO status dimension (only
`total` and `project`) was the fallback design if the status-transition
bookkeeping had proven too invasive; it was not needed, since
`moveSemanticStatusBuckets` only touches the one existing status-transition
call site and reads a bound already established (`updateEventFields` reads
the identical `eventFieldValues` set for the identical reason).
