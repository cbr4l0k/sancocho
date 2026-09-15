import { expect, test } from 'bun:test';

import { providerClaimAffordance } from './provider-claim';

test('only an unclaimed active Provider offers invite-to-claim', () => {
  expect(providerClaimAffordance('active', 'unclaimed')).toBe('invite');
  // Every other combination must offer something else, or nothing.
  expect(providerClaimAffordance('archived', 'unclaimed')).not.toBe('invite');
  expect(providerClaimAffordance('active', 'claimed')).not.toBe('invite');
  expect(providerClaimAffordance('archived', 'claimed')).not.toBe('invite');
});

test('an archived unclaimed Provider offers no claim action, because the server refuses the invite', () => {
  // `inviteProviderOrganization` answers `providerArchived` here, so an offered
  // button could only ever produce an error message.
  expect(providerClaimAffordance('archived', 'unclaimed')).toBe('none');
});

test('revoking a claim survives archival, because withdrawing access must', () => {
  expect(providerClaimAffordance('archived', 'claimed')).toBe('revokeClaim');
});
