# Deployment

How to get priamo in front of real users. Written as a runbook: follow it top to
bottom the first time, and use the checklist at the end for every deploy after.

## What runs where

Only the console is hosted by you. The other two pieces are managed services.

| Piece | Runs on | Notes |
| --- | --- | --- |
| Convex backend | `*.convex.cloud` | Production deployment already exists: `giant-avocet-654` |
| Clerk auth | Clerk | Production instance needs your own domain |
| Next.js console | Your host (DigitalOcean) | The container image from `apps/web/Dockerfile` |

"Deploy priamo" therefore means: push the backend to Convex, point the console at
production Clerk and Convex, and run the console container somewhere.

## Domains

The worked example uses `priamo.sybil-lat.org` for the console. Clerk derives its
own subdomains beneath whatever application domain you give it, so the choice of
console subdomain determines all the rest.

| Record | Host | Points to |
| --- | --- | --- |
| CNAME | `priamo` | your host's app hostname |
| CNAME | `clerk.priamo` | Clerk Frontend API |
| CNAME | `accounts.priamo` | Clerk Account Portal |
| CNAME | `clkmail.priamo` | Clerk mail |
| CNAME | `clk._domainkey.priamo` | Clerk DKIM 1 |
| CNAME | `clk2._domainkey.priamo` | Clerk DKIM 2 |

Copy Clerk's targets verbatim — the mail and DKIM values carry an instance-specific
hash. Convex needs no DNS record; `giant-avocet-654.convex.cloud` is fine and is one
less thing to break.

DNS propagation is the only step here with real waiting in it. Start it first.

## 1. Clerk production instance

1. Create the production instance with application domain `priamo.sybil-lat.org`.
2. Add the five CNAMEs above and wait for Clerk to verify them.
3. **Create a JWT template named `convex`.** This is the step that gets missed.
   `apps/convex/convex/auth.config.ts` pins `applicationID: 'convex'`, and JWT
   templates are per-instance — a fresh production instance has none. Without it,
   sign-in appears to work and then every single query fails for an authenticated
   user, with nothing in the UI explaining why.
4. Note the production **publishable key** (`pk_live_…`) and **secret key**
   (`sk_live_…`).

The production issuer will be `https://clerk.priamo.sybil-lat.org`.

## 2. Convex production

Deploy the backend and tell it which issuer to trust:

```bash
cd apps/convex
bunx convex deploy                                    # pushes to giant-avocet-654
bunx convex env set CLERK_JWT_ISSUER_DOMAIN https://clerk.priamo.sybil-lat.org --prod
```

`auth.config.ts` throws when that variable is unset, so a missing value fails the
push rather than silently matching no issuer. That is deliberate — do not work
around it.

Leave `PRIAMO_ENABLE_SEED` **unset** on production. Section 5 covers the one case
that needs it, and why it is not left on.

## 3. Build the console image

`NEXT_PUBLIC_*` values are inlined into the client bundle by `next build`. They are
**build arguments, not runtime environment** — setting them on the running container
does nothing at all. A production console needs a production build.

```bash
# from the repo root — the build context must be the root, not apps/web,
# because the console imports @priamo/convex as a workspace package
podman build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_CONVEX_URL=https://giant-avocet-654.convex.cloud \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_... \
  -t priamo-web:prod .
```

The Dockerfile fails fast with a readable message if either build arg is missing,
rather than surfacing it as an opaque prerender error deep in the React build.

Runtime environment the container still needs:

- `CLERK_SECRET_KEY=sk_live_…`

Behind a proxy that only listens on the host loopback, add `--network=host` to the
build. That is a local-network workaround, not something the Dockerfile depends on;
a CI or cloud build with direct egress does not need it.

## 4. Run it

The image serves on port 3000 as a non-root user and exposes `/api/health`, which
answers `200 {"status":"ok"}`. Point the platform's health check there — **not** at
`/`, which answers `307` to the negotiated locale and reads as unhealthy.

