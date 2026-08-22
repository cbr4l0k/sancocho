# Statistics aggregation

The statistics API uses maintained counter rows. Each counter is updated in the
same Convex mutation that changes the fact it represents: event status and its
project/recipe totals, project status, active recipes, and locations. Reads of
organization-wide headline totals are consequently indexed point reads, not a
scan whose cost grows with the tenant. Project and recipe breakdowns are
paginated counter rows; upcoming services use the existing
`events.by_org_startsAt` index with a server-enforced 31-day window and a 100
row cap.

This is an I6 requirement, not a seed-data optimisation. An organization can
accumulate events indefinitely, so collecting even a status-filtered slice on
every dashboard load is an unbounded read. Counter updates are in the source
mutation transaction, so Convex's serializable retry semantics preserve totals
under concurrent writers. Counters contain only tenant-owned ids and every
read begins with `requireOrganizationMembership`, satisfying I1/I9.

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

## Write paths and backfill

`events/model.ts` updates event-status, project-event, and recipe-event
counters on creation and status change. `projects/model.ts` updates project
status counters on creation, status change, and archival. `recipes/model.ts`
updates the active-recipe counter on the draft-to-active publish transition and
on archival. `locations/model.ts` updates its total on creation and hard delete
(archival deliberately does not change the total, because the statistics
surface asks for location count, not active-location count).

Existing deployments must run the one-time administrative
`statistics.mutations.backfillOrganizationCounters` mutation for every
organization, after deploying the schema and before exposing statistics. It is
deliberately owner-only. Invoke `clear` until it returns `isDone`, then invoke
each of `events`, `projects`, `recipes`, and `locations`, feeding the returned
cursor back until each phase is done. Every call processes at most 100 indexed
rows, so the migration is executable for large legacy tenants without an
unbounded collect. Run it in a maintenance window: normal writes must not race
a rebuild that deliberately resets its destination rows. Normal application
writes never depend on a client-side recomputation.

## Rejected alternatives

`@convex-dev/aggregate` was rejected because this repository has a small,
closed set of aggregate dimensions and already owns every relevant mutation.
Adding a component, its configuration, and component-specific backfill would
add an external operational dependency without removing a write path. It also
does not make the project/recipe breakdown ordering or API contract simpler.

Bounded indexed queries were rejected as the sole strategy. They work for the
upcoming-services window, which is why that query uses one, but they cannot
truthfully answer the requested organization-wide status and location totals.
A hard date range would silently change those totals into window totals, and a
per-status collect over the full tenant would violate I6 and degrade as the
tenant grows.
