# Transition analysis — ground truth before the Company → Project → Event → Service → Assignment → Provider reshape


> **Historical snapshot — superseded.** This records the repository as it stood at
> `79e52bb`, before the Event-layer reshape. It is kept as the evidence trail behind the
> triage in #91, not as current documentation. Its schema transcription, access-chain
> description and vocabulary are all pre-rename and will read as wrong after #82 — that is
> expected. The doc-vs-code discrepancies it lists were fixed by #81; the statistics
> subsystem it describes was deleted by #93. **#82's grep gate excludes this file for
> exactly that reason.** For current state read `docs/architecture.md`.

**Status:** Phase 1 output. Read-only analysis. No code was modified to produce it.
**Date:** 2026-09-03. **Commit:** `79e52bb` (branch `main`, clean tree).

Every claim below cites `file:line`. Anything not directly readable from the repository is
marked **(inference)**.

---

## 1. `apps/convex/convex/schema.ts` — every table, field and index

The schema declares **18 tables** (`schema.ts:32-310`). Several build their column set from
shared shapes in `apps/convex/convex/validators/index.ts`; those are expanded inline below,
with the validator line cited.

### 1.1 `users` — `schema.ts:33-38`

| Column | Validator |
| --- | --- |
| `authProvider` | `v.string()` |
| `authSubject` | `v.string()` |
| `email` | `v.optional(v.string())` |
| `name` | `v.optional(v.string())` |

Index: `by_provider_subject` `['authProvider','authSubject']` (`schema.ts:38`).

### 1.2 `organizations` — `schema.ts:40-43`

| Column | Validator |
| --- | --- |
| `name` | `v.string()` |
| `slug` | `v.string()` |

Index: `by_slug` `['slug']` (`schema.ts:43`).

### 1.3 `organizationMemberships` — `schema.ts:45-51`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `userId` | `v.id('users')` |
| `role` | `roleValidator` = `owner \| admin \| planner \| operator \| viewer` (`validators/index.ts:21-27`) |

Indexes: `by_org_user` `['organizationId','userId']` (`schema.ts:50`), `by_user` `['userId']`
(`schema.ts:51`).

### 1.4 `organizationInvitations` — `schema.ts:57-67`, shape at `validators/index.ts:173-182`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `email` | `v.string()` (normalized: trimmed, lowercased) |
| `role` | `roleValidator` |
| `status` | `invitationStatusValidator` = `pending \| accepted \| revoked \| expired` (`validators/index.ts:56-61`) |
| `invitedByUserId` | `v.id('users')` |
| `expiresAt` | `v.number()` |

Indexes: `by_org_email_status` `['organizationId','email','status']` (`schema.ts:62`),
`by_org_status` `['organizationId','status']` (`schema.ts:64`), `by_email_status`
`['email','status']` (`schema.ts:67`).

### 1.5 `projects` — `schema.ts:71-75`, shape at `validators/index.ts:104-112`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `name` | `v.string()` |
| `description` | `v.optional(v.string())` |
| `status` | `projectStatusValidator` = `draft \| active \| completed \| archived` (`validators/index.ts:80-85`) |
| `startsAt` | `v.optional(v.number())` |
| `endsAt` | `v.optional(v.number())` |

Indexes: `by_org` `['organizationId']` (`schema.ts:72`), `by_org_status`
`['organizationId','status']` (`schema.ts:75`).

### 1.6 `fieldDefinitions` — `schema.ts:79-95`, shape at `validators/index.ts:641-656`

| Column | Validator |
| --- | --- |
| `scope` | `fieldScopeValidator` = `builtin \| organization` (`validators/index.ts:219`) |
| `organizationId` | `v.optional(v.id('organizations'))` — absent ⇔ `scope: 'builtin'` |
| `key` | `v.string()` |
| `label` | `v.string()` |
| `searchText` | `v.optional(v.string())` — server-derived from key+label (I4) |
| `description` | `v.optional(v.string())` |
| `status` | `archivalStatusValidator` = `active \| archived` (`validators/index.ts:79, 86`) |
| `semanticType` | `v.optional(semanticTypeValidator)` — 14 literals (`validators/index.ts:607-622`) |
| `config` | `fieldConfigValidator` (`validators/index.ts:284-301`) |

Indexes: `by_org_key` `['organizationId','key']` (`schema.ts:80`), `by_org`
`['organizationId']` (`schema.ts:81`), `by_org_semantic`
`['organizationId','semanticType']` (`schema.ts:92`), and search index `search_text` on
`searchText` filtered by `organizationId` (`schema.ts:95`).

### 1.7 `eventRecipes` — `schema.ts:99-101`, shape at `validators/index.ts:129-135`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `key` | `v.string()` |
| `name` | `v.string()` |
| `description` | `v.optional(v.string())` |
| `status` | `recipeStatusValidator` = `draft \| active \| archived` (`validators/index.ts:29-33`) |

Indexes: `by_org_key` `['organizationId','key']` (`schema.ts:100`), `by_org`
`['organizationId']` (`schema.ts:101`).

