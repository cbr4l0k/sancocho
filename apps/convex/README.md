# @priamo/convex

The Convex backend: schema, domain modules, authorization, validation, audit log and seeds.

```bash
bun run typecheck   # tsc --noEmit
bun run test        # vitest run (edge-runtime; NOT bun test)
bun run codegen     # convex codegen — requires a configured deployment
bun run seed:enable # convex env set PRIAMO_ENABLE_SEED true
bun run seed        # convex run seed/mutations:seedDemonstrationData
```

Setup, environment variables, deployment configuration and the seed workflow are in the
[repository README](../../README.md). The design documentation lives in [`docs/`](../../docs):

| Topic | Document |
| --- | --- |
| Domain model, layering, tables and indexes, uniqueness rationale | [`docs/architecture.md`](../../docs/architecture.md) |
| Identity flow, the Clerk-specific files, replacing the provider | [`docs/auth.md`](../../docs/auth.md) |
| Access chain, role policy per operation, tenant isolation, error discipline | [`docs/authorization.md`](../../docs/authorization.md) |
| Field definitions, semantic registry, snapshots, version lifecycle | [`docs/recipes.md`](../../docs/recipes.md) |
| Typed event values, creation flow, temporal semantics, relationships | [`docs/events.md`](../../docs/events.md) |
| Location reference semantics | [`docs/locations.md`](../../docs/locations.md) |
| Deletion and archival policy | [`docs/deletion-and-archival.md`](../../docs/deletion-and-archival.md) |
| Audit log and metadata safety | [`docs/audit.md`](../../docs/audit.md) |
| Deliberate deviations and known gaps | [`docs/deviations.md`](../../docs/deviations.md) |

Module convention: `queries.ts` and `mutations.ts` hold thin registered Convex functions with
`args` and `returns` validators; `model.ts` holds authorization and business logic as plain
`ctx`-taking functions. Shared validators and the table shapes that both the schema and the
public API build on live in `convex/validators/`.
