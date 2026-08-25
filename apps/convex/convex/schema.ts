import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

import {
  archivalStatusValidator,
  auditEventFields,
  eventFieldValueValidator,
  eventFields,
  eventStatusValidator,
  fieldConfigValidator,
  fieldDefinitionFields,
  locationFields,
  recipeFields,
  recipeVersionStatusValidator,
  projectFields,
  projectStatusValidator,
  relationshipTypeValidator,
  roleValidator,
} from './validators';

/**
 * Uniqueness is an indexed read-before-write in one mutation. As described in
 * docs/architecture-review.md §10, Convex serializable OCC retries conflicting
 * mutations, so the retried read observes the winning write without needing locks.
 *
 * Every denormalized column (organizationId everywhere, events.recipeId,
 * eventFieldValues.locationId) is derived server-side from the stored entity
 * graph in the same mutation (I4) — never accepted from client args.
 */

export default defineSchema({
  users: defineTable({
    authProvider: v.string(),
    authSubject: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  }).index('by_provider_subject', ['authProvider', 'authSubject']),

  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
  }).index('by_slug', ['slug']),

  organizationMemberships: defineTable({
    organizationId: v.id('organizations'),
    userId: v.id('users'),
    role: roleValidator,
  })
    .index('by_org_user', ['organizationId', 'userId'])
    .index('by_user', ['userId']),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition.
  projects: defineTable(projectFields)
    .index('by_org', ['organizationId'])
    // Serves the organization-scoped project status list without filtering an
    // already-paginated result set.
    .index('by_org_status', ['organizationId', 'status']),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition.
  fieldDefinitions: defineTable(fieldDefinitionFields)
    .index('by_org_key', ['organizationId', 'key'])
    .index('by_org', ['organizationId'])
    // Serves `statistics/model.ts` `getTrackedFieldDefinitionsForType`: a
    // targeted, indexed read of exactly the (organizationId, semanticType)
    // pair a caller wants, so resolving which fields are bound to a tracked
    // semantic type costs O(the number of fields actually bound to it),
    // never O(every field definition in the organization). Without this,
    // that lookup was an unrestricted `.collect()` over the whole
    // organization's field catalogue — reachable from `createEventFromRecipe`,
    // `updateEventFields`, and `changeEventStatus` (I6: `fieldDefinitions` is
    // exactly the kind of table `listFieldDefinitions` already paginates for
    // the same reason — tenant-configured, not a bounded child set).
    .index('by_org_semantic', ['organizationId', 'semanticType'])
    // Serves key-or-label search within one organization, including the
    // deployment-wide built-in scope represented by organizationId undefined.
    .searchIndex('search_text', { searchField: 'searchText', filterFields: ['organizationId'] }),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition.
  eventRecipes: defineTable(recipeFields)
    .index('by_org_key', ['organizationId', 'key'])
    .index('by_org', ['organizationId']),

  recipeVersions: defineTable({
    organizationId: v.id('organizations'),
    recipeId: v.id('eventRecipes'),
    versionNumber: v.number(),
    status: recipeVersionStatusValidator,
    // Older published versions have no truthful publish time: leaving this
    // optional distinguishes that absence from a known publication instant.
    publishedAt: v.optional(v.number()),
  })
    .index('by_recipe_version', ['recipeId', 'versionNumber'])
    .index('by_recipe_status', ['recipeId', 'status'])
    // `listPublishedRecipes` starts from current published versions: publication
    // is the selective fact that guarantees a picker row has a usable version,
    // without an N+1 probe across every recipe in the organization.
    .index('by_org_status', ['organizationId', 'status']),

  recipeFields: defineTable({
    organizationId: v.id('organizations'),
    recipeVersionId: v.id('recipeVersions'),
    fieldDefinitionId: v.id('fieldDefinitions'),
    position: v.number(),
    required: v.boolean(),
    visible: v.boolean(),
    defaultValue: v.optional(eventFieldValueValidator),
    // Mirror of defaultValue.locationId when kind === 'location', derived
    // server-side from the value beside it and never client-supplied (I4).
    // Gives locations an indexed reference check over configuration defaults,
    // so a location a published (immutable) version defaults to can never be
    // deleted out from under it. Every write path to `defaultValue` MUST set
    // this column through `locationIdFromValue` in fields/values.ts.
    defaultLocationId: v.optional(v.id('locations')),
    // Snapshot of the field's config (data type, rules, options), taken when the
    // row is composed into a DRAFT version — so a draft may narrow the definition
    // (tighter bounds, a subset of options) for this recipe. Publishing validates
    // the snapshot's coherence instead of overwriting it: same config kind, narrowing-
    // only bounds, and select options still a subset of the definition's. From
    // publish onward the snapshot is immutable, and historical event validation
    // reads ONLY it, never the live fieldDefinition (I3).
    config: fieldConfigValidator,
  })
    .index('by_version_field', ['recipeVersionId', 'fieldDefinitionId'])
    .index('by_version', ['recipeVersionId'])
    // Supports "is this field definition referenced by any (published)
    // version?" for the immutability trigger and protected deletes.
    .index('by_field', ['fieldDefinitionId'])
    // Supports the first-hit "is this location referenced by any recipe field
    // default?" guard in locations/model.ts deleteLocation.
    .index('by_defaultLocation', ['defaultLocationId']),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition. `recipeId` is derived from
  // `recipeVersionId` server-side (I4); never client-supplied.
  events: defineTable(eventFields)
    .index('by_project', ['projectId'])
    .index('by_project_startsAt', ['projectId', 'startsAt'])
    .index('by_org_startsAt', ['organizationId', 'startsAt'])
    // Serves `statistics.getUpcomingServices`: a status-restricted, bounded
    // window read must never fall back to reading every event in the window
    // and filtering client-side (that reintroduces the exact I6 problem the
    // query exists to avoid), so status is indexed alongside org and start
    // time and each included status is queried as its own bounded range.
    .index('by_org_status_startsAt', ['organizationId', 'status', 'startsAt'])
    // Mirrors `by_org_status_startsAt` for the project-scoped filter case:
    // `statistics.getFilteredServiceStatusCounts` needs the identical bounded,
    // per-status range-read shape when the caller supplies a `projectId`
    // filter, and a project is already proven to belong to the caller's
    // organization before this index is ever queried, so no organizationId
    // column is needed in the key (see statistics/model.ts).
    .index('by_project_status_startsAt', ['projectId', 'status', 'startsAt'])
    .index('by_recipe', ['recipeId'])
    .index('by_recipeVersion', ['recipeVersionId']),

  // Materialized statistics are updated by their source mutations. These
  // indexes make dashboard totals point reads and breakdowns paginated reads.
  statisticsCounters: defineTable({
    organizationId: v.id('organizations'),
    // Closed set matching statistics/model.ts's `ChangeCounterArgs` discriminated
    // union exactly: `activeRecipe` and `location` never reach this table (they
    // are single running totals, kept in `statisticsTotals` below).
    category: v.union(
      v.literal('eventStatus'),
      v.literal('projectStatus'),
      v.literal('projectEvents'),
      v.literal('recipeEvents'),
    ),
    // Present only for the two status-keyed categories; a `projectEvents` or
    // `recipeEvents` row is keyed by `projectId`/`recipeId` instead, so it
    // carries no status at all rather than a meaningless filler value.
    status: v.optional(v.union(eventStatusValidator, projectStatusValidator)),
    projectId: v.optional(v.id('projects')),
    recipeId: v.optional(v.id('eventRecipes')),
    count: v.number(),
  })
    .index('by_org_category_status', ['organizationId', 'category', 'status'])
    .index('by_org_category', ['organizationId', 'category'])
    .index('by_org_category_project', ['organizationId', 'category', 'projectId'])
    .index('by_org_category_recipe', ['organizationId', 'category', 'recipeId']),

  statisticsTotals: defineTable({
    organizationId: v.id('organizations'),
    metric: v.union(v.literal('activeRecipe'), v.literal('location')),
    count: v.number(),
  }).index('by_org_metric', ['organizationId', 'metric']),

  // Maintained running sums of the numeric values carried by semantic types,
  // updated wherever `eventFieldValues` is written (statistics/model.ts
  // `applyEventSemanticDelta`) rather than by scanning that table, which
  // is the largest in the system (I6; see docs/statistics.md "Semantic
  // aggregation"). The tracked semantic types are the closed set this
  // literal union names, matching `statistics/model.ts`'s hand-written
  // `TrackedSemanticType` — kept in sync with the registry's capability
  // bindings by a COMPILE-TIME check there (`AssertHasCapability`), the
  // same convention `statisticsCounters.category` already uses against
  // `ChangeCounterArgs`.
  //
  // `category` is a discriminated union like `statisticsCounters.category`:
  // `total` is the single org-wide running sum (no key column); `eventStatus`
  // is keyed by the CURRENT status of the events contributing to it, moved
  // between buckets on every status transition (see `moveSemanticStatusBuckets`
  // in statistics/model.ts, called from events/model.ts `changeEventStatus`)
  // because status is mutable, unlike a field value's
  // project; `project` is keyed by `projectId`, which never changes for an
  // existing event, so it only ever needs updating at the value-write sites.
  statisticsSemanticCounters: defineTable({
    organizationId: v.id('organizations'),
    semanticType: v.union(v.literal('passenger.count'), v.literal('accessibility.wheelchairCount')),
    category: v.union(v.literal('total'), v.literal('eventStatus'), v.literal('project')),
    status: v.optional(eventStatusValidator),
    projectId: v.optional(v.id('projects')),
    // Running sum of the numeric values contributing to this bucket.
    sum: v.number(),
    // Number of events currently carrying a defined value in this bucket —
    // the denominator for a mean; distinct from an event count elsewhere
    // because a recipe's fields are optional and an event may carry no value
    // for a given semantic type at all.
    count: v.number(),
  })
    // One index per category, each keyed only as deep as that category's
    // own key column — mirroring `statisticsCounters`, which likewise never
    // queries `by_org_category_status` for a category that carries no status.
    // `total` has no key column of its own beyond `category`, so it is looked
    // up on the shared `organizationId`+`semanticType`+`category` prefix.
    .index('by_org_semantic_category', ['organizationId', 'semanticType', 'category'])
    .index('by_org_semantic_category_status', ['organizationId', 'semanticType', 'category', 'status'])
    .index('by_org_semantic_category_project', ['organizationId', 'semanticType', 'category', 'projectId']),

  // One row per (organization, phase) tracking exactly how far
  // `statistics.backfillOrganizationCounters` has progressed. Its sole job is
  // making the migration idempotent: a call must present the cursor this row
  // remembers, and a phase already marked done refuses to run again until
  // `clear` resets it — so replaying `phase: 'events'` (accidentally or from
  // a retried client) cannot double-count, and a completed phase cannot be
  // silently re-applied on top of itself.
  statisticsBackfillProgress: defineTable({
    organizationId: v.id('organizations'),
    phase: v.union(v.literal('events'), v.literal('projects'), v.literal('recipes'), v.literal('locations')),
    cursor: v.union(v.string(), v.null()),
    done: v.boolean(),
  }).index('by_org_phase', ['organizationId', 'phase']),

  eventFieldValues: defineTable({
    organizationId: v.id('organizations'),
    eventId: v.id('events'),
    recipeFieldId: v.id('recipeFields'),
    fieldDefinitionId: v.id('fieldDefinitions'),
    value: eventFieldValueValidator,
    // Mirror of value.locationId when kind === 'location' (server-derived);
    // gives locations an indexed reference check before archival/deletion.
    // Every write path to `value` MUST set this column through
    // `locationIdFromValue` in fields/values.ts — see its doc comment. Issue
    // #10 owns the first (and so far only) writer of this table.
    locationId: v.optional(v.id('locations')),
  })
    .index('by_event_field', ['eventId', 'fieldDefinitionId'])
    .index('by_field', ['fieldDefinitionId'])
    .index('by_location', ['locationId']),

  locations: defineTable(locationFields)
    // Serves the unchanged unfiltered organization catalogue list.
    .index('by_org', ['organizationId'])
    // Serves the unsearched organization-and-type catalogue list when status
    // is absent; type cannot be a prefix of the status-first index below.
    .index('by_org_type', ['organizationId', 'type'])
    // Serves unsearched organization-and-status lists, with an optional type
    // equality on the same index; neither case needs a post-index filter.
    .index('by_org_status_type', ['organizationId', 'status', 'type'])
    // Serves name search scoped to a tenant and optionally narrowed by the
    // code-owned type and archival status filters.
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['organizationId', 'type', 'status'],
    }),

  eventRelationships: defineTable({
    organizationId: v.id('organizations'),
    sourceEventId: v.id('events'),
    targetEventId: v.id('events'),
    type: relationshipTypeValidator,
  })
    .index('by_source_target_type', ['sourceEventId', 'targetEventId', 'type'])
    .index('by_target', ['targetEventId']),

  // Audit is append-only: domain mutations write rows transactionally through
  // audit/model.ts; no public audit mutation can update or delete them.
  auditEvents: defineTable(auditEventFields)
    .index('by_org', ['organizationId'])
    .index('by_org_entity', ['organizationId', 'entityType', 'entityId']),
});
