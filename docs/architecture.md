# Architecture and domain model

Companion to [`../CLAUDE.md`](../CLAUDE.md) (invariants I1–I11) and
[`architecture-review.md`](architecture-review.md) (the Stage A decisions). This document
describes what the implementation actually does. Where it diverged from the Stage A review,
[`deviations.md`](deviations.md) records why.

## Rename glossary

Issue #82 changed names only; each entry below names the same concept before and after that
change. This is the repository's single old-to-new glossary.

| Area | Old | Current |
| --- | --- | --- |
| Tables | `events` | `services` |
| Tables | `eventFieldValues` | `serviceFieldValues` |
| Tables | `eventRelationships` | `serviceRelationships` |
| Tables | `eventRecipes` | `serviceKinds` |
| Tables | `recipeVersions` | `serviceKindVersions` |
| Tables | `recipeFields` | `serviceKindFields` |
| Columns | `events.recipeId` | `services.serviceKindId` |
| Columns | `events.recipeVersionId` | `services.serviceKindVersionId` |
| Columns | `eventFieldValues.eventId` | `serviceFieldValues.serviceId` |
| Columns | `eventFieldValues.recipeFieldId` | `serviceFieldValues.serviceKindFieldId` |
| Columns | `eventRelationships.sourceEventId` | `serviceRelationships.sourceServiceId` |
| Columns | `eventRelationships.targetEventId` | `serviceRelationships.targetServiceId` |
| Validators | `eventStatusValidator` | `serviceStatusValidator` |
| Validators | `eventFields` | `serviceFields` |
| Validators | `eventDocValidator` | `serviceDocValidator` |
| Validators | `eventFieldValueValidator` | `serviceFieldValueValidator` |
| Validators | `recipeStatusValidator` | `serviceKindStatusValidator` |
| Validators | `recipeVersionStatusValidator` | `serviceKindVersionStatusValidator` |
| Validators | `recipeDocValidator` | `serviceKindDocValidator` |
| Validators | `recipeFields` table-shape export | `serviceKindFields` table-shape export |
| Semantic types and capabilities | `eventName` | `serviceName` |
| Semantic types and capabilities | `eventDescription` | `serviceDescription` |
| Semantic types and capabilities | `eventDate` | `serviceDate` |
| Semantic types and capabilities | `eventTime` | `serviceTime` |
| Semantic types and capabilities | `eventLocation` | `serviceLocation` |
| Error codes | `recipeKeyInvalid` | `serviceKindKeyInvalid` |
| Error codes | `recipeDescriptionTooLong` | `serviceKindDescriptionTooLong` |
| Error codes | `recipeArchived` | `serviceKindArchived` |
| Error codes | `recipePublishedVersionRequired` | `serviceKindPublishedVersionRequired` |
| Error codes | `recipeVersionNotDraft` | `serviceKindVersionNotDraft` |
| Error codes | `recipeVersionEmpty` | `serviceKindVersionEmpty` |
| Error codes | `recipeFieldRequiredHidden` | `serviceKindFieldRequiredHidden` |
| Error codes | `recipeFieldConfigMismatch` | `serviceKindFieldConfigMismatch` |
| Error codes | `recipeFieldConfigNotNarrower` | `serviceKindFieldConfigNotNarrower` |
| Error codes | `recipeFieldSnapshotOptionInvalid` | `serviceKindFieldSnapshotOptionInvalid` |
| Error codes | `recipeFieldDuplicateDefinition` | `serviceKindFieldDuplicateDefinition` |
| Error codes | `recipeFieldDefinitionUnavailable` | `serviceKindFieldDefinitionUnavailable` |
| Error codes | `recipeFieldLimitExceeded` | `serviceKindFieldLimitExceeded` |
| Error codes | `recipeFieldOrderInvalid` | `serviceKindFieldOrderInvalid` |
| Error codes | `recipeFieldPositionInvalid` | `serviceKindFieldPositionInvalid` |
| Error codes | `eventRecipeUnavailable` | `serviceKindUnavailable` |
| Error codes | `eventFieldUnknown` | `serviceFieldUnknown` |
| Error codes | `eventFieldDuplicate` | `serviceFieldDuplicate` |
| Error codes | `eventFieldRequired` | `serviceFieldRequired` |
| Error codes | `eventStartInvalid` | `serviceStartInvalid` |
| Error codes | `eventEndInvalid` | `serviceEndInvalid` |
| Error codes | `eventDateRangeInvalid` | `serviceDateRangeInvalid` |
| Error codes | `eventBeforeProjectWindow` | `serviceBeforeProjectWindow` |
| Error codes | `eventAfterProjectWindow` | `serviceAfterProjectWindow` |
| Error codes | `eventProjectReadOnly` | `serviceProjectReadOnly` |
| Error codes | `eventProjectUnavailable` | `serviceProjectUnavailable` |
| Error codes | `eventReadOnly` | `serviceReadOnly` |
| Error codes | `eventTerminal` | `serviceTerminal` |
| Error codes | `eventStatusTransitionInvalid` | `serviceStatusTransitionInvalid` |
| Seed error codes | `seedRecipeMissing` | `seedServiceKindMissing` |
| Seed error codes | `seedRecipeVersionMissing` | `seedServiceKindVersionMissing` |
| Seed error codes | `seedRecipeConflict` | `seedServiceKindConflict` |
| Audit actions | `event.*` | `service.*` |
| Audit actions | `recipe.*` | `serviceKind.*` |
| Audit actions | `recipeVersion.*` | `serviceKindVersion.*` |
| Audit actions | `recipeField.*` | `serviceKindField.*` |
| Audit entity types | `event` | `service` |
| Audit entity types | `eventRecipe` | `serviceKind` |
| Audit entity types | `recipeVersion` | `serviceKindVersion` |
| Audit entity types | `recipeField` | `serviceKindField` |
| Audit entity types | `eventRelationship` | `serviceRelationship` |
| Indexes | `by_event_field` | `by_service_field` |
| Indexes | `by_recipe` | `by_serviceKind` |
| Indexes | `by_recipeVersion` | `by_serviceKindVersion` |
| Indexes | `by_recipe_status` | `by_serviceKind_status` |
| Indexes | `by_recipe_version` | `by_serviceKind_version` |
| Backend modules and generated API | `events`, `api.events.*` | `services`, `api.services.*` |
| Backend modules and generated API | `recipes`, `api.recipes.*` | `serviceKinds`, `api.serviceKinds.*` |
| Console namespace and route | `recipes`, `/settings/recipes` | `serviceKinds`, `/settings/service-kinds` |
| Console helper files | `recipe-draft-checks` | `service-kind-draft-checks` |
| Console helper files | `recipe-field-default` | `service-kind-field-default` |
| Console helper files | `recipe-field-narrowing` | `service-kind-field-narrowing` |
| Domain documentation | `events.md` | `services.md` |
| Domain documentation | `recipes.md` | `service-kinds.md` |

