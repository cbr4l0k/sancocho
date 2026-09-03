# Architecture and domain model

Companion to [`../CLAUDE.md`](../CLAUDE.md) (invariants I1–I11) and
[`architecture-review.md`](architecture-review.md) (the Stage A decisions). This document
describes what the implementation actually does. Where it diverged from the Stage A review,
[`deviations.md`](deviations.md) records why.

## Domain model

```
users ──< organizationMemberships >── organizations ──< organizationInvitations
                                            │            (email-addressed, pending
                                            │             until the recipient accepts)
      ┌─────────────────────┬───────────────┴────────┬──────────────┐
      │                     │                        │              │
  projects            fieldDefinitions          eventRecipes     locations
      │                     │                        │              │
      │                     │                  recipeVersions       │
      │                     │                        │              │
      │                     └──< recipeFields >──────┘              │
      │                              │  │                           │
      │                              │  └── defaultLocationId ──────┤
      │                              │                              │
      └──────< events >──────────────┘                              │
                │  └── recipeVersionId (permanent)                  │
                │                                                   │
                ├──< eventFieldValues >── locationId ────────────────┘
                │
                └──< eventRelationships >

auditEvents — append-only, organization-scoped, written in the same transaction as the
              operation it records

statisticsCounters, statisticsTotals, statisticsSemanticCounters
            — organization-scoped maintained counters. Not a source of truth and not
              referenced by anything: each row is incremented in the same mutation that
              changes the fact it represents, so a headline total is an indexed point
              read instead of a scan that grows with the tenant (I6). See
              [`statistics.md`](statistics.md)
statisticsBackfillProgress
            — one row per (organization, phase); the cursor that makes rebuilding those
              counters resumable and idempotent
```

Read `A ──< B` as "B references A". `recipeFields` references both a `recipeVersion` and a
`fieldDefinition` and snapshots the latter's config; `events` reference a `project` and a
`recipeVersion`; `eventFieldValues` reference an `event` and the `recipeField` that governs
them.

Three ideas carry most of the weight:

1. **Field Definition** — a reusable, semantically typed unit of information
   (`passengerCount`, `pickupLocation`). It carries a `key`, an optional `semanticType`
   from a code-owned registry, and a `config` discriminated union that binds its data type
   to its validation rules and options in one value.
2. **Event Recipe / Recipe Version / Recipe Fields** — configuration. A Recipe has an
   ordered version history; at most one `draft` and at most one `published` version at a
   time. A Recipe Field composes a Field Definition into one version with a position, a
   required flag, a visibility flag, an optional default, and a **snapshot** of the field's
   config.
3. **Event / Event Field Values** — operational data. An Event stores `recipeVersionId`
   permanently and one typed value row per field. Values are validated against the recipe
   field's snapshot, never against the live Field Definition.

The consequence that everything else protects: editing a Field Definition, retiring a
version, or publishing a new one can never change what a historical Event means (I3).

## Module layering

```
queries.ts / mutations.ts   registered Convex functions; args + returns validators; no policy
        ↓
model.ts                    authorization, invariants, business logic; plain ctx-taking functions
        ↓
lib/                        access chain, role ranks, generic errors, name validation
validators/                 shared validators, config/value unions, semantic registry, audit vocabulary
```

Rules that hold everywhere:

- Every registered public function declares both `args` and `returns` validators (I5).
  Convex object validators are strict, so unexpected properties are rejected at the boundary.
- Table shapes that appear in both the schema and a public `returns` validator are declared
  once in `validators/` — seven of them: `projectFields`, `eventFields`, `locationFields`,
  `fieldDefinitionFields`, `auditEventFields`, `recipeFields` (the `eventRecipes` shape,
  not the `recipeFields` table) and `organizationInvitationFields` — and spread into both,
  so the stored document and the documented contract cannot drift.
- Cross-domain reuse goes through exported model helpers, not through duplicated logic. The
  load-bearing shared ones are `fields/values.ts:validateFieldValueAgainstConfig` (used by
  both recipe defaults and event values), `locations/model.ts:assertUsableLocation`,
  `recipes/model.ts:assertSnapshotCoherentWithDefinition`, and
  `events/model.ts:assertEventWritable` (used by relationships too).

## Tables and indexes

Every tenant-scoped table carries a denormalized `organizationId`, always derived
server-side from the stored entity graph in the same mutation, never accepted from client
arguments (I4). It is an index cache, not the authority: authorization walks the stored
graph (event → project, version → recipe, relationship → source event) and rejects any row
whose denormalized column disagrees.

Eighteen tables. Every index below is transcribed from `schema.ts`; if this table and the
schema disagree, the schema is right and this document is a bug.

