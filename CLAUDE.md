# Priamo — Logistics Operations Platform

Open-source logistics operations platform: TypeScript (strict) + Convex + Clerk backend,
with a Next.js operations console on top. For logistics companies, transportation
coordinators, event organizers, and ops teams currently running complex transportation
projects on spreadsheets and email.

Work is specified and tracked in **GitHub issues** (see the epic tracking issues); each
issue carries its own scope checklist and required tests. This file holds the invariants
and conventions that apply to everything.

## Core architectural principle

> Flexibility comes from assembling reusable, structured, semantic **Field Definitions**
> into immutable, versioned **Event Recipes**.

Never drift toward either failure mode: a rigid giant schema with hundreds of nullable
columns, or a generic arbitrary-JSON form builder with no semantic understanding.

## Domain model

```
Organization → Project → Event
Field Definition → Event Recipe → Recipe Version → Recipe Fields
Event → Event Field Values
```

- A Recipe is **configuration**; an Event is **operational data**.
- Every Event references the exact published Recipe Version it was created from.
- Historical Events must never silently change because a Recipe is edited later.
- Vocabulary: the backend entity is an **Event**; the console calls it a **Service**
  (`Servicio`). Keep backend identifiers on `event`; keep user-facing words on service.

## Non-negotiable invariants (I1–I11)

- **I1 Tenant isolation**: every public op proves `identity → app user → principal
  (member | provider grant) → capability → ownership of every referenced entity`. Knowing
  a Convex ID grants nothing. There are two principal arms and neither derives capability
  from identity alone: an organization membership carrying a ranked role, or a scoped,
  non-transitive Provider grant carrying a closed capability set. No invariant, helper or
  doc may assume membership is the only possible principal. The second arm is specified in
  [`docs/provider-access.md`](docs/provider-access.md) and implemented by #71; it does not
  exist in code yet.
- **I2 Published Recipe Versions are immutable** (record, fields, ordering, required
  flags, defaults, validation, visibility). Changes go through a new draft version.
- **I3 Historical validation integrity**: Events stay interpretable and validatable under
  the exact Recipe Version + field semantics they were created with — even after that
  version is retired or the field is used elsewhere.
- **I4 Authoritative relationships are derived server-side** (e.g. `recipeId` from
  `recipeVersionId`, org ownership through the stored entity graph); never trust
  redundant client-supplied IDs.
