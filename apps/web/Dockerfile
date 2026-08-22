# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT, not apps/web: the console imports
# `@sancocho/convex` as a workspace package, so the Convex source has to be
# present for `next build` to resolve and transpile it.
#
#   podman build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_CONVEX_URL=https://<prod>.convex.cloud \
#     --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_... \
#     -t sancocho-web .

# ── build ──────────────────────────────────────────────────────────────────
FROM docker.io/oven/bun:1-alpine AS build
WORKDIR /app

# Manifests first so the dependency layer survives ordinary source edits.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/convex/package.json apps/convex/
COPY packages/shared/package.json packages/shared/
# `--linker=hoisted` is load-bearing, not a preference. Bun's default isolated
# linker builds a symlink store at `node_modules/.bun/<pkg>@<ver>/node_modules/`.
# Next's output tracing records the resolved real paths but does not carry the
# whole store into `.next/standalone`, so transitive packages (@swc/helpers is
# the first to bite) go missing and the image builds cleanly, then dies at
# startup with MODULE_NOT_FOUND. A hoisted tree traces correctly.
RUN bun install --frozen-lockfile --linker=hoisted

COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle by `next build`.
# Supplying them at container runtime does nothing — they must be here.
ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_TELEMETRY_DISABLED=1

# Fail here with a readable message rather than deep inside the React build,
# where a missing publishable key surfaces as an opaque prerender error.
RUN test -n "$NEXT_PUBLIC_CONVEX_URL" \
      || { echo 'build-arg NEXT_PUBLIC_CONVEX_URL is required'; exit 1; }; \
    test -n "$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" \
      || { echo 'build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required'; exit 1; }

RUN bun run --cwd apps/web build

# ── runtime ────────────────────────────────────────────────────────────────
FROM docker.io/library/node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S sancocho && adduser -S sancocho -G sancocho

# `output: 'standalone'` emits a server plus only the node_modules Next traced
# as reachable. Static assets and public/ are deliberately excluded from that
# trace, so they are copied separately.
COPY --from=build --chown=sancocho:sancocho /app/apps/web/.next/standalone ./
COPY --from=build --chown=sancocho:sancocho /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=sancocho:sancocho /app/apps/web/public ./apps/web/public

USER sancocho
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