### 1.8 `recipeVersions` — `schema.ts:103-117`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `recipeId` | `v.id('eventRecipes')` |
| `versionNumber` | `v.number()` — server-assigned (I7) |
| `status` | `recipeVersionStatusValidator` = `draft \| published \| retired` (`validators/index.ts:63-67`) |
| `publishedAt` | `v.optional(v.number())` |

Indexes: `by_recipe_version` `['recipeId','versionNumber']` (`schema.ts:112`),
`by_recipe_status` `['recipeId','status']` (`schema.ts:113`), `by_org_status`
`['organizationId','status']` (`schema.ts:117`).

### 1.9 `recipeFields` — `schema.ts:119-150`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `recipeVersionId` | `v.id('recipeVersions')` |
| `fieldDefinitionId` | `v.id('fieldDefinitions')` |
| `position` | `v.number()` |
| `required` | `v.boolean()` |
| `visible` | `v.boolean()` |
| `defaultValue` | `v.optional(eventFieldValueValidator)` (`validators/index.ts:316-327`) |
| `defaultLocationId` | `v.optional(v.id('locations'))` — server-derived mirror of `defaultValue.locationId` |
| `config` | `fieldConfigValidator` — the immutable snapshot historical validation reads (I3) |

Indexes: `by_version_field` `['recipeVersionId','fieldDefinitionId']` (`schema.ts:143`),
`by_version` `['recipeVersionId']` (`schema.ts:144`), `by_field` `['fieldDefinitionId']`
(`schema.ts:147`), `by_defaultLocation` `['defaultLocationId']` (`schema.ts:150`).

### 1.10 `events` — `schema.ts:155-173`, shape at `validators/index.ts:201-210`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` — derived (I4) |
| `projectId` | `v.id('projects')` |
| `recipeId` | `v.id('eventRecipes')` — derived from `recipeVersionId` (I4) |
| `recipeVersionId` | `v.id('recipeVersions')` |
| `name` | `v.string()` |
| `status` | `eventStatusValidator` = `draft \| planned \| confirmed \| active \| completed \| cancelled` (`validators/index.ts:69-76`) |
| `startsAt` | `v.number()` — always a complete absolute instant |
| `endsAt` | `v.optional(v.number())` |

Indexes (7): `by_project` (`:156`), `by_project_startsAt` (`:157`), `by_org_startsAt`
(`:158`), `by_org_status_startsAt` `['organizationId','status','startsAt']` (`:164`),
`by_project_status_startsAt` `['projectId','status','startsAt']` (`:171`), `by_recipe`
(`:172`), `by_recipeVersion` (`:173`).

### 1.11 `statisticsCounters` — `schema.ts:177-199`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `category` | `eventStatus \| projectStatus \| projectEvents \| recipeEvents` |
| `status` | `v.optional(v.union(eventStatusValidator, projectStatusValidator))` |
| `projectId` | `v.optional(v.id('projects'))` |
| `recipeId` | `v.optional(v.id('eventRecipes'))` |
| `count` | `v.number()` |

Indexes: `by_org_category_status` (`:196`), `by_org_category` (`:197`),
`by_org_category_project` (`:198`), `by_org_category_recipe` (`:199`).

### 1.12 `statisticsTotals` — `schema.ts:201-205`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `metric` | `activeRecipe \| location` |
| `count` | `v.number()` |

Index: `by_org_metric` `['organizationId','metric']` (`schema.ts:205`).

### 1.13 `statisticsSemanticCounters` — `schema.ts:226-247`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `semanticType` | `passenger.count \| accessibility.wheelchairCount` |
| `category` | `total \| eventStatus \| project` |
| `status` | `v.optional(eventStatusValidator)` |
| `projectId` | `v.optional(v.id('projects'))` |
| `sum` | `v.number()` |
| `count` | `v.number()` |

Indexes: `by_org_semantic_category` (`:245`), `by_org_semantic_category_status` (`:246`),
`by_org_semantic_category_project` (`:247`).

### 1.14 `statisticsBackfillProgress` — `schema.ts:256-261`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `phase` | `events \| projects \| recipes \| locations` |
| `cursor` | `v.union(v.string(), v.null())` |
| `done` | `v.boolean()` |

Index: `by_org_phase` `['organizationId','phase']` (`schema.ts:261`).

### 1.15 `eventFieldValues` — `schema.ts:263-278`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `eventId` | `v.id('events')` |
| `recipeFieldId` | `v.id('recipeFields')` |
| `fieldDefinitionId` | `v.id('fieldDefinitions')` |
| `value` | `eventFieldValueValidator` |
| `locationId` | `v.optional(v.id('locations'))` — server-derived mirror |

Indexes: `by_event_field` `['eventId','fieldDefinitionId']` (`:276`), `by_field`
`['fieldDefinitionId']` (`:277`), `by_location` `['locationId']` (`:278`).

