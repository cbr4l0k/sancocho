# priamo

Backend foundation for a logistics operations platform: TypeScript (strict) + Convex +
Clerk. It targets logistics companies, transportation coordinators, event organizers and
ops teams who currently run complex transportation projects on spreadsheets and email.

There is no frontend in this phase. What exists is a complete, tested Convex backend:
schema, domain modules, authorization, validation, audit log, and a seeded demonstration
slice.

## Core architectural principle

> Flexibility comes from assembling reusable, structured, semantic **Field Definitions**
> into immutable, versioned **Event Recipes**.

```
Organization → Project → Event
Field Definition → Event Recipe → Recipe Version → Recipe Fields
Event → Event Field Values
```

- A Recipe is *configuration*; an Event is *operational data*.
- Every Event stores the exact published Recipe Version it was created from, and is
  validated against that version's snapshotted field configuration forever — including
  after the version is retired or the underlying Field Definition is edited elsewhere.
- The two failure modes this design exists to avoid are a rigid giant schema with hundreds
  of nullable columns, and a generic arbitrary-JSON form builder with no semantic
  understanding. There is no arbitrary-JSON column, no expression DSL, no rules engine and
  no generic reference type anywhere in the schema.

The nine non-negotiable invariants (I1–I9) that every module is held to are stated in
[`CLAUDE.md`](CLAUDE.md); the Stage A decisions behind them are in
[`docs/architecture-review.md`](docs/architecture-review.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/convex/convex/schema.ts` | All 13 tables and their indexes; the single schema source of truth |
| `apps/convex/convex/auth.config.ts` | Convex JWT provider config (Clerk-specific) |
| `apps/convex/convex/lib/` | `authAdapter.ts`, `access.ts`, `roles.ts`, `errors.ts`, `names.ts` |
| `apps/convex/convex/validators/` | Shared Convex validators, the field-config and field-value unions, the semantic registry, audit vocabulary |
| `apps/convex/convex/<domain>/` | One directory per domain: `auth`, `organizations`, `projects`, `fields`, `recipes` (+ `recipes/fields`), `events`, `locations`, `relationships`, `audit`, `seed` |
| `apps/convex/tests/` | vitest + convex-test suites, one file per domain concern |
| `apps/web/` | Placeholder package, no UI |
| `packages/shared/` | Marker package for future provider-neutral shared types |
| `docs/` | Architecture and policy documentation (index below) |

Inside a domain directory: `queries.ts` and `mutations.ts` hold thin registered Convex
functions; `model.ts` holds the authorization, validation and business logic as plain
functions that take `ctx`. Registered functions never contain policy.

## Quickstart: clone to running tests

Requires [bun](https://bun.sh) (developed against 1.3.14). Nothing else — no Convex
account, no Clerk account, no running backend. `convex/_generated` is committed, and the
test suite runs against convex-test's in-memory runtime.

```bash
git clone https://github.com/cbr4l0k/priamo.git
cd priamo
bun install
bun run typecheck
bun run test
```

Expected: `Test Files 13 passed (13)`, `Tests 128 passed (128)`.

Notes that will bite otherwise:

- **Tests run under vitest, not `bun test`.** convex-test requires the `edge-runtime`
  environment (`@edge-runtime/vm`), which bun's native test runner does not provide. bun
  is the package manager and script runner only; `bun run test` shells out to `vitest run`.
- `bun run codegen` is **not** part of this path and will fail on a fresh clone — it needs
  a configured Convex deployment (next section). You do not need it to build or test,
  because the generated files are committed.

Root scripts: `bun run typecheck` (apps/convex + packages/shared), `bun run test`,
`bun run codegen`. The post-change loop for any code change is
`codegen → typecheck → test`.

## Working against a Convex deployment

Needed for `convex codegen`, `convex run`, seeding, and anything that executes on a real
backend. Two options; both are configured through the Convex CLI, which writes
`apps/convex/.env.local` (gitignored).

### Local, no Convex account (what this repo was developed against)

```bash
cd apps/convex
CONVEX_AGENT_MODE=anonymous bunx convex dev --once
```

The first run configures the local deployment and writes `.env.local`, then **fails the
push** with:

```
✖ Environment variable CLERK_JWT_ISSUER_DOMAIN is used in auth config file but its value was not set.
```

That is `convex/auth.config.ts` refusing to evaluate with an unset issuer (it throws
rather than silently matching no issuer). Set the variable on the deployment and re-run:

```bash
bunx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-subdomain>.clerk.accounts.dev
CONVEX_AGENT_MODE=anonymous bunx convex dev --once
```

The second run pushes the schema, creates every index, and ends with
`✔ Convex functions ready!`. After that, `bun run codegen` works from the repo root and
regenerates `apps/convex/convex/_generated` (it should produce no diff on a clean tree).

`CONVEX_AGENT_MODE=anonymous` is a Convex beta feature and the CLI prints so. It downloads
and runs a local backend binary (cached under `~/.cache/convex/binaries`) on port 3210.
Observed in practice: the CLI checks for the latest backend version online at startup and
aborts with `Failed to fetch latest backend version` on a flaky network — re-running is
the fix; nothing in the repo is involved.

### Hosted Convex

`bunx convex dev` (without `CONVEX_AGENT_MODE`) after `bunx convex login`, which links a
cloud project and writes the same `.env.local` keys. `CLERK_JWT_ISSUER_DOMAIN` must be set
on that deployment too, via `bunx convex env set` or the Convex dashboard, or every push
fails identically. Nothing in the codebase distinguishes the two deployment kinds — the
local path is untested for `--prod`-style workflows here.

### Environment variables

| Variable | Lives in | Required for | Notes |
| --- | --- | --- | --- |
| `CLERK_JWT_ISSUER_DOMAIN` | Convex deployment env (`convex env set`) | Every push, `codegen`, and all auth | Read by `convex/auth.config.ts`, which throws when it is unset or empty |
| `PRIAMO_ENABLE_SEED` | Convex deployment env | The three seed mutations and `fields.createBuiltinFieldDefinition` | Must be exactly the string `true`; see [Seeding](#seeding) |
| `CONVEX_DEPLOYMENT`, `CONVEX_URL`, `CONVEX_SITE_URL` | `apps/convex/.env.local` | CLI deployment targeting | Written by the CLI; gitignored; never edited by hand |
| `CONVEX_AGENT_MODE=anonymous` | Shell, for `convex dev` only | The local no-account deployment | Beta |

There are no other environment variables. The application reads nothing from `process.env`
except `CLERK_JWT_ISSUER_DOMAIN` (in `auth.config.ts`) and `PRIAMO_ENABLE_SEED` (in
`seed/mutations.ts`).

### Clerk configuration

Backend-side, Clerk is one deployment variable and one file. `auth.config.ts` declares
`{ domain: process.env.CLERK_JWT_ISSUER_DOMAIN, applicationID: 'convex' }`, so the Clerk
instance needs a JWT template named `convex`, and its issuer URL is what goes into
`CLERK_JWT_ISSUER_DOMAIN`. No webhooks are configured or needed: app users are provisioned
on demand by the idempotent `auth.mutations.ensureUser`. Clerk organizations, roles and
memberships are ignored entirely — the Convex database owns all of that. See
[`docs/auth.md`](docs/auth.md).

## Seeding

The seed builds one complete vertical slice — organization → project → locations → recipe →
published version 1 → a typed Event with nine values — and the deployment-wide built-in
field catalogue. Every write goes through the same domain functions the public API uses, so
publish validation, server-assigned version numbers and the typed-value gate all really run.

Seeding is guarded per deployment because it is irreversible in two ways: it consumes the
deployment-wide-unique organization slug (`priamo-demo`, and there is no
`deleteOrganization`), and built-in field keys are squatted for every tenant in the
deployment and freeze on first publish.

```bash
cd apps/convex
bun run seed:enable   # convex env set PRIAMO_ENABLE_SEED true
bun run seed          # convex run seed/mutations:seedDemonstrationData
```

Without the opt-in, the mutation throws
`Seeding is disabled on this deployment; set PRIAMO_ENABLE_SEED=true to allow it`. Re-runs
are idempotent (the second run stops at the recipe's indexed org/key lookup).

To make the demo usable by a human who can actually sign in, pass a real identity — the
issuer your deployment verifies plus that provider's stable subject:

```bash
bunx convex run seed/mutations:seedDemonstrationData \
  '{"owner":{"issuer":"https://<your-subdomain>.clerk.accounts.dev","subject":"user_123","name":"Ada Lovelace","email":"ada@example.com"}}'
```

If the demo was already seeded under the synthetic default owner (an identity nobody can
authenticate as), repair it — `addMember` needs an existing admin, so no public door can
let a person in:

```bash
bunx convex run seed/mutations:grantDemoMembership \
  '{"owner":{"issuer":"https://<your-subdomain>.clerk.accounts.dev","subject":"user_123","name":"Ada Lovelace","email":"ada@example.com"}}'
```

`bunx convex run seed/mutations:seedBuiltinFieldDefinitions` seeds only the built-in field
catalogue, with no demo tenant.

## Documentation

| Document | Covers |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Domain model, module layering, table/index map, uniqueness and concurrency rationale |
| [`docs/auth.md`](docs/auth.md) | Identity flow, the adapter boundary, exactly which files are Clerk-specific, what replacing Clerk requires, self-hosted considerations |
| [`docs/authorization.md`](docs/authorization.md) | The access chain, the role policy per operation, tenant isolation, error discipline |
| [`docs/recipes.md`](docs/recipes.md) | Field definitions, the semantic capability registry, config snapshots, recipe/version lifecycle and published immutability |
| [`docs/events.md`](docs/events.md) | Typed event field values, the creation flow, temporal semantics, event status, relationships |
| [`docs/locations.md`](docs/locations.md) | Location reference semantics and their historical implication |
| [`docs/deletion-and-archival.md`](docs/deletion-and-archival.md) | What can be archived, what can be hard-deleted, and every reference guard |
| [`docs/audit.md`](docs/audit.md) | The audit log, enforced metadata safety, the org-less gap |
| [`docs/deviations.md`](docs/deviations.md) | Every deliberate deviation and decision recorded during implementation, plus known gaps |
| [`docs/architecture-review.md`](docs/architecture-review.md) | The Stage A review (historical; where implementation diverged it is noted in `docs/deviations.md`) |

## Testing

```bash
bun run test                                  # from the repo root
bun run --cwd apps/convex test -- events      # a single file, via vitest's filter
```

128 tests across 13 files, all in-memory via convex-test. One file per domain concern plus
`verticalSlice.test.ts`, which asserts the whole priority slice end to end: authenticated
identity → app user → organization + owner membership → project → built-in *and*
tenant-owned field definitions → recipe → published version → typed Event → retrieval, with
every derived id on the stored Event checked against the entity it came from.

convex-test does not enforce Convex's size/time limits and differs from the real runtime in
error messages, so tests assert on this codebase's own thrown errors, never on Convex
internals.

## Non-goals

No frontend UI, driver/vehicle/fleet management, routing, mapping, geocoding, address
normalization, billing, flight-tracking integrations, workflow engines, rules engines,
low-code builders, event sourcing, or generic reference systems. Room is deliberately left
for future structured conditional rules on recipe fields (see `recipes/fields/model.ts`);
they are not built.