On DigitalOcean App Platform, either push the image to DigitalOcean Container
Registry and deploy from there, or build from the repo with `dockerfile_path:
apps/web/Dockerfile` and the source directory left at the repo root. The registry
path is preferable: you deploy the exact image you tested, and you control the build
args directly rather than depending on how the platform forwards them.

## 5. The statistics backfill — required for any pre-existing data

**Read this before showing anyone the dashboard.**

Statistics are served from maintained counters that are updated by the same
mutations that write the underlying facts. Counters therefore only know about
writes made *after* the counters existed. Any organization whose data predates
them — imported records, a seeded demo, anything created before this schema —
reports **zero across every statistic, with no error and no hint why**. It looks
like a broken product rather than a missing migration step.

A brand-new production deployment with no data needs nothing here. The moment you
import or seed anything, run the backfill for every organization:

```bash
cd apps/convex
ORG=<organizationId>
for PHASE in clear events projects recipes locations; do
  CURSOR=null
  while :; do
    OUT=$(bunx convex run statistics/mutations:backfillOrganizationCounters \
      "{\"organizationId\":\"$ORG\",\"phase\":\"$PHASE\",\"cursor\":$CURSOR}" --prod)
    echo "$OUT" | grep -q '"isDone": true' && break
    CURSOR="\"$(echo "$OUT" | grep -o '"continueCursor": *"[^"]*"' | sed 's/.*: *"//;s/"//')\""
  done
done
```

Run `clear` first, then each entity phase, feeding the returned cursor back until
the phase reports `isDone`. Each call processes at most 100 indexed rows, so it is
safe on large tenants. Run it in a maintenance window: normal writes must not race
a rebuild that resets its destination rows.

> **The backfill is gated by `PRIAMO_ENABLE_SEED`, and so is the destructive
> tenant reset.** Turning the flag on to run a backfill also opens
> `seed/reset:resetTenantOperations`, which hard-deletes an organization's events,
> recipes, and locations. Enable it, run the backfill, and turn it off again in the
> same sitting:
>
> ```bash
> bunx convex env set PRIAMO_ENABLE_SEED true --prod
> # ... run the backfill ...
> bunx convex env remove PRIAMO_ENABLE_SEED --prod
> ```
>
> Leaving it on is not a small risk. It also permits seeding, which consumes the
> deployment-wide-unique organization slug and permanently squats built-in field
> keys for every tenant — none of which can be undone.

## 6. Verification checklist

Run through this after every production deploy.

- [ ] `https://priamo.sybil-lat.org/api/health` returns `200 {"status":"ok"}`.
- [ ] `/` returns `307` to a locale (`/es/projects` from a Spanish browser,
      `/en/projects` from an English one — both are correct; the client's browser
      language decides what they see).
- [ ] Sign-in completes, and a signed-in user sees data rather than an empty shell.
      An empty shell almost always means the `convex` JWT template is missing or
      `CLERK_JWT_ISSUER_DOMAIN` does not match the issuer.
- [ ] The browser console is clean on at least the landing page and one signed-in
      screen.
- [ ] Statistics show non-zero numbers for an organization that has services. If
      they are all zero and services exist, the backfill has not been run.
- [ ] Switching locale changes the chrome and leaves tenant-authored names
      untouched.

## Known traps

**Clerk's Spanish is Mexican and carries a typo.** `@clerk/localizations` ships
`es-MX` as a community contribution that Clerk explicitly disclaims, and it renders
"Este campo es rquerido" on the sign-in screen. Override it with a corrected
`localization` prop on `ClerkProvider` before showing the app to a Spanish-speaking
client.

**A dev instance shows development banners and enforces usage caps.** Fine for
internal testing, visibly unfinished in front of a customer.

**There is no member-invite email.** Invitations exist in the database and appear
in-app on the recipient's next sign-in; nothing is mailed. Tell invitees
out-of-band.

**`bun run codegen` pushes to whichever Convex deployment the working tree points
at.** Running it from a feature branch or a worktree deploys that branch's schema to
your dev deployment. It cannot touch production without `--prod`, but it does mean
the dev deployment reflects the last branch that ran codegen, not `main`.