### 1.16 `locations` — `schema.ts:280-294`, shape at `validators/index.ts:144-155`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `name` | `v.string()` |
| `searchText` | `v.optional(v.string())` — server-derived |
| `type` | `locationTypeValidator` = `airport \| hotel \| venue \| office \| station \| depot \| custom` (`validators/index.ts:89-98`) |
| `address` | `v.optional(v.string())` |
| `latitude` | `v.optional(v.number())` |
| `longitude` | `v.optional(v.number())` |
| `status` | `archivalStatusValidator` |

Indexes: `by_org` (`:282`), `by_org_type` (`:285`), `by_org_status_type` (`:288`), search
index `search_text` filtered by `organizationId`, `type`, `status` (`:291-294`).

### 1.17 `eventRelationships` — `schema.ts:296-303`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `sourceEventId` | `v.id('events')` |
| `targetEventId` | `v.id('events')` |
| `type` | `relationshipTypeValidator` = `dependsOn \| follows \| parentOf \| relatedTo` (`validators/index.ts:222-227`) |

Indexes: `by_source_target_type` (`:302`), `by_target` (`:303`).

### 1.18 `auditEvents` — `schema.ts:307-309`, shape at `validators/index.ts:474-481`

| Column | Validator |
| --- | --- |
| `organizationId` | `v.id('organizations')` |
| `actorUserId` | `v.id('users')` |
| `action` | `auditActionValidator` (`validators/index.ts:330-388`) |
| `entityType` | `auditEntityTypeValidator` — 11 literals (`validators/index.ts:389-401`) |
| `entityId` | `v.string()` |
| `metadata` | `auditMetadataValidator` — flat scalar record, keys restricted at runtime to the 18 in `auditMetadataKeys` (`validators/index.ts:409-429`) |

Indexes: `by_org` (`:308`), `by_org_entity` `['organizationId','entityType','entityId']`
(`:309`).

### 1.19 Supporting closed unions worth naming for the reshape

- `fieldDataTypeValidator` — 10 literals: `text, longText, number, boolean, date, datetime,
  time, select, multiSelect, location` (`validators/index.ts:229-240`).
- `fieldConfigValidator` — one discriminated object per data type, binding type + rules +
  options in one value (`validators/index.ts:284-301`).
- `eventFieldValueValidator` — one branch per data type (`validators/index.ts:316-327`).
- `semanticRegistry` — 14 code-owned semantic types with capability bindings
  (`validators/index.ts:554-586`); `maxTrackedFieldDefinitions = 25` (`:551`).
- `errorCodes` — 96 stable codes (`lib/errors.ts:4-100`).

---

## 2. Doc-vs-code discrepancies

### 2.1 `docs/architecture.md`

| # | Discrepancy | Evidence |
| --- | --- | --- |
| D1 | The table/index map lists **13 tables**; the schema has **18**. Missing: `organizationInvitations`, `statisticsCounters`, `statisticsTotals`, `statisticsSemanticCounters`, `statisticsBackfillProgress` | `docs/architecture.md:90-104` vs `schema.ts:32-310` |
| D2 | The domain-model diagram omits invitations and the whole statistics subsystem | `docs/architecture.md:10-32` |
| D3 | `events` row lists 5 indexes; the table has 7 — `by_org_status_startsAt` and `by_project_status_startsAt` are undocumented | `docs/architecture.md:100` vs `schema.ts:164,171` |
| D4 | `fieldDefinitions` row omits `by_org_semantic` | `docs/architecture.md:96` vs `schema.ts:92` |
| D5 | `recipeVersions` row omits `by_org_status` | `docs/architecture.md:98` vs `schema.ts:117` |
| D6 | "`.collect()` appears five times" and then enumerates those five. There are now **9** outside `seed/` | `docs/architecture.md:130-136` vs `recipes/model.ts:137,239`; `events/model.ts:320,456,653`; `organizations/model.ts:117,278`; `statistics/model.ts:849,953` |
| D7 | The "declared once in `validators/`" list names 5 shapes; there are 7 (`recipeFields`/`eventRecipes` and `organizationInvitationFields` are also shared) | `docs/architecture.md:73-75` vs `validators/index.ts:129,173` |

On D6 — I read all 9 sites. **None is an I6 violation.** Each is a bounded child set with an
inline justification: one version's recipe fields (capped at `maxFieldsPerVersion`), one
recipe's version history, one event's field values (×3 sites), one user's memberships, one
org's membership roster (×2), and the 4-row backfill-progress set. The *count* is stale, not
the *rule*. **(inference)** One site deserves a second look during the reshape:
`events/model.ts:653` runs a bounded `.collect()` **per row of an already-paginated page**, so
its cost is `page size × maxFieldsPerVersion`, not a constant.

### 2.2 `docs/deviations.md`

No contradiction found between `deviations.md` and the code. Its six "Known gaps"
(`deviations.md:116-152`) all still hold as written:

1. `addMember` still public, still no consent step (`organizations/model.ts`), with
   `invitations/` as the real user path — matches the code.
