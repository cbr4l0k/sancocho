import type { ArchivalStatus, ProviderClaimState } from './status';

/** The Provider-level claim action a row offers, or none at all. */
export type ProviderClaimAffordance = 'invite' | 'revokeClaim' | 'none';

/**
 * Which claim action a Provider row may offer.
 *
 * Claim state and archival status are independent as display, but an invitation
 * is not a third Provider state. Its withdrawal action is rendered from the
 * loaded invitation itself, even when the Provider is already claimed.
 *
 * `providers/model.ts` `inviteProviderOrganization` refuses an archived Provider
 * outright with `providerArchived`, so only an active, unclaimed Provider may
 * offer invite. Revoking an existing claim remains available after archival.
 *
 * This is an AFFORDANCE, never authorization: the server re-decides every one
 * of these, and hiding a button protects nothing.
 */
export function providerClaimAffordance(
  status: ArchivalStatus,
  claimState: ProviderClaimState,
): ProviderClaimAffordance {
  if (claimState === 'claimed') return 'revokeClaim';
  return status === 'active' ? 'invite' : 'none';
}
