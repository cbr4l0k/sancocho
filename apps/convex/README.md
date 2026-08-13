# Convex backend

## Authentication providers

Only `convex/auth.config.ts` and `convex/lib/authAdapter.ts` are Clerk-specific.
To swap providers, configure Convex JWT verification in `auth.config.ts` and update
the adapter to map `ctx.auth.getUserIdentity()` into `{ provider, subject,
displayName?, email?, emailVerified? }`. The replacement must provide stable issuer
and subject values, plus standard name/email claims when available. The users,
access, and domain modules remain provider-neutral.

Identity notes:

- `authProvider` stores the full normalized token issuer — subjects are only
  unique within an issuer, so the issuer is the namespace. Changing an issuer
  URL (e.g. moving Clerk to a custom domain) is an identity migration.
- Email is persisted only when the provider reports it verified, and it is
  never an identity key.
- User provisioning (`ensureUser`) is deliberately outside the audit log: the
  audit log is organization-scoped and a user does not belong to an org at
  provisioning time.