2. Field archival irreversible; no unarchive mutation exists.
3. Archiving a location degrades published versions — asserted by `events.test.ts`.
4. `updateOrganization` writes `metadata: { name }` with no diffing.
5. `recipeFields.defaultLocationId` has no backfill.
6. An invitation's role is authorized once at creation, never re-checked at acceptance.

The one thing `deviations.md` does **not** cover is the console: it is a backend-only
document, and Stage F–J console decisions are recorded in `docs/web-design.md` and
`docs/web-chat.md` instead. Not a contradiction, but the "every deliberate deviation"
framing in `README.md:205` overstates its scope.

### 2.3 `CLAUDE.md`

| # | Discrepancy | Evidence |
| --- | --- | --- |
| D8 | The stage ladder stops at `stage:J`. GitHub has **`stage:K` and `stage:L`** labels in active use on 15 open issues | `CLAUDE.md:143-147` vs issues #63–#78 |
| D9 | Invariant list stops at I9. Issue #78 declares **I10 — "Agreed money is immutable"** as a new invariant, and it is not in `CLAUDE.md` | `CLAUDE.md:53-79` vs issue #78 |

---

## 3. Is `apps/web/` a placeholder? — **No. The README is stale; `CLAUDE.md` is correct.**

`README.md:7` ("There is no frontend in this phase") and `README.md:45`
("`apps/web/` | Placeholder package, no UI") are **both false as of `79e52bb`**.

Inventory of `apps/web/` (excluding `node_modules`, `.next`, `.clerk`):

- **26 route files** under `app/`, including `app/[locale]/(application)/` pages for
  `projects`, `projects/[id]`, `services`, `services/new`, `services/[id]`, `chat`,
  `statistics`, `settings/{fields,recipes,locations}` with detail and draft sub-routes, plus
  `sign-in` / `sign-up` Clerk catch-alls and a `/api/health` route.
- **50 components** under `components/`, in domain folders `application/`, `chat/`,
  `fields/`, `locations/`, `organizations/`, `projects/`, `recipes/`, `services/`,
  `settings/`, `statistics/`, plus **14 vendored shadcn primitives** in `components/ui/`
  (`bento`, `button`, `chart`, `data-table`, `empty-state`, `field`, `message`,
  `message-scroller`, `page-header`, `panel`, `skeleton`, `status-chip`, `table`).
- **Full i18n**: `i18n/` with `es-CO` and `en-US` catalogues, a typed message schema, locale
  href helpers, and a `scripts/check-i18n.ts` gate wired into `bun run lint`.
- **41 files under `lib/`**, of which **22 are colocated `*.test.ts` suites**.
- Real dependency set: Next 16, React 19, Tailwind 4, `@base-ui/react`, `@clerk/nextjs`,
  `next-intl`, `@tanstack/react-table`, `recharts` (`apps/web/package.json`).
- A `Dockerfile`, `proxy.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `components.json`.

Stages F, G and H are marked complete in epic #19 and the files back that up. Only the
**chat** surface is stubbed — and stubbed by design: `apps/web/lib/chat-backend.ts:1-40`
declares provisional proposal types with a comment saying #33 owns the canonical ones, and
there is **no `chat` domain in `apps/convex/convex/`** at all. Chat today is client-side UI
plus a stub responder; nothing about it touches the database.

**Verdict:** `CLAUDE.md:89-127` is true. `README.md` describes the repository as it was
before Stage F and has not been updated since.

---

## 4. "priamo" vs "sancocho" — **both are current, in different registers**

- The **git remote is `sancocho`**: `https://github.com/cbr4l0k/sancocho.git`.
- The **npm workspace names are `priamo`**: root `package.json` `"name": "priamo"`, plus
  `@priamo/convex`, `@priamo/web`, `@priamo/shared`.
- The **import path used everywhere in the console is `@priamo/convex/api`**
  (`CLAUDE.md:100`).
- The **deployment env var is `PRIAMO_ENABLE_SEED`** (`README.md:133`, `lib/seedGuard.ts`).
- The **demo org slug is `priamo-demo`** (`README.md:160`), deployment-wide unique and with
  no `deleteOrganization` to reclaim it.
- Epic #19's first line says "Frontend phase for **sancocho**", while epic #78 and every
  other issue say "Priamo".
- `README.md:60` tells a new contributor to
  `git clone https://github.com/cbr4l0k/priamo.git` — **that URL is wrong** and is the one
  place where the split is an actual bug rather than a naming layer.

**Verdict:** "sancocho" is the repository/host name; "priamo" is the product and package
namespace. They are not in conflict except at `README.md:60`. **(inference)** Renaming the
package namespace would be a wide, low-value change — it touches every import in the console,
the seed guard env var, and the demo slug. Recommend keeping `priamo` as the product name and
fixing only the clone URL.

---

## 5. Verification commands — real results

Run from the repo root on `79e52bb`, clean tree.