- **I5 Every public function validates input with Convex validators.** No loose objects.
- **I6 Unbounded public list reads use Convex pagination** — no unrestricted `.collect()`
  on growing tenant datasets (bounded child sets like one version's Recipe Fields are fine).
- **I7 Version numbers are server-assigned** in the same transaction that creates the
  version; clients never choose or calculate them.
- **I8 No escape hatches**: no user scripts, expression DSLs, arbitrary JSON, generic
  reference types, workflow engines, or low-code form engines. Structured flexibility only.
- **I9 Don't disclose cross-tenant existence** — generic "not found/inaccessible" errors
  when a caller lacks access, whether or not the entity exists. The console must not
  translate an error into anything more specific than the backend's own code. This applies
  identically to both principal arms.
- **I10 Agreed money is immutable.** Once an Assignment revision resolves a rate from a
  published Rate Card Version, that amount is stored on the revision and is never
  recomputed. Reports read the stored figure. Editing a rate card, renaming a vehicle
  class, retiring a version or archiving a provider can never retroactively change what a
  past assignment cost. Renegotiation creates a new server-numbered revision (I7); it
  never patches an accepted one.
- **I11 The assistant never writes.** Chat emits typed, reviewable proposals; accepting a
  proposal prefills the ordinary form and every write goes through the same validated
  mutation a human action would use. There is no privileged assistant path, no
  assistant-only mutation, and no bypass of any authorization or validation gate.

## Backend conventions

- TypeScript strict mode; **never `any`**, no unsafe assertions.
- Convex for all backend (queries/mutations/actions/internal functions/crons).
- Clerk for auth, isolated behind a small **auth adapter**. Clerk is *not* the canonical
  owner of orgs, roles, memberships, or authorization decisions — the Convex database is.
  Domain code sees only a provider-neutral identity (`provider`, `subject`, …); only the
  adapter knows Clerk claim structure. Same codebase must support hosted SaaS and
  self-hosted deployments.
- Consult current official Convex + Clerk docs before auth/infra work; prefer supported
  APIs and document any resulting design adjustments.
- **Uniqueness** = indexed read-before-write inside the same mutation. Never
  full-table-scan for uniqueness. Constraints: `authProvider+authSubject`, org `slug`,
  `orgId+userId`, `orgId+field key`, `orgId+recipe key`, `recipeId+versionNumber`,
  one draft per recipe, `recipeVersionId+fieldDefinitionId`, `eventId+fieldDefinitionId`,
  relationship `source+target+type`, one pending invitation per `orgId+email`.
- **Temporal semantics**: `datetime` = absolute timestamp (ms); `date` = `YYYY-MM-DD`
  string, never converted to a timestamp; `time` = strict `HH:mm` wall-clock string.
  An Event's canonical `startsAt` is always a complete absolute timestamp.
- **Errors are stable codes**, not prose: throw `ConvexError` carrying a code from
  `convex/lib/errors.ts`. Nothing (tests included) may match on message text.
- Public handlers stay thin; authorization, validation, and business invariants live in
  reusable domain functions. Role decisions are centralized in shared helpers — no
  scattered role string comparisons.
- Roles: `owner > admin > planner > operator > viewer`. Final owner can never be removed
  or demoted (server-side check).
- Deletion policy: prefer archival/cancellation. Never hard-delete published/retired
  versions, referenced recipes/fields, projects with events, or events. Destructive ops
  verify references first.
- Audit log (not event sourcing): domain operations record audit events; metadata never
  contains secrets, tokens, provider claims, or excessive PII.

## Web console conventions

`docs/web-design.md` is the design decision record — typography, palette, status
colour/shape mapping, table/form/pagination patterns, bento rules. Read it before
building a screen.

- Next.js App Router (React 19) + Tailwind v4. Tokens live in CSS-first `@theme` in
  `app/globals.css`; there is **no `tailwind.config.js`**. Dark is canonical.
- shadcn 4.x primitives (`base-nova` style, on Base UI — not Radix) are vendored into
  `components/ui/` and re-skinned onto our tokens. Compose screens from those primitives.
- Route pages under `app/[locale]/(application)/` stay thin (await `params`, render a
  surface); the work lives in `'use client'` surface components under `components/<domain>/`.
- Backend access is the generated API only: `import { api } from '@priamo/convex/api'`,
  plus `@priamo/convex/validators` and `/errors` for shared types. Never hand-write a
  backend signature or re-declare a union the backend owns.
- Tenant lists use `usePaginatedQuery` (mirrors I6) and pass `'skip'` until the current
  organization is known.
- **UI role checks are affordances, never authorization** (`lib/roles.ts`); the backend
  is the sole authority. Hiding a button protects nothing.
- Errors: map backend codes → message keys in `lib/convex-errors.ts`; unknown code falls
  back to the generic message. Never render raw backend prose.
- Statuses: exhaustive `Record`s keyed off backend unions in `lib/status.ts`, so a new
  backend status is a `tsc` failure, not an uncoloured chip. Colour is never the only
  channel — shape carries the same information.
- i18n via `next-intl`: canonical locales `es-CO` (default) and `en-US`, URL segments
  `/es` and `/en`, mapped only in `i18n/locales.ts`. Internal links always carry the
  locale segment via the `i18n/` href helpers — never a bare path. Message keys may not
  contain `.` (next-intl reserves it for nesting). Catalogues cover UI chrome and
  code-owned vocabulary only — **tenant-authored text (recipe/field/project/location
  names, option labels) is rendered exactly as entered, never translated.**
- Pure logic goes in `lib/*.ts` with a colocated `*.test.ts` (`bun test`); components
  stay presentational enough that the rules are testable without rendering.

## Repository structure

```
apps/convex/convex/   — schema.ts + one directory per domain (auth, organizations,
                        invitations, projects, fields, recipes, recipes/fields, events,
                        locations, relationships, audit, seed, validators, lib)
                        each domain: model.ts (logic) + queries.ts / mutations.ts (thin)
apps/convex/tests/    — convex-test suites, one per domain
apps/web/             — app/[locale]/… routes, components/{ui,<domain>}, i18n/, lib/
packages/shared/      — provider-neutral shared package (placeholder)
docs/                 — architecture, per-domain decision records, web-design.md
```

Guidance, not rigid; prefer cohesive modules over giant files.

## Workflow

- Pick up a GitHub issue, implement it fully (including its listed tests), verify, close
  with a summary comment noting any deliberate deviations.
- Stage discipline (labels): backend `stage:A` architecture → `stage:B` priority vertical
  slice → `stage:C` remaining domains → `stage:D` seeds/demo → `stage:E` docs; console
  `stage:F` foundation (shell, auth, i18n) → `stage:G` configuration surfaces (fields,
  recipes) → `stage:H` operations surfaces (projects, locations, services) → `stage:I`
  chat → `stage:J` export. Then the reshape (tracked in #91): `stage:M`
  reshape foundation (rename, Event layer, money primitives, cost centres) → `stage:N`
  principals (providers directory, Principal union, grants, the single gate) → `stage:O`
  commercial backend (fleet, rate cards, assignments, costing, rollups) → `stage:P`
  provider accounts & portal → `stage:Q` console (events, config, assignment panel,
  dispatch, budget, import) → `stage:R` chat backend. `stage:K` and `stage:L` are
  **retired**: their split encoded an ordering that changed (the access-chain
  generalization now precedes the commercial model), so they are not reused or renumbered.
  Don't start a stage while the previous one is knowingly broken.
- After every change set, from the repo root: `bun run codegen` → `bun run typecheck` →
  `bun run lint` (includes `i18n:check`) → `bun run test` → fix. Never leave the repo
  non-compiling; never claim tests passed without running them. If a command can't run,
  say which, why, and what was verified instead.
- Package manager: **bun** (no npm). Assume the dev server is already running; don't run
  `dev` or `build`.
- The **priority vertical slice** beats breadth: sign-in → app user → org → project →
  built-in fields → recipe → publish version → create typed Service → retrieve it. A
  smaller coherent working product is better than a broad partially connected one.
- After implementing backend code, run the `invariant-auditor` agent on the diff; before
  claiming a domain's tests done, run `test-coverage-auditor`.

## Explicit non-goals

No routing, mapping, geocoding, address normalization, flight-tracking integrations,
workflow engines, rules engines (leave documented room for future structured conditional
rules — don't build them), low-code builders, event sourcing, or generic reference
systems. The chat surface is a UI with a stubbed responder that produces reviewable
proposals — it is not an agent, a rules engine, or a write path of its own (I11). Future
compatibility yes; premature building no.

The commercial model records what was agreed and what it cost. It does **not** extend to:

- No invoicing, tax, payment collection, reconciliation, or accounts-payable system.
- No pricing engine, formula language, expression DSL, or currency-conversion engine.
  Rates are looked up from a published Rate Card Version, never computed from a rule.
- No driver management, payroll, scheduling, telematics, maintenance, or availability
  system. Vehicle classes are what is priced; fleet vehicles are what shows up.
- No provider ratings, contracts, document store, insurance tracking, or onboarding
  workflow.
- No tenant-configurable disclosure rule (I8) — provider visibility is a code-owned
  semantic projection; see [`docs/provider-access.md`](docs/provider-access.md).
