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

Leave `PRIAMO_ENABLE_SEED` **unset** on production. Section 6 covers the one case
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

### Podman: `ConnectionRefused` on every tarball

**Podman passes the host's proxy environment into the build; Docker does not.** If
`HTTP_PROXY`/`HTTPS_PROXY` point at a loopback address — any local proxy on
`127.0.0.1` — the build inherits them, and inside the container's network namespace
that address is the *container*, where nothing is listening. Step 7 then fails with
a wall of `error: ConnectionRefused downloading tarball …`, one line per dependency,
while the identical `docker build` succeeds. It reads as a podman bug and is not
one; `NO_PROXY=localhost,127.0.0.1` does not help, because the proxy address is the
destination here, not the thing being bypassed.

When the host has direct egress — it does if `docker build` works — turn the
injection off:

```bash
podman build --http-proxy=false -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_CONVEX_URL=… \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=… \
  -t priamo-web:prod .
```

If the proxy really is the only route out, use `--network=host` instead, so the
loopback address reaches the host's proxy. Neither flag is something the Dockerfile
depends on; a CI or cloud build with direct egress needs neither.

## 4. Push the image to DigitalOcean Container Registry

App Platform can build from the repo instead — `dockerfile_path: apps/web/Dockerfile`
with the source directory left at the repo root — but pushing a registry image is
preferable: you deploy the exact image you tested, and you control the build args
directly rather than depending on how the platform forwards them.

Create the registry once, then authenticate. The registry name is globally unique
and becomes part of every image path:

```bash
doctl auth init                # once per machine; prompts for an API token
doctl registry create priamo   # once per account
doctl registry login
```

**Podman reads a different credentials file than `doctl` writes.** `doctl registry
login` writes `~/.docker/config.json`; podman prefers
`$XDG_RUNTIME_DIR/containers/auth.json` and only falls back to the Docker one. If a
push returns `401` under podman despite a successful `doctl registry login`,
authenticate podman directly — DOCR accepts a DigitalOcean API token as **both**
username and password:

```bash
podman login registry.digitalocean.com -u <do-api-token> -p <do-api-token>
```

Tag with the commit, not only a moving tag. Deploying the exact image you tested is
the whole reason to prefer the registry, and `:prod` alone gives that up — it also
leaves you unable to say which build is running:

```bash
SHA=$(git rev-parse --short HEAD)
REG=registry.digitalocean.com/priamo/priamo-web

podman tag priamo-web:prod "$REG:$SHA"
podman tag priamo-web:prod "$REG:prod"
podman push "$REG:$SHA"
podman push "$REG:prod"
```

Build on the architecture App Platform runs, `linux/amd64`. From an ARM machine add
`--platform linux/amd64` to the build in section 3: the registry accepts an arm64
image happily and the container then fails to start, which surfaces late and reads
as an application bug rather than an image built for the wrong platform.

### Registry storage

The free tier is **one repository and 500 MiB**. This image lands in the low
hundreds of MB, so a single tag fits and several do not; Basic is 5 GiB.

**Overwriting a tag does not reclaim its space.** The replaced manifest is retained
as an untagged layer until garbage collection runs, so pushing `:prod` a few times
exhausts the quota with what looks like one image:

```bash
doctl registry garbage-collection start
```

## 5. Run it

The image serves on port 3000 as a non-root user and exposes `/api/health`, which
answers `200 {"status":"ok"}`. Point the platform's health check there — **not** at
`/`, which answers `307` to the negotiated locale and reads as unhealthy.

On DigitalOcean App Platform, create the service from the image pushed in section
4 and set `CLERK_SECRET_KEY` as a runtime secret.

## 6. The statistics backfill — required for any pre-existing data

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

## 7. Verification checklist

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
