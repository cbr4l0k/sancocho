# Architecture and domain model

Companion to [`../CLAUDE.md`](../CLAUDE.md) (invariants I1–I9) and
[`architecture-review.md`](architecture-review.md) (the Stage A decisions). This document
describes what the implementation actually does. Where it diverged from the Stage A review,
[`deviations.md`](deviations.md) records why.

## Domain model

```
users ──< organizationMemberships >── organizations
                                            │
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
  once in `validators/` (`projectFields`, `eventFields`, `locationFields`,
  `fieldDefinitionFields`, `auditEventFields`) and spread into both, so the stored document
  and the documented contract cannot drift.
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

| Table | Indexes | Purpose |
| --- | --- | --- |
| `users` | `by_provider_subject` | Unique `(authProvider, authSubject)`; the identity key |
| `organizations` | `by_slug` | Unique deployment-wide slug |
| `organizationMemberships` | `by_org_user`, `by_user` | Unique `(orgId, userId)`; membership lookup and "my organizations" |
| `projects` | `by_org` | Paginated tenant project list |
| `fieldDefinitions` | `by_org_key`, `by_org` | Unique key per org; built-ins live at `organizationId: undefined` and are unique globally |
| `eventRecipes` | `by_org_key`, `by_org` | Unique recipe key per org |
| `recipeVersions` | `by_recipe_version`, `by_recipe_status` | Server-assigned version numbers; one-draft / one-published rules |
| `recipeFields` | `by_version_field`, `by_version`, `by_field`, `by_defaultLocation` | Unique field per version; ordered fetch; field-immutability trigger; location-default reference guard |
| `events` | `by_project`, `by_project_startsAt`, `by_org_startsAt`, `by_recipe`, `by_recipeVersion` | Paginated project timeline and version reference checks |
| `eventFieldValues` | `by_event_field`, `by_field`, `by_location` | Unique value per `(event, field)`; field and location reference guards |
| `locations` | `by_org` | Paginated tenant location catalogue |
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
queries. `.collect()` appears five times, and never as a public list read: one version's recipe fields
(capped at `maxFieldsPerVersion = 200`), one event's field values, one recipe's version
history, one user's memberships, and the owner count inside `requireAnotherOwner`. The
200-field cap is enforced on `addRecipeField`, which makes that bounded-set claim structural
rather than assumed. The owner count is an invariant check on one organization's roster, not a
list the client can page through — and reading the whole `by_org_user` prefix is also what
makes two concurrent owner removals conflict.

The paginated envelope is declared once (`validators/index.ts:paginatedResult`) because a
`returns` validator that omits `splitCursor` / `pageStatus` rejects legitimate pages at
runtime.

## Where to go next

- Identity and the provider boundary: [`auth.md`](auth.md)
- Who may do what, and how tenants are isolated: [`authorization.md`](authorization.md)
- Configuration immutability, the part that makes the model work: [`recipes.md`](recipes.md)
- Operational data and time: [`events.md`](events.md)