```
$ bun run typecheck
$ bun run --cwd apps/convex typecheck   → tsc --noEmit   ✓
$ bun run --cwd packages/shared typecheck → tsc --noEmit ✓
$ bun run --cwd apps/web typecheck      → tsc --noEmit   ✓
EXIT=0
```

```
$ bun run test
apps/convex (vitest 4.1.10):  Test Files 19 passed (19)
                              Tests     225 passed (225)
                              Duration  33.85s
apps/web (bun test 1.3.14):   139 pass, 0 fail, 279 expect() calls
                              22 files, 315ms
EXIT=0
```

**Both pass. Nothing is broken.** Note the discrepancy against `README.md:67` and
`README.md:215`, which both promise `13 files / 128 tests` — the convex suite is now 19 files
and 225 tests, and the README predates the web suite entirely.

`bun run lint` was **not** run (Phase 1 asked for typecheck and test only).

---

## 6. The access chain, precisely

Three files, ~200 lines total, and the whole of I1 lives in them.

### 6.1 `lib/authAdapter.ts` — the provider boundary (49 lines)

`getAuthenticatedIdentity(ctx)` (`authAdapter.ts:30-45`) calls `ctx.auth.getUserIdentity()`
and returns either `null` or a provider-neutral `AuthenticatedIdentity`
(`authAdapter.ts:3-9`): `{ provider, subject, displayName?, email?, emailVerified? }`.

`provider` is the **normalized token issuer** — trailing slash stripped
(`authAdapter.ts:47-49`) — not a prettified label, because subjects are only unique within an
issuer. The doc comment (`authAdapter.ts:13-29`) states the consequence explicitly: changing
an issuer URL is an identity migration, not a config tweak. Nothing outside this file and
`auth.config.ts` knows anything Clerk-specific.

### 6.2 `lib/roles.ts` — rank policy (55 lines)

`roleRank` is a frozen `Record<Role, number>` with `owner: 0 … viewer: 4`
(`roles.ts:6-12`). `roleAtLeast(actual, required)` is `roleRank[actual] <= roleRank[required]`
(`roles.ts:14-16`) and is **the only rank comparison in the codebase** — no domain module
compares role strings (`docs/authorization.md:39-41`).

Two policies are stated once rather than repeated:

- `organizationConfigurationRole = 'admin'` (`roles.ts:38`) — the minimum role for changing
  the tenant's shared vocabulary (Field Definitions, Locations). The rationale
  (`roles.ts:22-37`): configuration freezes at publish (I2/I3), operational data does not.
- `canAssignRole(actorRole, targetCurrentRole, targetNextRole)` (`roles.ts:46-55`) — any
  change *touching* the owner role requires the actor to be an owner.

### 6.3 `lib/access.ts` — the chain itself (93 lines)

Four exported functions, layered:

1. **`requireAuthenticatedUser(ctx)`** (`access.ts:18-35`)
   → `getAuthenticatedIdentity`; `null` ⇒ `unauthenticated()` (`errors.ts:110-112`)
   → point read `users.by_provider_subject` on `(provider, subject)`; `null` ⇒
     `notFoundOrInaccessible()` (`errors.ts:105-107`)
   → returns `{ identity, user }`.

2. **`requireOrganizationMembership(ctx, organizationId, preResolvedUser?)`**
   (`access.ts:51-71`)
   → `preResolvedUser ?? requireAuthenticatedUser(ctx)`
   → point read `organizationMemberships.by_org_user` on `(organizationId, user._id)`;
     `null` ⇒ `notFoundOrInaccessible()`
   → `ctx.db.get(organizationId)`; `null` ⇒ `notFoundOrInaccessible()`
   → returns `{ identity, user, membership, organization }`.

3. **`requireOrganizationRole(ctx, organizationId, minimumRole, preResolvedUser?)`**
   (`access.ts:74-85`) — the above, then `roleAtLeast(membership.role, minimumRole)`; false ⇒
   `notFoundOrInaccessible()`.

4. **`requireOrganizationAccess(ctx, organizationId)`** (`access.ts:88-93`) — a viewer-or-higher
   alias for readable call sites.

**Every failure returns the same generic error** (`errors.ts:104-107`), so a caller cannot
distinguish "does not exist" from "exists, not yours" (I9).

`preResolvedUser` (`access.ts:44-49`) lets a caller that already proved identity → app user in
the same transaction reuse it. It can only be produced by `requireAuthenticatedUser`, so
passing it skips no link.

### 6.4 The fifth link, and where it actually lives

`lib/access.ts` implements links 1–4 of the chain. **Link 5 — ownership of every referenced
entity — is not in `lib/`.** Each domain adds its own resolver that loads the entity,
cross-checks its stored parent, and then delegates: `requireProjectAccess`,
`requireEventAccess`, `requireLocationAccess`, `requireRecipeAccess`, `requireVersionAccess`,
`requireDraftVersionForEdit`, `requireOrganizationFieldAccess`
(`docs/authorization.md:16-20`).

Two ordering rules are load-bearing (`docs/authorization.md:22-32`):

