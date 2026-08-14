import { invalidInput } from './errors';

// The Convex runtime exposes deployment environment variables on `process.env`.
// Declared locally because this package deliberately carries no Node type
// dependency; only the one member the seed guard reads is described.
declare const process: { env: Record<string, string | undefined> };

/**
 * Deployment opt-in for every provisioning entry point whose effect cannot be
 * undone.
 *
 * Seeding is irreversible in both directions that matter: it consumes the
 * deployment-wide-unique organization slug (no deleteOrganization exists) and
 * permanently squats built-in field keys for every tenant. A stray
 * `convex run --prod seed/mutations:seedDemonstrationData` must therefore be
 * refused rather than trusted, so the target deployment has to say yes first:
 *
 *   bunx convex env set SANCOCHO_ENABLE_SEED true      (see package.json `seed:enable`)
 *
 * Convex reads `process.env` from the DEPLOYMENT's environment variables, not
 * the developer's shell, which is what makes the opt-in per-deployment.
 *
 * It lives here rather than beside the seed mutations because
 * `fields/mutations.ts:createBuiltinFieldDefinition` is a fourth door onto the
 * same irreversible effect — a built-in key, once created, squats that key in
 * every tenant's namespace forever — and it must be guarded by the same switch.
 */
export const seedOptInVariable = 'SANCOCHO_ENABLE_SEED';

export function assertSeedingEnabled(): void {
  if (process.env[seedOptInVariable] !== 'true') {
    return invalidInput(`Seeding is disabled on this deployment; set ${seedOptInVariable}=true to allow it`);
  }
}
