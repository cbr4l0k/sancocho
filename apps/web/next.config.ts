import path from 'node:path';

import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const nextConfig: NextConfig = {
  transpilePackages: ['@sancocho/convex'],

  /**
   * Hosts allowed to reach `next dev` through a tunnel (Cloudflare quick
   * tunnels, ngrok, a LAN address). Quick-tunnel hostnames are regenerated on
   * every restart, so this is read from the environment rather than committed:
   *
   *   ALLOWED_DEV_ORIGINS=foo-bar.trycloudflare.com bun run dev
   */
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),

  /**
   * Container deployment. `standalone` emits `.next/standalone/apps/web/server.js`
   * together with only the node_modules Next traced as reachable, so the runtime
   * image carries no build toolchain and no dev dependencies.
   *
   * The tracing root must be the workspace root: `@sancocho/convex` resolves
   * above `apps/web`, and without this Next would root the trace at `apps/web`
   * and silently drop those files from the standalone output.
   */
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
};

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

export default withNextIntl(nextConfig);
