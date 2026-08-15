# Sancocho web

The Sancocho web application is a Next.js App Router shell connected to the
existing Convex backend and Clerk. It intentionally contains no product UI.

## Prerequisites

- Bun
- A configured Convex deployment for this repository
- A Clerk application with the Convex integration enabled

## Environment

Copy `.env.local.example` to `.env.local` and set the values:

```sh
cp .env.local.example .env.local
```

`NEXT_PUBLIC_CONVEX_URL` is the deployment URL shown by the Convex dashboard or
CLI for the configured deployment. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` comes
from the API Keys page in the Clerk dashboard. Configure the same Clerk
Frontend API URL as `CLERK_JWT_ISSUER_DOMAIN` in the Convex deployment; the
backend's `auth.config.ts` uses the `convex` application ID.

## Run locally

From the repository root:

```sh
bun install
bun run --cwd apps/web dev
```

Open [http://localhost:3000](http://localhost:3000). Signed-out visitors see a
placeholder without making an authenticated Convex request. After Clerk sign-in,
the page calls `auth/queries:getCurrentUser` to confirm the live Convex
connection.

## Decisions

- **Next.js App Router** was selected because issue #37 needs path-segment locale
  routing, for which App Router and Next middleware provide native support.
- **Tailwind CSS v4** is installed and its stylesheet is ready; issue #21 owns the
  component system and visual design.
- **Locale routing** will use `/es/...` (default) and `/en/...` in issue #37. This
  shell deliberately does not implement locale segments, middleware, or catalogs.
- The generated Convex API is imported as `api` from `@sancocho/convex/api`. The
  workspace package export points directly to Convex's committed generated API,
  so the web app does not hand-write backend function signatures.