## Domain model

```
users ──< organizationMemberships >── organizations ──< organizationInvitations
                                            │            (email-addressed, pending
                                            │             until the recipient accepts)
      ┌─────────────────────┬───────────────┴────────┬──────────────┐
      │                     │                        │              │
  projects            fieldDefinitions          serviceKinds     locations
      │                     │                        │              │
      │                     │                  serviceKindVersions       │
      │                     │                        │              │
      │                     └──< serviceKindFields >──────┘              │
      │                              │  │                           │
      │                              │  └── defaultLocationId ──────┤
      │                              │                              │
      └──────< services >──────────────┘                              │
                │  └── serviceKindVersionId (permanent)                  │
                │                                                   │
                ├──< serviceFieldValues >── locationId ────────────────┘
                │
                └──< serviceRelationships >

auditEvents — append-only, organization-scoped, written in the same transaction as the
              operation it records

```

Read `A ──< B` as "B references A". `serviceKindFields` references both a `serviceKindVersion` and a
`fieldDefinition` and snapshots the latter's config; `services` reference a `project` and a
`serviceKindVersion`; `serviceFieldValues` reference an `service` and the `serviceKindField` that governs
them.

Three ideas carry most of the weight:

1. **Field Definition** — a reusable, semantically typed unit of information
   (`passengerCount`, `pickupLocation`). It carries a `key`, an optional `semanticType`
   from a code-owned registry, and a `config` discriminated union that binds its data type
   to its validation rules and options in one value.
2. **Service Kind / Service Kind Version / Service Kind Fields** — configuration. A Service Kind has an
   ordered version history; at most one `draft` and at most one `published` version at a
   time. A Service Kind Field composes a Field Definition into one version with a position, a
   required flag, a visibility flag, an optional default, and a **snapshot** of the field's
   config.
3. **Service / Service Field Values** — operational data. A Service stores `serviceKindVersionId`
   permanently and one typed value row per field. Values are validated against the service kind
   field's snapshot, never against the live Field Definition.

The consequence that everything else protects: editing a Field Definition, retiring a
version, or publishing a new one can never change what a historical Service means (I3).

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
  once in `validators/` — seven of them: `projectFields`, `serviceFields`, `locationFields`,
  `fieldDefinitionFields`, `auditEventFields`, `serviceKindFields` (the `serviceKinds` shape,
  not the `serviceKindFields` table) and `organizationInvitationValidator` — and reused by both,
  so the stored document and the documented contract cannot drift.
- Cross-domain reuse goes through exported model helpers, not through duplicated logic. The
  load-bearing shared ones are `fields/values.ts:validateFieldValueAgainstConfig` (used by
  both service kind defaults and service values), `locations/model.ts:assertUsableLocation`,
  `serviceKinds/model.ts:assertSnapshotCoherentWithDefinition`, and
  `services/model.ts:assertServiceWritable` (used by relationships too).

## Tables and indexes