| Table | Indexes | Purpose |
| --- | --- | --- |
| `users` | `by_provider_subject` | Unique `(authProvider, authSubject)`; the identity key |
| `organizations` | `by_slug` | Unique deployment-wide slug |
| `organizationMemberships` | `by_org_user`, `by_user` | Unique `(orgId, userId)`; membership lookup and "my organizations" |
| `organizationInvitations` | `by_org_email_status`, `by_org_status`, `by_email_status` | One pending invitation per `(orgId, normalized email)`; the tenant's pending list; the recipient's own "invitations addressed to me" read, which is keyed by email and never by user id |
| `projects` | `by_org`, `by_org_status` | Paginated tenant project list; status-filtered tenant project list |
| `fieldDefinitions` | `by_org_key`, `by_org`, `by_org_semantic`, `search_text` | Unique key per org; paginated tenant field-definition list (built-ins live at `organizationId: undefined` and are unique globally); the definitions bound to one semantic type, which is how statistics resolve a capability without ever matching a field key; normalized key-and-label search |
| `eventRecipes` | `by_org_key`, `by_org` | Unique recipe key per org |
| `recipeVersions` | `by_recipe_version`, `by_recipe_status`, `by_org_status` | Server-assigned version numbers; one-draft / one-published rules; the org-wide active-recipe count |
| `recipeFields` | `by_version_field`, `by_version`, `by_field`, `by_defaultLocation` | Unique field per version; ordered fetch; field-immutability trigger; location-default reference guard |
| `events` | `by_project`, `by_project_startsAt`, `by_org_startsAt`, `by_org_status_startsAt`, `by_project_status_startsAt`, `by_recipe`, `by_recipeVersion` | Paginated project timeline; status-filtered org-wide and project-wide timelines, ordered by start so a filtered list stays an index range rather than a scan; recipe and version reference checks |
| `statisticsCounters` | `by_org_category_status`, `by_org_category`, `by_org_category_project`, `by_org_category_recipe` | One index per counter category, each keyed only as deep as that category's own key column: status buckets, the category prefix, per-project totals, per-recipe totals |
| `statisticsTotals` | `by_org_metric` | The two single running totals per org (`activeRecipe`, `location`) |
| `statisticsSemanticCounters` | `by_org_semantic_category`, `by_org_semantic_category_status`, `by_org_semantic_category_project` | Running sums and denominators for the tracked semantic types, keyed the same way — org-wide total, current-status bucket, per-project bucket |
| `statisticsBackfillProgress` | `by_org_phase` | One row per `(org, phase)`; the cursor and done flag that make the counter backfill resumable and non-double-counting |
| `eventFieldValues` | `by_event_field`, `by_field`, `by_location` | Unique value per `(event, field)`; field and location reference guards |
| `locations` | `by_org`, `by_org_type`, `by_org_status_type`, `search_text` | Paginated tenant location catalogue; type-filtered catalogue; active locations filtered by type for pickers; normalized location-name search |
| `eventRelationships` | `by_source_target_type`, `by_target` | Unique `(source, target, type)`; the two directional lists |
| `auditEvents` | `by_org`, `by_org_entity` | Org-scoped and entity-scoped audit reads, newest first |

## Uniqueness and concurrency

Every uniqueness constraint is an **indexed read-before-write inside one mutation**. There
are no full-table scans for uniqueness and no lock table.

The safety argument, stated once: Convex mutations are serializable ACID transactions with
optimistic concurrency control. If two mutations read the same index range and both try to
insert, the conflict is detected and one is retried; the retry re-runs its index read, sees
the winner's row, and fails its own uniqueness check. Point reads on the unique index before
insert are therefore race-free without locks.

The same argument covers the derived rules that are not simple uniqueness:

| Rule | Implementation |
| --- | --- |
| Server-assigned version numbers (I7) | `by_recipe_version` descending `.first()` + 1, in the creating transaction. No client argument exists for a version number |
| One draft per recipe | `by_recipe_status` point read on `(recipeId, 'draft')` before insert |
| One published version per recipe | `retireCurrentPublishedVersion` reads `(recipeId, 'published')` and patches it to `retired` in the publishing transaction |
| Final-owner protection | Owner count read over the `by_org_user` org prefix in the demoting/removing mutation; the full-prefix read is also what makes two concurrent owner removals conflict |
| Location reference guards | First-hit reads on `eventFieldValues.by_location` and `recipeFields.by_defaultLocation` before delete |

Pagination (I6): every unbounded tenant list is a `paginationOptsValidator` argument plus
`.paginate()` on an indexed query — projects, field definitions, built-in field definitions,
recipes, locations, members, project events, both relationship directions, and both audit
queries.

`.collect()` appears at **nine** call sites outside `seed/`, and never as a public list
read. Every one is a bounded child set, and each carries its bound in a comment at the call
site:

| Site | What it reads | What bounds it |
| --- | --- | --- |
| `recipes/model.ts` | One recipe's version history | A recipe's versions, created one publish at a time |
| `recipes/model.ts` | One version's recipe fields | `maxFieldsPerVersion = 200`, enforced on `addRecipeField` |
| `events/model.ts` ×3 | One event's field values | `maxFieldsPerVersion`, since a value can only exist for a composed field |
| `organizations/model.ts` | One user's memberships | The organizations one person belongs to |
| `organizations/model.ts` | The owner count inside `requireAnotherOwner` | One organization's roster |
| `statistics/model.ts` | One organization's roster, to resolve its owner | The same roster |
| `statistics/model.ts` | One organization's backfill-progress rows | Exactly 4 by construction, one per phase |

None of these is an I6 violation; the 200-field cap is enforced at write time, which makes
that bounded-set claim structural rather than assumed. The owner count is an invariant
check on one organization's roster, not a list the client can page through — and reading
the whole `by_org_user` prefix is also what makes two concurrent owner removals conflict.

One site is worth watching rather than fixing: `decorateEvents` collects an event's values
**per row of an already-paginated page**, so its cost is `page size × maxFieldsPerVersion`
rather than a constant. Still bounded, still not growing with the tenant, but it is the
only one whose bound is a product of two numbers.

The paginated envelope is declared once (`validators/index.ts:paginatedResult`) because a
`returns` validator that omits `splitCursor` / `pageStatus` rejects legitimate pages at
runtime.

## Where to go next

- Identity and the provider boundary: [`auth.md`](auth.md)
- Who may do what, and how tenants are isolated: [`authorization.md`](authorization.md)
- The second principal arm, decided but not built: [`provider-access.md`](provider-access.md)
- Configuration immutability, the part that makes the model work: [`recipes.md`](recipes.md)
- Operational data and time: [`events.md`](events.md)
