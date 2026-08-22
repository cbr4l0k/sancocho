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
