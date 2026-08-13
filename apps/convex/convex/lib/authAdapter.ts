import type { QueryCtx } from '../_generated/server';

export type AuthenticatedIdentity = {
  provider: string;
  subject: string;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
};

type AuthenticationContext = Pick<QueryCtx, 'auth'>;

/**
 * Converts the configured provider's authenticated token into a stable,
 * provider-neutral identity.
 *
 * `provider` is the normalized token issuer (trailing slash stripped). Subjects
 * are only unique within an issuer, so the full issuer — not a prettified
 * label — is the namespace half of the `(authProvider, authSubject)` identity
 * key. Two issuers with colliding subjects therefore resolve to two distinct
 * users, never one. Consequence: changing an issuer URL (e.g. moving Clerk to
 * a custom domain) is an identity migration, not a config tweak.
 *
 * A replacement provider must configure Convex to verify its JWTs in
 * auth.config.ts and supply stable issuer + subject (and standard name /
 * email / email_verified claims when available) through
 * `ctx.auth.getUserIdentity()`. Nothing outside this file and auth.config.ts
 * may know provider specifics.
 */
export async function getAuthenticatedIdentity(
  ctx: AuthenticationContext,
): Promise<AuthenticatedIdentity | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return null;
  }

  return {
    provider: normalizeIssuer(identity.issuer),
    subject: identity.subject,
    ...(identity.name === undefined ? {} : { displayName: identity.name }),
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.emailVerified === undefined ? {} : { emailVerified: identity.emailVerified }),
  };
}

function normalizeIssuer(issuer: string): string {
  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
}
