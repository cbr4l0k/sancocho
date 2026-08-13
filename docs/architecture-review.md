# Architecture Review (Stage A)

Implementation-affecting decisions for the sancocho backend foundation. Invariants
I1–I9 and domain conventions live in `CLAUDE.md`; issue scopes live in GitHub issues
#2–#16. This document settles *how* those are realized and records any adjustments
forced by current Convex/Clerk APIs. Later stages cite this file rather than
re-deciding.

## 1. Tooling & test conventions

- **bun workspaces** monorepo (`apps/*`, `packages/*`). No npm anywhere.
- **TypeScript strict** everywhere (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`); no `any`, no unsafe assertions.
- **Tests run under vitest, not `bun test`.** `convex-test` requires vitest with the
  `edge-runtime` environment (`@edge-runtime/vm`) to simulate the Convex runtime;
  bun's native test runner cannot provide that environment. bun remains the package
  manager and script runner (`bun run test` → `vitest run`).
- Standard script set in `apps/convex`: `codegen` (`convex codegen`), `typecheck`
  (`tsc --noEmit`), `test` (`vitest run`). The post-change loop is
  `codegen → typecheck → test`.
- convex-test caveat (from official docs): the mock doesn't enforce size/time limits
  and differs from the real runtime in search semantics and error messages. Tests
  assert on *our* thrown error types/messages, not Convex internals, and invariant
  tests never depend on limit enforcement.

## 2. Current-API verification & forced adjustments

Verified against official docs (Aug 2026):

- **Validators**: current API is the object form `{ args, returns, handler }` with
  `v.*` validators, including `v.record`, `v.union`, `v.literal`, `v.optional`, and
  `Infer<>` for extracting TS types. Object validators are strict (extra properties
  rejected) — this works in our favor for I5/I8. Every public function declares
  `args` and `returns`.
- **Pagination**: `paginationOptsValidator` (from `convex/server`) + `.paginate()`
  on an indexed query is the supported pattern for all unbounded tenant lists (I6).
  Pages may shrink/grow under reactivity; irrelevant to backend correctness.
- **Transactions/OCC**: every Convex mutation is a serializable ACID transaction;
  conflicting concurrent mutations are retried (optimistic concurrency control).
  This is the foundation of the read-before-write uniqueness strategy (§10).
- **Clerk**: backend config is `convex/auth.config.ts` with
  `{ domain: process.env.CLERK_JWT_ISSUER_DOMAIN, applicationID: "convex" }`.
  Identity reaches functions only via `ctx.auth.getUserIdentity()`.
  *Adjustment 1*: Clerk excludes the factor-verification-age (`fva`) claim from the
  Convex identity; if step-up auth is ever needed it must use Clerk reverification
  on the frontend — the backend cannot see factor age. Out of scope now; recorded so
  nobody designs a permission around it.
  *Adjustment 2*: we deliberately do **not** use Clerk webhooks for user
  provisioning. Users are provisioned on-demand by an `ensureUser` mutation on first
  authenticated call (idempotent via the `authProvider+authSubject` index). Webhooks
  would push Clerk-specific payloads into domain code and break the self-hosted
  story; on-demand provisioning keeps everything behind the adapter.

## 3. Repository structure

```
package.json                    # bun workspaces root
apps/convex/
  package.json
  tsconfig.json
  convex/
    schema.ts                   # all tables + indexes (single source of truth)
    auth.config.ts              # Clerk issuer config (only Clerk-aware file besides adapter)
    lib/
      authAdapter.ts            # getUserIdentity → neutral { provider, subject, name?, email? }
      access.ts                 # requireIdentity → user → membership → permission → ownership
      roles.ts                  # role order + permission map (single place for role logic)
      errors.ts                 # notFoundOrInaccessible() and domain error helpers (I9)
    validators/                 # shared Convex validators: roles, statuses, dataTypes,
                                # temporal formats, validation-rule shapes, field-value union
    auth/                       # ensureUser, current-user queries
    organizations/  projects/  fields/  recipes/  events/
    locations/  relationships/  audit/  seed/  internal/
    # each domain dir: queries.ts, mutations.ts, model.ts (domain logic, not exported as API)
  tests/                        # vitest + convex-test, one file per domain concern
apps/web/                       # placeholder only
packages/shared/                # provider-neutral types shared with future frontend
```

Public handlers in `queries.ts`/`mutations.ts` stay thin; authorization + business
invariants live in each domain's `model.ts` and in `lib/`. `model.ts` functions take
`ctx` and typed arguments — they are plain functions, not registered Convex
functions, so they are reusable and unit-testable through the public surface.

## 4. Schema & index strategy

Tables (issue #3 names): `users`, `organizations`, `organizationMemberships`,
`projects`, `fieldDefinitions`, `eventRecipes`, `recipeVersions`, `recipeFields`,
`events`, `eventFieldValues`, `locations`, `eventRelationships`, `auditEvents`.

Decisions:

- **Denormalized `organizationId` on every tenant-scoped table**, written
  server-side from the parent entity in the same mutation (I4) — never accepted from
  the client. This gives every tenant list an indexed access path and makes
  ownership checks one indexed read instead of a join walk. The stored entity graph
  (e.g. event → recipeVersion → recipe) remains the authority; the denormalized
  field is an optimization that must agree with it, and creation code derives it,
  never copies it from args.
- Index naming: `by_<field>[_<field>...]`, fields in index order.

| Table | Indexes (→ uniqueness constraint where applicable) |
|---|---|
| users | `by_provider_subject` (unique) |
| organizations | `by_slug` (unique) |
| organizationMemberships | `by_org_user` (unique), `by_user` |
| projects | `by_org` |
| fieldDefinitions | `by_org_key` (unique per org; built-ins indexed with `organizationId: undefined`), `by_org` |
| eventRecipes | `by_org_key` (unique), `by_org` |
| recipeVersions | `by_recipe_version` (unique), `by_recipe_status` (one draft / one published) |
| recipeFields | `by_version_field` (unique), `by_version` (ordered fetch) |
| events | `by_project`, `by_project_startsAt`, `by_recipeVersion` (reference checks) |
| eventFieldValues | `by_event_field` (unique), `by_field` (reference checks) |
| locations | `by_org` |
| eventRelationships | `by_source_target_type` (unique), `by_target` |
| auditEvents | `by_org` (creation-time ordered) |

Built-in field definitions store no `organizationId`; the "custom keys must not
shadow built-in keys" rule is two indexed lookups (org key + built-in key) in the
creating mutation.

## 5. Tenant ownership & permission model

Every public function runs the same chain (I1), implemented once in
`lib/access.ts`:

```
identity (adapter) → users row → organizationMemberships row for target org
  → role ≥ required role for the operation → ownership of every referenced entity
```

- Ownership of a referenced entity = load it, compare its (derived) `organizationId`
  to the proven membership's org. Any failure — missing entity, wrong org, no
  membership — throws the same generic "not found or inaccessible" error (I9).
- Roles `owner > admin > planner > operator > viewer` are an ordered list in
  `lib/roles.ts`; operations declare a minimum role via a permission map. No role
  string comparisons outside that module.
- Final-owner protection: demote/remove of an `owner` first counts remaining owners
  via `by_org_user`-adjacent indexed read inside the same mutation; the last owner
  is never removable.

## 6. Auth adapter

`lib/authAdapter.ts` is the only domain-visible identity source:
`ctx.auth.getUserIdentity()` → `{ provider, subject, email?, name? }` (provider
parsed from the token issuer). Only `auth.config.ts` and the adapter know Clerk
exists; swapping providers for self-hosted deployments touches nothing else. The
Convex DB — not Clerk — owns orgs, memberships, roles, and all authorization
decisions. Clerk organization/role claims, if present, are ignored.

## 7. Field definitions & semantic registry

- **Semantic registry is code, not data**: a frozen TS map in `validators/`
  (`semanticType → { expectedDataType, capabilities }`). Tenants can never write
  capabilities; unrecognized semantic types grant nothing (I8). Adding a semantic
  type is a code change — deliberate.
- Data types: `text, longText, number, boolean, date, datetime, time, select,
  multiSelect, location`. **No `reference` data type** and no validator shape that
  could smuggle one in.
- **Historical immutability trigger = first reference by a published recipe
  version.** Enforced at mutation time: updating `key`/`dataType`/`semanticType`/
  capability-relevant config checks (indexed, via `recipeFields.by_field` on the
  definition + version status) whether any published version references the field;
  if so, only `label`/`description` edits pass. Cheap check, no scan.
- **Select options are snapshotted into the recipe field config at publish time**
  (issue #7's option-semantics decision): the published `recipeFields` row carries
  an immutable copy of allowed options, so later edits to the field definition's
  options can never change what a historical event validates against (I3). The
  field definition's own option list is only the source for *future* drafts.

## 8. Recipe & version lifecycle

- `eventRecipes`: `draft|active|archived`. `recipeVersions`: `draft|published|retired`,
  at most one draft **and at most one published** per recipe (`by_recipe_status`
  read-before-write).
- Version numbers are server-assigned in the publishing/creating transaction:
  highest existing via `by_recipe_version` descending + 1 (I7). Clients never send
  version numbers; the validator simply has no such argument.
- Publishing (single mutation): authorize → verify draft state → validate the full
  field configuration (field definitions exist and belong to the org, semantics
  compatible, no duplicate fields, ordering valid, defaults/rules type-match,
  select options snapshotted) → set previous published version `retired` → set
  draft `published` → write audit event. All-or-nothing under the mutation's
  transaction.
- Published/retired versions are immutable (I2): mutations that touch
  `recipeVersions`/`recipeFields` first check `status === "draft"`; there is no
  status-editing mutation — status only changes through lifecycle operations.
- New events may only reference the currently published version; existing events
  keep their `recipeVersionId` forever and validate against it even after
  retirement (I3).

## 9. Events & typed field values

- `events` holds universal properties only: project, recipeVersion (+ derived
  recipe/org), name, status (`draft|planned|confirmed|active|completed|cancelled`),
  canonical `startsAt` (absolute ms timestamp — never redefined by recipe datetime
  fields), optional `endsAt >= startsAt`.
- `eventFieldValues`: one row per event+field (`by_event_field` unique), carrying
  `eventId`, `recipeFieldId`, `fieldDefinitionId`, and a **discriminated-union
  value validator** — one branch per data type
  (`{ kind: "number", value: v.number() }`, `{ kind: "date", value: YYYY-MM-DD
  string }`, `{ kind: "location", locationId: v.id("locations") }`, …). Impossible
  states are unrepresentable; there is no string/JSON fallback branch (I8). The
  union lives in `validators/` and is shared by schema, mutation args, and tests.
  A separate table (vs. embedding in the event doc) is chosen because the
  uniqueness constraint, per-field reference checks, and field-level updates all
  want indexed rows; one event's values are a bounded set, so fetching them with
  `.collect()` via `by_event_field` is fine (I6 exemption).
- Validation is centralized in `events/model.ts`:
  `validateEventAgainstRecipe(version, fields, values)` used by both
  `createEventFromRecipe` and `updateEventFields` — the latter loads the event's
  *original* version, draft/retired or not (I3). Discriminator must match the field
  definition's data type; rules come from the recipe field's snapshotted config;
  location values must resolve to a location in the same org.

## 10. Uniqueness & concurrency

All uniqueness = **indexed read-before-write inside one mutation**. Safety
argument (documented once here, cited from code): Convex mutations are serializable
transactions with OCC — if two mutations concurrently read the same index range and
both try to insert, the conflict is detected and one retries, re-running its index
read and then failing the uniqueness check. Therefore point-reads on the unique
index before insert are race-free without locks. The same argument covers
server-assigned version numbers, the one-draft/one-published rules, and
final-owner counting. No full-table scans for uniqueness, ever.

## 11. Temporal semantics

As specified in `CLAUDE.md`, enforced by shared validators in `validators/`:
`datetime` = absolute ms timestamp (`v.number()`), `date` = `YYYY-MM-DD` string
validated by pattern *and* calendar validity, `time` = strict `HH:mm` (00–23 /
00–59). `date`/`time` are never converted to timestamps — they are wall-clock
facts. Only `startsAt`/`endsAt` (and audit timestamps) are absolute instants.

## 12. Locations

Org-owned reference data: `name`, optional address text, optional coordinates
validated to `lat ∈ [-90, 90]`, `lng ∈ [-180, 180]`. Location field values hold a
`locationId` **reference** (semantics per issue #11): events see the current
location record. Consequently locations are archivable but never hard-deletable
while referenced (checked via `eventFieldValues.by_field`-style indexed lookup).
No geocoding/normalization (non-goal).

## 13. Deletion, archival & audit

- Prefer archival/cancellation everywhere. Hard delete is allowed only for
  never-referenced leaf data (e.g. an unreferenced custom field definition, a draft
  version never published), and every destructive op verifies references via
  indexes first.
- `auditEvents` rows are written in the same mutation as the domain operation
  (transactional — no audit without the op, no op without the audit). Shape:
  org, actor user, action, entity type + id, and a small structured metadata object
  validated by a validator that cannot carry secrets/tokens/claims. Audit is a log,
  not event sourcing: state is never rebuilt from it. Reads are org-scoped,
  role-gated, paginated.

## 14. Implementation order

Issue order #2 → #3 → #4 → #5 → #6 → #7 → #8 → #9 → #11 → #10 completes the Stage B
vertical slice (sign-in → user → org → project → fields → recipe → publish →
typed event → retrieval), then #12/#13 (Stage C), #14 (D), #15/#16 (E). Each issue
ends with codegen → typecheck → test, an `invariant-auditor` pass on the diff, and
a closing summary comment.
