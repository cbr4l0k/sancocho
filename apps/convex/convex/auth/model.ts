import type { MutationCtx, QueryCtx } from '../_generated/server';
import { getAuthenticatedIdentity } from '../lib/authAdapter';
import { unauthenticated } from '../lib/errors';

export async function ensureAuthenticatedUser(ctx: MutationCtx) {
  const identity = await getAuthenticatedIdentity(ctx);
  if (identity === null) {
    return unauthenticated();
  }

  const existingUser = await ctx.db
    .query('users')
    .withIndex('by_provider_subject', (q) =>
      q.eq('authProvider', identity.provider).eq('authSubject', identity.subject),
    )
    .unique();

  // Provider claims are the source of truth for name/email. Email is stored
  // only when the provider reports it verified, so later flows (e.g. invites)
  // can never key on an attacker-claimed address.
  const verifiedEmail = identity.emailVerified === true ? identity.email : undefined;

  if (existingUser === null) {
    return ctx.db.insert('users', {
      authProvider: identity.provider,
      authSubject: identity.subject,
      ...(identity.displayName === undefined ? {} : { name: identity.displayName }),
      ...(verifiedEmail === undefined ? {} : { email: verifiedEmail }),
    });
  }

  const updates = {
    ...(identity.displayName !== undefined && identity.displayName !== existingUser.name
      ? { name: identity.displayName }
      : {}),
    ...(verifiedEmail !== undefined && verifiedEmail !== existingUser.email
      ? { email: verifiedEmail }
      : {}),
  };
  if (Object.keys(updates).length > 0) {
    await ctx.db.patch(existingUser._id, updates);
  }

  return existingUser._id;
}

export async function getUserForCurrentIdentity(ctx: QueryCtx) {
  const identity = await getAuthenticatedIdentity(ctx);
  if (identity === null) {
    return null;
  }

  return ctx.db
    .query('users')
    .withIndex('by_provider_subject', (q) =>
      q.eq('authProvider', identity.provider).eq('authSubject', identity.subject),
    )
    .unique();
}