- **Authenticate before looking up a caller-supplied id.** A prior `changeMemberRole` /
  `removeMember` loaded the membership before any auth check, letting an anonymous caller
  distinguish real ids from fabricated ones.
- **Compare organizations before reporting lifecycle state.** `createRelationship` checks
  same-org before checking writability, so an error never leaks a foreign event's status.

### 6.5 Why this matters for the target model

**The signature is the problem, not the logic.** Every helper in `access.ts` takes an
`organizationId` and returns a shape containing `membership: Doc<'organizationMemberships'>`.
There is exactly **one principal type** and it is structurally baked into the return type of
all four functions. A second principal (a provider account with a scoped grant) cannot be
expressed without changing `OrganizationMembershipAccess` (`access.ts:37-40`) — which is the
return type consumed by seven domain resolvers and, transitively, by every public op in the
codebase.

Issue #71 already identifies this and calls it "the most dangerous issue in the repository."
It is right, and it is currently sequenced **after** the entire commercial model.

---

## 7. Open issues — one line each

20 open. Grouped by stage.

| # | Labels | One-line summary |
| --- | --- | --- |
| 18 | `stage:C` | Four Stage-B deferrals: org audit diffing, `addMember` consent, location-archival degradation, `defaultLocationId` backfill |
| 19 | `epic`, `area:web` | Epic: web console — F/G/H complete, chat (#32/#33), statistics (#34/#35), export (#36) outstanding |
| 33 | `area:web`, `stage:I` | Chat proposals: typed recipe/service proposal cards; Accept prefills the real form, never writes |
| 36 | `area:web`, `stage:J` | Export to Excel: `.xlsx` per sheet, column strategy for divergent recipe versions undecided |
| 63 | `question`, `security`, `stage:K` | **Decision issue**: does a transport company get a reference row (a) or its own org + scoped grant (b)? Blocks #71 |
| 64 | `stage:K`, `area:convex` | Suppliers domain — tenant catalogue, `linkedOrganizationId` nullable from day one |
| 65 | `stage:K`, `area:convex` | Vehicle Classes (what is priced) and Fleet Vehicles (what shows up) — deliberately two entities |
| 66 | `stage:K`, `area:convex` | Rate Cards + immutable Rate Card Versions + Rate Lines; structural mirror of Recipe Versions; integer minor units |
| 67 | `security`, `stage:K`, `area:convex` | **Service Assignments** — the load-bearing join; one Event, many priced supply lines; resolved rate copied onto the row |
| 68 | `stage:K`, `area:convex` | Cost Centres + costing arithmetic; currency grouping decision; `notExecutedAmount` / `additionalCharges` |
| 69 | `stage:K`, `area:convex` | Execution record + dispatch status machine, deliberately independent of Event status |
| 70 | `stage:K`, `area:convex` | Cost/budget/supplier rollups as maintained counters, mirroring `statisticsSemanticCounters` |
| 71 | `security`, `stage:K`, `area:convex` | **Scoped cross-org supplier access** — one `requireAssignmentAccess` gate, closed capability set. Blocked on #63 |
| 72 | `area:web`, `stage:L` | Suppliers & fleet configuration surfaces + reusable `SupplierPicker` / `VehicleClassPicker` |
| 73 | `area:web`, `stage:L` | Rate card editor as a **grid** (class × modality), `lib/money.ts`, published version has no edit affordance |
| 74 | `area:web`, `stage:L` | Assignment panel on the service detail — the console half of the vertical slice |
| 75 | `area:web`, `stage:L` | Dispatch board — the day sheet that has to beat the spreadsheet |
| 76 | `area:web`, `stage:L` | Budget & cost surface — the `PRESUPUESTO` sheet, live |
| 77 | `area:web`, `stage:L` | Import an `.xlsx` planning workbook with mandatory mapping + dry-run preview |
| 78 | `epic`, `stage:K`, `stage:L` | Epic: supply side — the stage:K/L plan, declares I10, sequences the access decision *after* the commercial model |

---

## 8. Where the target model is wrong about the actual code

Blunt, as requested.

### 8.1 The biggest one: this work is already specified, in 16 open issues

> Target: `Company → Project → Event → Service → Assignment → Provider`

Issues **#63–#78** already specify a supply side with assignments, immutable priced
configuration, cost centres, execution records, money rollups, and scoped cross-organization
provider access. Epic #78 even pre-declares the invariant the target model calls "accepted
terms are immutable" — as **I10, "Agreed money is immutable."**

This is not a greenfield reshape. It is a **rename plus one structural insertion** on top of a
plan that already exists and is mostly still correct. Treating it as new work would discard
~1,400 lines of already-written, evidence-backed specification derived from a real workbook
(`cordillera_paramo_2026.xlsx`). The honest framing of Phase 2 is triage, not replacement.

### 8.2 "Organization → Project → Event" — `Organization`, not `Company`

There is no `companies` table. `organizations` (`schema.ts:40-43`) is the tenant root, it is
referenced by a denormalized `organizationId` on **13 of the 18 tables**, and the identifier
appears in every access helper, every model function signature, every index name
(`by_org_*` × 17), and every audit row. Renaming it to `Company` is a mechanical but genuinely
repo-wide change with **zero functional benefit** — and it collides head-on with the provider
model, where a provider firm *is* an Organization too (#63 shape (b)). Under the target model
you would have `Company` meaning both "the coordinator tenant" and "the provider firm", which
is exactly the ambiguity `organizations` currently avoids.

**Recommendation:** drop `Company`. Keep `Organization`.

### 8.3 "Event becomes a real entity between Project and Service" — this is the one genuinely new idea, and it is the expensive one

Nothing in the current schema sits between `projects` and `events`. The target inserts a layer
and renames the leaf, which means:

- `events` → `services`, and a **new** `events` table with different semantics. Any migration
  that reuses the name `events` for the new parent is a trap: `eventFieldValues`,
  `eventRelationships`, `eventRecipes`, `eventStatusValidator`, `eventFields`,
  `by_org_status_startsAt`, `statisticsCounters.category: 'eventStatus'`,
  `statisticsSemanticCounters.category: 'eventStatus'`, 11 `auditEntityType` literals and ~20
  `errorCodes` beginning `event*` all currently mean *the leaf*.
- The console already calls the leaf **"Servicio"** (`CLAUDE.md:46-48`). So the rename makes
  the backend agree with the UI — a real win — but it also frees the word "Event" for a new
  meaning, and every existing `event*` identifier becomes ambiguous **during** the migration
  rather than after it.
- `statisticsBackfillProgress.phase` (`schema.ts:258`) has an `events` literal that would need
  to mean `services`.

**(inference)** This is a big-bang rename, not an incremental one. Because there is no
production data (stated in the brief and consistent with `README.md:158-161`'s
"irreversible seed" framing), the cheapest correct path is **one atomic rename commit + wipe
+ reseed**, not a compatibility layer. But it must land *before* #64–#70 write any new code
against the old names, or every one of those issues gets rewritten twice.

### 8.4 "The recipe machinery becomes Service Kinds. Mechanism unchanged." — mostly right, one correction

Correct that the mechanism carries over: `eventRecipes` → `recipeVersions` → `recipeFields`,
composed from `fieldDefinitions`, with the config snapshot at `recipeFields.config`
(`schema.ts:141`) being what makes I3 structural.

Two things the target statement glosses over:

- **"created at runtime by tenants" is already true and is not the whole story.** Recipes are
  tenant-created, *but* the deployment also ships a built-in Field Definition catalogue at
  `organizationId: undefined` (`validators/index.ts:643-644`, `schema.ts:94`) and
  auto-provisions starter recipes into every new organization
  (`recipes/builtins.ts:59` `provisionStarterRecipes`, called from `organizations/model.ts:81`).
  A "Service Kind" rename must carry both the tenant path and the built-in path.
- **`eventRecipes` is a third `event*` name that has to move**, and it is the one most likely
  to be forgotten because the *table* is `eventRecipes` while the *domain directory* is
  `recipes/` and the console calls them "Recetas".

### 8.5 "Providers are external firms with FULL ACCOUNTS" — this is a decision that has not been made, and it is question #63

The target model asserts full provider accounts as settled. **It is not settled in this
repository.** #63 is an open decision issue whose stated recommendation is the opposite:
*"(a) now, (b) as a designed migration, and write the decision record before either."*

If the answer is genuinely (b) — full accounts — that is a legitimate owner decision and it
changes the sequencing materially:

- `suppliers.linkedOrganizationId` stops being a speculative nullable column (#64) and becomes
  load-bearing on day one.
- #71 stops being a late add-on and becomes a **prerequisite**, because building #67/#68/#69's
  authorization against a single-principal helper and then retrofitting a second principal is
  precisely the "one file, not forty" failure #63 warns about.

**This is the single most consequential correction in Phase 1**, and §8.7 is its consequence.

### 8.6 "their own role ladder" — the existing ladder is not reusable as-is

`roleValidator` is `owner \| admin \| planner \| operator \| viewer`
(`validators/index.ts:21-27`) and is *organization membership* role. A provider's ladder is a
different axis: #71 explicitly says the grant's capability set must be **"enumerated and
closed, not a role"** — `readAssignment`, `writeExecution`, `readLinkedServiceProjection`, and
nothing else.

So "providers get their own role ladder" is in direct tension with the existing issue's
design. **(inference)** Both can be true: a provider organization has internal members with
the ordinary five-role ladder (they are an Organization, after all), *and* the cross-tenant
grant confers a closed capability set independent of that ladder. Those are two different
mechanisms and conflating them is how a provider's own admin ends up with `readRates` on
somebody else's festival. Worth stating explicitly in whatever decision record #63 produces.

### 8.7 "Assignments carry an agreed price… renegotiation creates a new revision, server-assigned number" — half-specified today, and the ordering is wrong

What already matches: #67 stores `unitAmount`, `currency`, `rateCardVersionId`, `rateLineId`
and `lineTotal` on the assignment, never recomputed (I10). Server-assigned numbering has an
exact precedent in `recipeVersions.versionNumber` (`schema.ts:106`, I7).

What does **not** exist anywhere in the issues: **assignment revisions**. #67's
`updateAssignment` *mutates the row in place* and writes an `assignment.repriced` audit event.
The target model wants an immutable revision chain instead — a new row with a server-assigned
revision number, the old one retained. That is a **real scope change to #67**, not a detail,
and it is closer to `recipeVersions` than to what #67 currently describes.

And the ordering problem: **#67 is currently the vertical-slice keystone (#64 → #65 → #66 →
#67 → #74) and is scheduled to be built against `requireOrganizationRole`.** If providers get
accounts (§8.5), #67's authorization is written twice. The access-chain generalization has to
come first.

### 8.8 "Chat is an assistant that emits typed, reviewable proposals and never writes directly" — already true and already documented; nothing to change

This is the existing design, not a target. `CLAUDE.md:157-159` states it as a non-goal
boundary; epic #19 restates it; #33 specifies the proposal contract; `apps/web/lib/chat-backend.ts:1-16`
implements provisional types against a stub; and **there is no chat domain in
`apps/convex/convex/` at all**, so there is no write path to remove.

The only genuine gap is that the rule lives in three prose locations and **is not one of I1–I9**.
If it is to be load-bearing, it should be an invariant, not a paragraph.

### 8.9 "No production data exists. Demo seed only." — true, and better-supported than the brief implies

Confirmed: `seed/` contains `bogota.ts`, `cordillera.ts`, `identity.ts`, `mutations.ts` and
`reset.ts`. A **`reset.ts` already exists** (`seed/reset.ts:61,107`), which sweeps tables
wholesale. Every seed write goes through the ordinary domain functions
(`deviations.md:110`), so a reseed genuinely re-exercises publish validation, server-assigned
version numbers and the typed-value gate.

Two irreversibility caveats the wipe-and-reseed plan must handle, both already documented:

- The demo org **slug is deployment-wide unique and there is no `deleteOrganization`**
  (`README.md:158-161`). `reset.ts` must be verified to actually reclaim it, or the second
  reseed fails.
- **Built-in field keys are squatted deployment-wide and freeze on first publish**
  (`deviations.md:110`, `README.md:159-161`).

### 8.10 Smaller corrections

| Target model says | Actual |
| --- | --- |
| "Event… dates, client, venue, budget, owner" | `client`, `venue`, `budget` and `owner` have no representation anywhere. `venue` is closest to `locations` (`schema.ts:280`, `locationType: 'venue'`); `client` is closest to #68's `costCentres`, which are **charged-to parties**, not clients. `owner` collides with the `owner` **role** (`validators/index.ts:22`) and needs a different word |
| "Provider" | Every existing issue and doc says **"Supplier"** (`suppliers`, `supplierId`, `supplierAccessGrants`, `SupplierPicker`, `docs/supplier-access.md`, ~200 references across #63–#78). Both words are fine; picking "Provider" means rewriting 16 issues' vocabulary for no functional gain |
| Chain shown as linear `Event → Service → Assignment → Provider` | Assignment references **five** entities, not one: supplier, vehicle class, rate card version, rate line, cost centre (#67). And Service→Assignment is 1:many by design — that is the whole point of #67's Emmanuel Horvilleur example |

---

## 9. What Phase 2 has to decide (carried forward, not answered here)

1. **`Company` or `Organization`?** — recommend `Organization` (§8.2).
2. **`Provider` or `Supplier`?** — recommend `Supplier`, to avoid rewriting 16 issues (§8.10).
3. **Is #63 answered as (b), full provider accounts?** The target model asserts yes. If so,
   the access-chain generalization moves **before** #64–#70, and #71 stops being blocked
   (§8.5, §8.7).
4. **Do assignments get an immutable revision chain?** #67 today says patch-in-place +
   audit. The target says revisions with server-assigned numbers. These are different tables
   (§8.7).
5. **Is "chat never writes" promoted to a numbered invariant?** (§8.8)
6. **Is I10 adopted into `CLAUDE.md`?** It is currently declared only inside issue #78 (§2.3 D9).

---

## 10. Summary of Phase 1 verification

| Check | Result |
| --- | --- |
| `bun run typecheck` | **PASS**, exit 0, three packages |
| `bun run test` | **PASS**, exit 0 — convex 225/225 in 19 files, web 139/139 in 22 files |
| `bun run lint` | not run (out of Phase 1 scope) |
| Schema tables | 18 (docs claim 13) |
| Open issues | 20 |
| `apps/web/` | fully built console, not a placeholder |
| Epic #19 checklist | **stale** — #31, #32, #34, #35 are CLOSED but shown unchecked |
| Access chain principals | exactly **one** (`organizationMemberships`), structurally baked into `access.ts`'s return types |
