import type { AuthConfig } from 'convex/server';

declare const process: {
  env: {
    CLERK_JWT_ISSUER_DOMAIN: string | undefined;
  };
};

// Fail loudly at config evaluation instead of matching no issuer silently.
// (The Convex CLI also rejects pushes with the variable unset.)
function requiredEnv(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export default {
  providers: [
    {
      domain: requiredEnv(process.env.CLERK_JWT_ISSUER_DOMAIN, 'CLERK_JWT_ISSUER_DOMAIN'),
      applicationID: 'convex',
    },
  ],
} satisfies AuthConfig;
