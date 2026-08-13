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

## Organization role policy

Roles are ordered `owner > admin > planner > operator > viewer`. Every
organization operation proves an app-user membership first; a missing
membership, missing organization, or insufficient role returns the same
generic not-found/inaccessible error.

| Operation | Minimum role | Additional policy |
| --- | --- | --- |
| View organization and members | viewer | Membership required. |
| Update organization name | admin | Organization slug is immutable for now. |
| Add members | admin | Only owners may grant the owner role. |
| Change member roles | admin | Only owners may grant or revoke owner. |
| Remove members | admin | Removing an owner requires owner role. |
| Demote or remove an owner | owner | The final owner can never be demoted or removed. |

Known policy notes:

- Organization slugs are a deployment-wide namespace, so a slug conflict at
  creation necessarily reveals that *some* organization owns the slug (never
  which one). This is the only intentional cross-tenant signal.
- `addMember` currently attaches an existing user id directly, with no consent
  step; a verified-email invite flow should replace it as the user-facing path
  (tracked in issue #5's close comment).
