# Authentication and the provider boundary

Clerk is the configured identity provider. It is not the owner of organizations, roles,
memberships, or any authorization decision — the Convex database is. Domain code never sees
a Clerk concept.

## The flow

```
Clerk-issued JWT
  → Convex verifies it against convex/auth.config.ts
  → ctx.auth.getUserIdentity()
  → lib/authAdapter.ts:getAuthenticatedIdentity(ctx)
        returns { provider, subject, displayName?, email?, emailVerified? } | null
  → auth/model.ts:ensureAuthenticatedUser (mutation path)  → upserts the `users` row
    lib/access.ts:requireAuthenticatedUser (every other path) → looks the row up
  → organizationMemberships → role → ownership of every referenced entity
```

`auth.mutations.ensureUser` is the provisioning door: idempotent, argument-free, and keyed
on the indexed `(authProvider, authSubject)` pair. A client calls it once after sign-in.
There are **no Clerk webhooks** — provisioning on demand keeps Clerk-shaped payloads out of
domain code and keeps the provider swappable. Every other function assumes the row exists
and returns the generic not-found error if it does not.

`auth.queries.getCurrentUser` returns `{ _id, _creationTime, name?, email? }` and nothing
else. The handler maps the columns explicitly, so `authProvider` / `authSubject` cannot leak
into a client response by accident and a schema change that matters here is a compile error.

## Identity rules

**`authProvider` stores the full normalized token issuer**, not a prettified label like
`'clerk'`. Subjects are only unique *within* an issuer, so the issuer is the namespace half
of the identity key. An earlier implementation pattern-matched the hostname and collapsed
distinct Clerk instances into one subject space — an account-takeover vector, and a
regression test now pins the behaviour: the same subject under two issuers resolves to two
distinct users. Normalization is exactly one rule, a stripped trailing slash.

The consequence is worth stating plainly: **changing an issuer URL is an identity
migration, not a config tweak.** Moving Clerk to a custom domain changes every user's
identity key. No migration tooling exists for this.

**Email is persisted only when the provider reports it verified** (`emailVerified === true`),
and it is never an identity key. Unverified addresses are dropped rather than stored, so a
future invite flow cannot be pre-claimed by an attacker-supplied address. Name and email are
refreshed from provider claims on each `ensureUser` call, and only when they actually
changed.

**The `fva` (factor verification age) claim is not available.** Clerk excludes it from the
Convex identity, so the backend cannot see how recently a factor was verified. Any future
step-up authentication must be done with Clerk's frontend reverification; no server-side
permission may be designed around factor age.

## Exactly which files are Clerk-specific

| File | Clerk knowledge |
| --- | --- |
| `apps/convex/convex/auth.config.ts` | The provider block: `{ domain: process.env.CLERK_JWT_ISSUER_DOMAIN, applicationID: 'convex' }`. `applicationID` is the audience Convex requires on the token, which Clerk's `convex` JWT template sets |
| `apps/convex/convex/lib/authAdapter.ts` | Maps `ctx.auth.getUserIdentity()` (`issuer`, `subject`, `name`, `email`, `emailVerified`) onto the neutral identity type, and normalizes the issuer |

That is the complete list. `lib/access.ts`, `auth/model.ts`, every domain `model.ts`, the
schema, and the tests are provider-neutral: they see `provider` and `subject` strings and
nothing else. The environment variable name `CLERK_JWT_ISSUER_DOMAIN` also appears in
`README.md` and in this file; it is a name, not a coupling.

## Replacing Clerk

What a replacement must supply:

1. A JWT the Convex deployment can verify, declared in `auth.config.ts`. Convex's supported
   shape is `{ domain, applicationID }`; the replacement's issuer URL becomes `domain` and
   its audience becomes `applicationID`. The fail-loud `requiredEnv` guard should be kept —
   an unset issuer otherwise means "match nothing", silently.
2. A **stable** `issuer` and `subject` through `ctx.auth.getUserIdentity()`. Stability is the
   hard requirement: `(issuer, subject)` is the primary identity key and there is no
   remapping path.
3. Optionally the standard `name`, `email`, `email_verified` claims. Their absence degrades
   display data only.

Then update `getAuthenticatedIdentity` if the new provider needs different claim reads.
Nothing else changes.

What a replacement must *not* be relied on for: organizations, roles, memberships,
permissions, or any authorization decision. Those live in Convex tables and are ignored on
the token even if present.

**Not verified.** No provider other than Clerk has been wired up or tested. The adapter
boundary is small and every domain module type-checks against the neutral identity, but the
swap itself has never been exercised.

## Self-hosted considerations

Implemented and exercised:

- The deployment's identity provider is a single environment variable plus a two-field
  config object; nothing is hardcoded to a Clerk hostname.
- No Clerk webhook endpoint, no Clerk API calls, no Clerk SDK dependency in the backend
  (`convex` is the only runtime dependency of `apps/convex`).
- The Convex database is the sole authority for tenancy and authorization, so a deployment
  with a different identity provider loses no domain functionality.
- Development ran entirely against a **local, account-less Convex deployment**
  (`CONVEX_AGENT_MODE=anonymous`), so the backend has demonstrably been pushed, migrated,
  seeded and queried without a Convex cloud project. That mode is a Convex beta feature.

Not implemented, not verified, and not claimed:

- Running against a self-hosted Convex backend (the open-source `convex-backend`
  distribution) has never been attempted here. The anonymous local deployment is a CLI
  convenience, not the self-hosting story.
- No non-Clerk provider has been configured.
- No multi-deployment, migration, backup, or scaling behaviour has been measured. There are
  no benchmarks in this repository and none should be inferred.
- The identity-migration path described above (issuer change) does not exist as tooling.