Every tenant-scoped table carries a denormalized `organizationId`, always derived
server-side from the stored entity graph in the same mutation, never accepted from client
arguments (I4). It is an index cache, not the authority: authorization walks the stored
graph (service → project, version → service kind, relationship → source service) and rejects any row
whose denormalized column disagrees.

Fourteen tables. Every index below is transcribed from `schema.ts`; if this table and the
schema disagree, the schema is right and this document is a bug.

| Table | Indexes | Purpose |
| --- | --- | --- |
| `users` | `by_provider_subject` | Unique `(authProvider, authSubject)`; the identity key |
| `organizations` | `by_slug` | Unique deployment-wide slug |
| `organizationMemberships` | `by_org_user`, `by_user` | Unique `(orgId, userId)`; membership lookup and "my organizations" |
| `organizationInvitations` | `by_org_email_status`, `by_org_status`, `by_email_status` | One pending invitation per `(orgId, normalized email)`; the tenant's pending list; the recipient's own "invitations addressed to me" read, which is keyed by email and never by user id |
| `projects` | `by_org`, `by_org_status` | Paginated tenant project list; status-filtered tenant project list |
| `fieldDefinitions` | `by_org_key`, `by_org`, `by_org_semantic`, `search_text` | Unique key per org; paginated tenant field-definition list (built-ins live at `organizationId: undefined` and are unique globally); the definitions bound to one semantic type, which is how a capability is resolved without ever matching a field key; normalized key-and-label search |
| `serviceKinds` | `by_org_key`, `by_org` | Unique service kind key per org |
| `serviceKindVersions` | `by_serviceKind_version`, `by_serviceKind_status`, `by_org_status` | Server-assigned version numbers; one-draft / one-published rules; the org-wide active-service kind count |
| `serviceKindFields` | `by_version_field`, `by_version`, `by_field`, `by_defaultLocation` | Unique field per version; ordered fetch; field-immutability trigger; location-default reference guard |
| `services` | `by_project`, `by_project_startsAt`, `by_org_startsAt`, `by_org_status_startsAt`, `by_project_status_startsAt`, `by_serviceKind`, `by_serviceKindVersion` | Paginated project timeline; status-filtered org-wide and project-wide timelines, ordered by start so a filtered list stays an index range rather than a scan; service kind and version reference checks |
| `serviceFieldValues` | `by_service_field`, `by_field`, `by_location` | Unique value per `(service, field)`; field and location reference guards |
| `locations` | `by_org`, `by_org_type`, `by_org_status_type`, `search_text` | Paginated tenant location catalogue; type-filtered catalogue; active locations filtered by type for pickers; normalized location-name search |
| `serviceRelationships` | `by_source_target_type`, `by_target` | Unique `(source, target, type)`; the two directional lists |
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
| Server-assigned version numbers (I7) | `by_serviceKind_version` descending `.first()` + 1, in the creating transaction. No client argument exists for a version number |
| One draft per service kind | `by_serviceKind_status` point read on `(serviceKindId, 'draft')` before insert |
| One published version per service kind | `retireCurrentPublishedVersion` reads `(serviceKindId, 'published')` and patches it to `retired` in the publishing transaction |
| Final-owner protection | Owner count read over the `by_org_user` org prefix in the demoting/removing mutation; the full-prefix read is also what makes two concurrent owner removals conflict |
| Location reference guards | First-hit reads on `serviceFieldValues.by_location` and `serviceKindFields.by_defaultLocation` before delete |

Pagination (I6): every unbounded tenant list is a `paginationOptsValidator` argument plus
`.paginate()` on an indexed query — projects, field definitions, built-in field definitions,
service kinds, locations, members, project services, both relationship directions, and both audit
queries.

`.collect()` appears at **nine** call sites outside `seed/`, and never as a public list
read. Every one is a bounded child set, and each carries its bound in a comment at the call
site:

| Site | What it reads | What bounds it |
| --- | --- | --- |
| `serviceKinds/model.ts` | One service kind's version history | A service kind's versions, created one publish at a time |
| `serviceKinds/model.ts` | One version's service kind fields | `maxFieldsPerVersion = 200`, enforced on `addServiceKindField` |
| `services/model.ts` ×3 | One service's field values | `maxFieldsPerVersion`, since a value can only exist for a composed field |
| `organizations/model.ts` | One user's memberships | The organizations one person belongs to |
| `organizations/model.ts` | The owner count inside `requireAnotherOwner` | One organization's roster |

None of these is an I6 violation; the 200-field cap is enforced at write time, which makes
that bounded-set claim structural rather than assumed. The owner count is an invariant
check on one organization's roster, not a list the client can page through — and reading
the whole `by_org_user` prefix is also what makes two concurrent owner removals conflict.

One site is worth watching rather than fixing: `decorateServices` collects a service's values
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
- Configuration immutability, the part that makes the model work: [`service-kinds.md`](service-kinds.md)
- Operational data and time: [`services.md`](services.md)
