import { afterEach, beforeEach } from 'vitest';

// Tests live outside convex/, so convex-test needs the function modules globbed
// explicitly. The extglob pattern from the convex-test docs (`!(*.*.*)*.*s`)
// matches nothing under vitest 4's glob implementation; the array form with a
// negative `.d.ts` exclude is equivalent.
export const modules = import.meta.glob([
  '../convex/**/*.{js,ts}',
  '!../convex/**/*.d.ts',
]);

// Deployment environment variables reach Convex functions through `process.env`;
// declared locally because this package carries no Node type dependency.
declare const process: { env: Record<string, string | undefined> };

export const seedOptInVariable = 'PRIAMO_ENABLE_SEED';

/**
 * Call at module scope in any test file that drives an irreversible provisioning
 * mutation: the seed entry points, or `createBuiltinFieldDefinition`, which is
 * guarded by the same switch because a built-in key squats that key in every
 * tenant's namespace forever.
 */
export function enableSeedMutations(): void {
  beforeEach(() => {
    process.env[seedOptInVariable] = 'true';
  });
  afterEach(() => {
    delete process.env[seedOptInVariable];
  });
}
