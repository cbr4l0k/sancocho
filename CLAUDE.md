# Sancocho — Logistics Operations Platform (Backend Foundation)

Open-source logistics operations platform backend: TypeScript (strict) + Convex + Clerk.
For logistics companies, transportation coordinators, event organizers, and ops teams
currently running complex transportation projects on spreadsheets and email.

Work is specified and tracked in **GitHub issues** (see the epic tracking issue); each
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

## Non-negotiable invariants (I1–I9)

- **I1 Tenant isolation**: every public op proves `identity → app user → org membership →
  permission → ownership of every referenced entity`. Knowing a Convex ID grants nothing.
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
  when a caller lacks access, whether or not the entity exists.

## Tech & conventions

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
  relationship `source+target+type`.
- **Temporal semantics**: `datetime` = absolute timestamp (ms); `date` = `YYYY-MM-DD`
  string, never converted to a timestamp; `time` = strict `HH:mm` wall-clock string.
  An Event's canonical `startsAt` is always a complete absolute timestamp.
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
- Package manager: **bun** (no npm). No frontend UI work in this phase.

## Repository structure (target)

```
apps/convex/convex/   — schema.ts + one directory per domain
                        (auth, organizations, projects, fields, recipes,
                         events, locations, relationships, audit, validators,
                         seed, internal)
apps/web/             — placeholder, no UI yet
packages/shared/      — shared types/validators
```

Guidance, not rigid; prefer cohesive modules over giant files.

## Workflow

- Pick up a GitHub issue, implement it fully (including its listed tests), verify, close
  with a summary comment noting any deliberate deviations.
- Stage discipline (labels): `stage:A` architecture review → `stage:B` priority vertical
  slice → `stage:C` remaining domains → `stage:D` seeds/demo → `stage:E` docs. Don't
  start a stage while the previous one is knowingly broken.
- After every change set: `convex codegen → typecheck → test → fix`. Never leave the repo
  non-compiling; never claim tests passed without running them. If a command can't run,
  say which, why, and what was verified instead.
- The **priority vertical slice** beats breadth: sign-in → app user → org → project →
  built-in fields → recipe → publish version → create typed Event → retrieve it. A
  smaller coherent compiling backend is better than a broad partially connected one.
- After implementing backend code, run the `invariant-auditor` agent on the diff; before
  claiming a domain's tests done, run `test-coverage-auditor`.

## Explicit non-goals

No frontend UI, driver/vehicle/fleet management, routing, mapping, geocoding, address
normalization, billing/pricing, flight-tracking integrations, workflow engines, rules
engines (leave documented room for future structured conditional rules — don't build
them), low-code builders, event sourcing, or generic reference systems. Future
compatibility yes; premature building no.
