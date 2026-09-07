# Priamo web

The Priamo web application is a Next.js App Router workspace connected to the
existing Convex backend and Clerk. It carries the shared design system and the
organization workspace.

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

Open [http://localhost:3000](http://localhost:3000). Signed-out visitors can
sign in or create an account without making an authenticated Convex request.
After Clerk sign-in, the organization workspace calls
`auth/queries:getCurrentUser` to provision the application session.

## Design system

`docs/web-design.md` is the decision record: typography, palette, the status
vocabulary's colour and shape mapping, table and form conventions, the
pagination pattern, and the bento composition rules. Read it before building a
screen.

- Shared primitives: `components/ui/` (`Button`, `Panel`, `Bento`, `StatusChip`,
  `Table`, `Field`, `Skeleton`, `EmptyState`).
- Status → colour/shape maps: `lib/status.ts`, keyed off the backend unions so a
  new status is a compile error rather than an uncoloured chip.
- Tokens: `app/globals.css`. Dark is canonical; the light palette applies to
  viewers whose OS asks for light, and `data-theme` on `<html>` overrides both.
- Typefaces: Chivo and Chivo Mono, self-hosted through `next/font` in
  `app/fonts.ts`.
- `/[locale]` is the organization workspace, built from these primitives.

## Decisions

- **Next.js App Router** was selected because issue #37 needs path-segment locale
  routing, for which App Router and Next middleware provide native support.
- **Tailwind CSS v4** carries the token layer through CSS-first `@theme` in
  `app/globals.css`. There is no `tailwind.config.js`.
- **shadcn/ui** primitives are vendored into `components/ui/` and re-skinned onto
  our tokens. shadcn 4.x defaults to the `base-nova` style, which builds on Base
  UI (`@base-ui/react`) rather than Radix; that default was kept, and the reasons
  are recorded in `docs/web-design.md`.
- **Locale routing** will use `/es/...` (default) and `/en/...` in issue #37. This
  shell deliberately does not implement locale segments, middleware, or catalogs.
- The generated Convex API is imported as `api` from `@priamo/convex/api`. The
  workspace package export points directly to Convex's committed generated API,
  so the web app does not hand-write backend function signatures.
- **Internationalization** uses `next-intl` because it is App Router-native,
  supports path-segment locale routing, provides ICU interpolation/plurals, and
  type-checks message keys. Canonical locales are `es-CO` (default) and `en-US`;
  URL segments are deliberately shorter (`/es` and `/en`). The mapping lives only
  in `i18n/locales.ts`, so a future regional locale can gain a readable segment
  without rewriting URLs. Locale resolution is explicit choice, the canonical
  locale cookie, `Accept-Language`, then Spanish (`es-CO`)—never English as a
  last resort. Because locale routing uses this app's own `proxy.ts` rather than
  next-intl's middleware, `[locale]/layout.tsx` announces the resolved locale
  with `setRequestLocale` and `i18n/request.ts` accepts either a URL segment
  (`en`) or a canonical locale (`en-US`); without that, `/en` silently served
  Spanish.
- Translation catalogues cover UI chrome and code-owned vocabulary only.
  Tenant-authored service kind names, field labels/descriptions, select option labels,
  project names, and location names are stored and rendered exactly as entered.
  Built-in field labels are localized in the frontend by code-owned semantic
  type; an absent or unknown semantic type intentionally falls back to its
  stored label.
- Run `bun run i18n:check` from the repository root to verify catalogue parity.
