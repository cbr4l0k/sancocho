# Web design — Sancocho operations console

The visual decision record for `apps/web`. Everything here is settled: an
implementer building a product screen should be able to work from this document
plus the primitives in `apps/web/components/ui/` without inventing anything.

Issue #21 owns this document, the token layer, the shared primitives, and the
demonstration page at `/[locale]`. It deliberately builds **no product screens**.

---

## 1. The idea

**A calm operations console, not a dashboard.**

Sancocho coordinates ground transport for events: people read it at 05:00 in an
operations room, at density, under time pressure. The interface is clean, dark,
and modern: a neutral near-black ground, generously rounded cards and pill
controls, strong type hierarchy, generous breathing room, and colour used
sparingly. Statuses are encoded by **shape first and colour second**, and
numbers use tabular figures so columns align without effort. This direction is
deliberately less textured than the previous one.

Dark is canonical. Light is a separate clean neutral palette, not an inverted
screen.

### What this rules out

- Decoration that competes with data. There is exactly one filled accent control
  per view, and status colour appears only inside chips and markers.
- Attention-seeking motion. Two animations exist in the whole system (§9).
- Fixed-width labels and single-line truncation, which Spanish breaks (§3).

---

## 2. Component approach

**shadcn/ui, vendored and re-skinned.**

`bunx --bun shadcn@latest init -d` was run inside `apps/web`; `components.json`,
`lib/utils.ts` (`cn`) and the dependency set it installed are kept. Every
component it generated was then rewritten against our tokens — none of shadcn's
default palette, radii or type survives.

**Deviation worth recording:** shadcn 4.x now defaults to the `base-nova` style,
which builds on **Base UI** (`@base-ui/react`) rather than Radix. Base UI is the
Radix team's successor library and is what the CLI ships today, so it was kept
rather than forced back to Radix. Practically it buys us the same thing the
original decision asked for: `Field.Root`/`Label`/`Description`/`Error` wire
`aria-describedby`, `aria-invalid` and touched/dirty/valid state for free, and
`Button` keeps correct disabled semantics through the `render` prop.

Dependencies added: `@base-ui/react`, `class-variance-authority`, `clsx`,
`tailwind-merge`. The CLI also added `lucide-react`, `tw-animate-css` and
`shadcn` as runtime dependencies; the first two are unused and were removed, and
`shadcn` was moved to `devDependencies`. It also imported
`@import "shadcn/tailwind.css"`, which does not exist in the published package —
removed with the rest of the generated stylesheet.

No icon library is installed. The handful of marks the system needs (status
shapes, empty-state glyphs) are drawn in CSS, so they inherit `currentColor` and
the token palette and cost nothing.

Primitives live in **`apps/web/components/ui/`**; token-keyed logic that is not a
component lives in **`apps/web/lib/`**.

---

## 3. Typography

| Role | Family | Notes |
| --- | --- | --- |
| Interface | **Chivo** (variable, 300–900) | `--font-sans` |
| Numerals, identifiers, keys, timestamps | **Chivo Mono** (variable) | `--font-mono` |

Both are by **Omnibus-Type**, Buenos Aires. They were drawn for Spanish first,
so `á é í ó ú ñ ü` and the `¿ ¡` punctuation are original outlines rather than
composed accents — they hold at 11px and at weight 800, and the mono cut keeps
its accents inside the advance width instead of clipping them. Chivo is a
squared grotesque with signage ancestry, which is exactly the register we want;
Chivo Mono is its matching monospace, so the console does not read as two
unrelated typefaces stapled together.

Both are loaded through `next/font/google` in `apps/web/app/fonts.ts`, which
downloads and self-hosts the files at build time — no runtime CDN request or
layout shift. `subsets: ['latin', 'latin-ext']` is requested explicitly: the
default `latin` subset covers Colombian Spanish but drops the wider Latin range
a multi-tenant customer list will eventually hold. A CSP has not yet been
implemented and remains an open security-hardening item.

**Banned:** Inter, Roboto, Arial, `system-ui` stacks, Space Grotesk.

### Type scale

Defined as Tailwind theme tokens in `app/globals.css`; use the utility, never a
raw size.

| Token | Size | Line height | Use |
| --- | --- | --- | --- |
| `text-micro` | 11px / 600 / +0.09em | 16px | Chips, table headers, eyebrows, field readout labels |
| `text-xs` | 12px | 18px | Metadata, descriptions, footers, mono cells |
| `text-sm` | 13px | 20px | Table body, controls, dense body copy |
| `text-base` | 14px | 23px | Default body |
| `text-lg` | 17px / 700 | 24px | Panel titles |
| `text-xl` | 22px / -0.015em | 28px | Larger heading |
| `text-2xl` | 30px / -0.02em | 34px | Secondary metrics |
| `text-display` | `clamp(2rem, 1.2rem + 2.4vw, 3rem)` / -0.025em | 1.05 | Page and focal-panel title |

Weights in use: 400 body, 500 controls and emphasis, 600 micro labels, 700 panel
titles, 800 display titles. Nothing lighter than 400 — thin weights lose the
accents at these sizes.

`font-variant-numeric: tabular-nums` is set on `html`, so every numeric column
aligns whether or not it is mono.

### Spanish is the sizing constraint

Spanish strings run 15–30% longer than English ("Cancelar el servicio" against
"Cancel"; "Versiones de receta" against "Recipe versions"). Therefore:

- **Buttons** fix height, never width. `whitespace-nowrap` plus content-driven
  width means a long label makes a wider button, never a clipped one.
- **Table headers** wrap and align to the bottom of the header row
  (`align-bottom`). A two-line header is normal and correct.
- **Chips** are `max-w-full` and their labels wrap in the flow of a chip row.
- **Field labels** sit *above* their control. A side-by-side label needs a fixed
  label column, and a fixed column is the first thing Spanish breaks.
- **Nothing truncates.** No `text-ellipsis` anywhere in the primitives. If a
  string is too long for its box, the box grows or the text wraps.

Always design and review against the Spanish string, then check English.

---

## 4. Palette

Tokens are CSS custom properties prefixed `--sc-` and exposed to Tailwind via
`@theme inline` in `app/globals.css`. `inline` is what keeps the utility
referencing the variable, so one stylesheet serves both themes.

`:root` carries the **dark** palette — the canonical one, and the fallback if
theme resolution fails at all. `@media (prefers-color-scheme: light)` swaps to
the light palette for viewers whose OS asks for it, and `[data-theme='light' |
'dark']` on `<html>` overrides both. Nothing is stamped on `<html>` today; a
future theme toggle sets that attribute and needs no other change.

### Roles

| Token | Utility | Dark | Light | Role |
| --- | --- | --- | --- | --- |
| `--sc-ground-0` | `bg-ground-0` | `#0a0a0a` | `#fafafa` | Page ground |
| `--sc-ground-1` | `bg-ground-1` | `#141414` | `#ffffff` | Panel surface |
| `--sc-ground-2` | `bg-ground-2` | `#1c1c1c` | `#f5f5f5` | Raised, hover, nested panel |
| `--sc-ground-3` | `bg-ground-3` | `#242424` | `#ebebeb` | Table headers, control tracks, skeletons |
| `--sc-well` | `bg-well` | `#060606` | `#f0f0f0` | Sunken text inputs |
| `--sc-line` | `border-line` | `#262626` | `#e5e5e5` | Default hairline |
| `--sc-line-strong` | `border-line-strong` | `#343434` | `#d4d4d4` | Structural edges, focal-panel border |
| `--sc-ink` | `text-ink` | `#f5f5f5` | `#171717` | Primary text |
| `--sc-ink-2` | `text-ink-2` | `#a3a3a3` | `#525252` | Secondary text, table body |
| `--sc-ink-3` | `text-ink-3` | `#737373` | `#737373` | Labels, metadata, placeholders |
| `--sc-accent` | `bg-accent` / `text-accent` | `#f9c50f` | `#f9c50f` | Single accent and primary action |
| `--sc-accent-hi` | `bg-accent-hi` / `text-accent-hi` | `#ffd94a` | `#ffd94a` | Accent hover |
| `--sc-accent-ink` | `text-accent-ink` | `#1a1400` | `#1a1400` | Text on an accent fill |
| `--sc-focus` | `outline-focus` | `#7cc4ff` | `#0b74d1` | Focus ring only |
| `--sc-tone-mute` | `text-tone-mute` | `#8f8f8f` | `#6b6b6b` | Neutral status tone |
| `--sc-tone-hold` | `text-tone-hold` | `#7aa7e8` | `#2f6fc4` | Waiting status tone |
| `--sc-tone-go` | `text-tone-go` | `#4ade80` | `#15803d` | Good-standing status tone |
| `--sc-tone-live` | `text-tone-live` | `#2dd4bf` | `#0d9488` | Active status tone |
| `--sc-tone-done` | `text-tone-done` | `#5b9e78` | `#3f7d5f` | Closed-well status tone |
| `--sc-tone-stop` | `text-tone-stop` | `#f87171` | `#dc2626` | Stopped status tone |
| `--sc-tone-shelf` | `text-tone-shelf` | `#5f5f5f` | `#787878` | Filed-away status tone |
| `--sc-shadow-panel` | `shadow-[var(--sc-shadow-panel)]` | `0 1px 2px 0 rgb(0 0 0 / 0.4)` | `0 1px 2px 0 rgb(0 0 0 / 0.1)` | Panel shadow |
| `--sc-radius-panel` | `rounded-panel` | `20px` | `20px` | Panels |
| `--sc-radius-input` | `rounded-input` | `12px` | `12px` | Inputs and inset panels |
| `--sc-radius-pill` | `rounded-pill` | `999px` | `999px` | Controls and chips |

The page ground is a flat neutral fill. There is no decorative overlay, radial
pool, panel inset highlight, or accent stripe on focal panels.

**Accent rule: text on `--sc-accent` or `--sc-accent-hi` is always
`--sc-accent-ink` (`#1a1400`), never white.** Yellow belongs to the accent
alone; no status tone may be yellow. Focus is cool blue and belongs to no
status, so it cannot be mistaken for state and state cannot be mistaken for
focus.

### Discipline

Colour is rationed: **large areas are ground and ink only**. The accent appears
on at most one filled control per view. Status tones appear only inside chips
and markers, which are small. If a screen ever looks colourful, something has
been coloured that should not have been.

---

## 5. Status vocabulary → colour and shape

Owned by **`apps/web/lib/status.ts`**, rendered by
`components/ui/status-chip.tsx`. The catalogues own the words; this module owns
the visuals, mapped **by key**.

Two independent channels:

- **Shape = lifecycle phase.** The colour-blind-safe channel, drawn in CSS. Shape
  is shared across sets: a hollow ring means "provisional" whether it is a
  project, a recipe, a version or a service.
- **Tone = disposition.** How an operator should feel about it. `completed` and
  `archived` are both terminal (square) but tell you different things.

| Shape | Meaning | Tone | Meaning |
| --- | --- | --- | --- |
| `ring` hollow circle | Provisional, nobody has committed | `mute` grey | Neutral |
| `bar` upright tick | Scheduled, awaiting confirmation | `hold` blue | Waiting |
| `diamond` | Committed | `go` green | In good standing |
| `dot` solid circle | Live and normal | `live` teal | Needs attention now |
| `pulse` dot with halo | Under way right now | `done` green | Closed well |
| `square` | Terminal | `stop` red | Stopped / voided |
| `cross` | Voided deliberately | `shelf` grey | Filed away |

### The maps

| Set | Member | Shape | Tone |
| --- | --- | --- | --- |
| project | `draft` | ring | mute |
| | `active` | dot | go |
| | `completed` | square | done |
| | `archived` | square | shelf |
| recipe | `draft` | ring | mute |
| | `active` | dot | go |
| | `archived` | square | shelf |
| recipe version | `draft` | ring | mute |
| | `published` | dot | go |
| | `retired` | square | shelf |
| service (backend `Event`) | `draft` | ring | mute |
| | `planned` | bar | hold |
| | `confirmed` | diamond | go |
| | `active` | pulse | live |
| | `completed` | square | done |
| | `cancelled` | cross | stop |
| archival (fields, locations) | `active` | dot | go |
| | `archived` | square | shelf |

### Why it cannot silently break

Every map is `as const satisfies Record<Union, StatusToken>` where the union is
derived from the backend validator (`typeof eventStatusValidator.type`, imported
with `import type` from `@sancocho/convex/validators`). A status added in
`apps/convex/convex/validators/index.ts` fails `tsc` in `lib/status.ts` — it
cannot ship as an uncoloured chip.

Nothing switches on a raw status string. `StatusChip` takes a **discriminated
union** (`{ kind: 'service'; status: EventStatus } | …`), so
`<StatusChip kind="recipe" status="planned" />` — an easy mistake, since several
sets share member names — does not compile. Each token also carries its
catalogue path as a literal (`labelKey`), so `t()` never receives a key built by
string concatenation.

The ordered arrays (`serviceStatuses`, …) exist for legends and future filters.
They are written out because display order is a design decision (least settled →
most settled), and a `CoversExactly` type assertion makes a missing or invented
member a compile error there too.

### Domain vocabulary

The backend's `Event` is called a **Service / Servicio** in the interface. Code
says `Event`; every user-visible string says Service. `serviceStatusTokens` is
keyed by the backend's `EventStatus` and named for the UI.

---

## 6. Tables, lists and pagination

### Pagination: cursor "load more", not numbered pages

**Decision: accumulate pages behind a single "load more" control.**

Reasons, in order of weight:

1. **The backend has no total.** Public list queries are Convex-paginated by
   design (I6) and return `{ page, continueCursor, isDone }`. "Page 7 of 41"
   would require a count query over a growing tenant dataset — precisely the
   unbounded read I6 forbids. A control that cannot be built honestly should not
   be designed.
2. **Cursors do not support random access.** Jumping to page 7 means replaying
   six cursors. Numbered controls would be lying about what they can do.
3. **Accumulating keeps every loaded row live.** `usePaginatedQuery` keeps
   pushing updates for pages already fetched, so a status that changes in row 3
   updates while the operator is looking at row 90. A page-swap control discards
   that subscription on every navigation.

`TableLoadMore` therefore takes the exact `PaginationStatus` union that
`usePaginatedQuery` returns, imported from `convex/react`:

| `status` | Renders |
| --- | --- |
| `LoadingFirstPage` | Nothing — `TableSkeletonRows` occupies the body instead |
| `CanLoadMore` | Loaded count + a ghost "Cargar más" button |
| `LoadingMore` | Loaded count + the same button, disabled, labelled "Cargando…" |
| `Exhausted` | Loaded count + "Fin de la lista" |

The count is reported as *rows in hand* (`{n} registros cargados`), never as a
fraction of an unknown total. The footer is `aria-live="polite"` so the count is
announced after a load. Default page size 25.

**A `Table` that assumes it has the whole dataset is wrong.** Client-side
filtering, where offered, filters *the rows already loaded* and says so in the
field description — it never pretends to have queried the server.

### Table conventions

- Wrapped in its own `overflow-x-auto`, so a wide table scrolls inside its panel
  and never moves the page.
- Header on `bg-ground-3`, `text-micro` uppercase, `align-bottom`, wrapping.
- Body rows `text-sm text-ink-2`, separated by a top hairline, `hover:bg-ground-2`
  (100ms). No zebra striping — it fights the status chips.
- Cells `align-top`, `px-3 py-2`.
- **Two alignments only:** `start` for text, `end` for numerals and quantities.
  Centred columns cannot be scanned down.
- `mono` on a cell for identifiers, keys, timestamps and quantities.
- The first cell of a row is a `TableRowHeaderCell` (`scope="row"`) — the thing
  the row is about, in `text-ink` and weight 500.
- Row density is fixed. There is no comfortable/compact toggle: the table is
  already compact, and two densities means every screen is designed twice.

---

## 7. Forms

- **Labels above the control**, left-aligned, `text-xs` weight 500 (§3).
- **Required is marked; optional is not.** Recipe fields are optional by default
  in the backend, so `required` is the exception worth flagging. The marker is
  an accent bullet plus a screen-reader-only "Obligatorio" — never colour alone.
- **Descriptions** sit under the control in `text-xs text-ink-3`, wired through
  `Field.Description` so they land in `aria-describedby`.
- **Validation is inline and below the control**, `text-tone-stop`, with
  `aria-invalid` on the control (`data-[invalid]:border-tone-stop`). Base UI's
  `Field.Root` owns touched/dirty/valid, so no screen hand-rolls "only show the
  error after blur". Default `validationMode` is `onSubmit` with re-validation on
  change afterwards; use `onBlur` for fields with expensive validation.
- **Explicit save, never autosave.** Recipes are versioned configuration and
  Events are operational records with an audit trail; a keystroke is not an
  intent to write. Forms end in a `primary` "Guardar" and a `ghost` "Cancelar",
  in that order.
- **Destructive actions confirm in a dialog**, never inline and never with an
  undo toast. The `danger` button variant stays outlined until hover — findable,
  never inviting. The dialog restates what will happen and names the record; the
  confirming button is the `danger` variant, and the dismissing button is the
  default focus. This matches the backend's stance that archival beats deletion:
  most "delete" affordances are in fact "archive", and the copy must say so.
- `FieldGroup` lays fields out in two columns from `sm`; `FieldSpanFull` for a
  field that owns a whole idea (notes, a location).
- `FieldReadout` renders a read-only value in the same rhythm as an editable
  field, so a detail view and its edit form do not reflow when switching.

---

## 8. Empty states, loading and errors

### Empty states — three, and only three

| Tone | When | Offers |
| --- | --- | --- |
| `empty` | The collection has no records | The action that creates the first one |
| `filtered` | Records exist, the filter matches none | Clearing the filter — never creation |
| `unavailable` | The backend said "not found or inaccessible" | Nothing |

One action at most. An empty state is not a menu.

### Invariant I9 — error presentation

The backend returns **one** generic error whether an entity is missing, was
deleted, or belongs to another tenant. `UnavailableState` is the single
presentation for it: "Contenido no disponible" over the catalogue's
`errors.notFound`, in both languages, with **no action**.

Specifically forbidden: a "request access" affordance, a "this may have been
deleted" hint, a support link that includes the record id, distinct copy for
404 vs 403, or any wording that differs between the two cases. Offering access
would confirm the record exists. Both catalogues are written so the Spanish and
the English are equally uninformative.

### Loading

- `Skeleton` stands in for content whose **shape is already known**: a table
  body, a metric, a row of fields. When the shape is unknown, render nothing
  rather than a guess.
- The container that holds skeletons carries `aria-busy="true"`; the skeletons
  themselves are `aria-hidden`.
- `TableSkeletonRows` takes the same column count as the header, so the
  placeholder lines up with the real table and nothing jumps on arrival.
- The sweep is deliberately slow (1.8s). A fast shimmer reads as an alarm in a
  console someone keeps open all day.
- Skeletons are for the **first** page. `LoadingMore` is communicated by the
  footer button, not by ghost rows.

---

## 9. Density, spacing, radii and motion

**Spacing** is Tailwind's 4px scale. In practice the system uses
`1 · 1.5 · 2 · 2.5 · 3 · 4 · 5` (4–20px) inside components. Bento gap is
16px. Panel content padding is 20px, increasing to 24px from `sm`; headers use
the same horizontal and top rhythm.

**Radii** are tokens:

| Token | Value | Use |
| --- | --- | --- |
| `rounded-panel` | 20px | Focal and module panels |
| `rounded-input` | 12px | Inputs and inset panels |
| `rounded-pill` | 999px | Controls and chips |

**Motion** — the whole system, exhaustively:

1. `sc-sweep`, 1.8s linear, the skeleton shimmer.
2. `sc-breathe`, 2.6s, the halo on an in-progress (`pulse`) status marker — the
   only thing on screen that moves on its own, and it means "this is happening
   right now".

Plus 100–150ms colour transitions on hover for buttons, rows and inputs. No
entrance animation, no staggered reveal, no parallax. A global
`prefers-reduced-motion` block reduces every animation and transition to
effectively zero.

---

## 10. Bento composition rules

`components/ui/bento.tsx` — twelve columns from `md` up, one column below it.
Twelve divides by 2, 3, 4 and 6, which is what lets a mixed row of large and
small modules align without bespoke widths.

- **Bento owns every gutter.** `BentoItem`s never set their own margins, so
  alignment cannot drift.
- **Column spans are declared, not styled**: `<BentoItem span={8}>`. The span →
  class map is a literal record, because Tailwind only sees literal class names.
- **Row spans cap at 3.** A taller module belongs on its own row.
- **One focal panel per screen.** `Panel emphasis="focal"` receives the stronger
  border; it does not receive a different fill, inset highlight, accent stripe,
  or larger radius. A screen with two focal panels has no focus. Everything else
  is `emphasis="module"`; `emphasis="inset"` is for a panel nested inside
  another.
- **Rows stretch.** Panels in a row share a height (`className="h-full"`), and
  footers pin to the bottom (`mt-auto` on `TableLoadMore`). Uneven card bottoms
  are what makes a bento look accidental.
- Composition guidance: lead with an 8/4 row (focal + one supporting module),
  follow with a 7/5 or 6/6 working row, and use 4/4/4 for peer modules. Do not
  exceed three modules per row; below `md` everything is one column in source
  order, so source order must be the reading order.

---

## 11. Primitives

`apps/web/components/ui/`:

| File | Exports |
| --- | --- |
| `button.tsx` | `Button` (`primary` / `secondary` / `ghost` / `danger` / `link`; `sm` / `md` / `lg` / `icon`; `selected` for segmented controls) |
| `panel.tsx` | `Panel`, `PanelHeader`, `PanelEyebrow`, `PanelTitle`, `PanelDescription`, `PanelActions`, `PanelBody`, `PanelBodyFlush`, `PanelFooter`, `PanelMetric` |
| `bento.tsx` | `Bento`, `BentoItem` |
| `status-chip.tsx` | `StatusChip` (`quiet` / `loud`), `StatusMarker` |
| `table.tsx` | `Table`, `TableHead`, `TableBody`, `TableRow`, `TableHeaderCell`, `TableCell`, `TableRowHeaderCell`, `TableSkeletonRows`, `TableLoadMore` |
| `field.tsx` | `Field`, `FieldLabel`, `FieldDescription`, `FieldControl`, `FieldError`, `FieldGroup`, `FieldSpanFull`, `FieldReadout` |
| `skeleton.tsx` | `Skeleton`, `SkeletonText` |
| `empty-state.tsx` | `EmptyState`, `UnavailableState` |

`apps/web/lib/status.ts` holds the status maps; `apps/web/lib/utils.ts` holds
`cn`. There is no speculative component kit — dialogs, menus, toasts, tabs and
the application shell arrive when a screen needs them, vendored from shadcn and
re-skinned the same way.

### Rules for anyone adding to this set

1. **No user-visible string literals in components.** Every word comes from
   `i18n/messages/{es-CO,en-US}.ts`, added to both plus `schema.ts`.
   `bun run i18n:check` enforces parity.
2. **No raw colours, sizes or radii.** Use the tokens; if a token is missing, add
   it to `@theme` in both palettes rather than reaching for a hex value.
3. Optional props are typed `?: T | undefined` — the app runs with
   `exactOptionalPropertyTypes`.
4. Native HTML attributes that clash with a design prop (`align` on `<td>`) are
   `Omit`ted from the prop type rather than intersected into `never`.
5. Never `any`, no unsafe assertions, no `@ts-ignore`.

---

## 12. Deliverable

The deliverable is the shared primitives and their documented contracts, not a
demonstration page. Product screens compose these primitives with real Convex
data and authenticated states as they are introduced; the primitives remain
small, accessible, token-driven, and independently reusable.

---

## 13. Deferred

- **Theme toggle** — the tokens and the `data-theme` override are in place; the
  control and its persistence are not.
- **Dialog, menu, select, combobox, toast, tabs** — vendor from shadcn and
  re-skin when the first screen needs them.
- **Date, time and datetime inputs** — the formatting helpers exist in
  `i18n/formats.ts` (`date` = `YYYY-MM-DD` string, `time` = `HH:mm` wall clock,
  `datetime` = absolute ms); the controls do not.
- **Charts.** No colour scale for data visualisation is defined here; the status
  tones are not one and must not be borrowed as one.

---

## 14. Application shell and routes

The authenticated console is a single application frame. Its 64px top bar has
the wordmark with its accent dot, a centred pill group for primary navigation,
and a right cluster: organization-switcher pill, two-segment ES/EN language
pill, settings icon button, and Clerk `UserButton`. The selected navigation item
carries an accent dot. There is no footer.

Its main area is the mounting point for every product screen. A stage-G-or-later
screen is a route child that composes its own content from the existing
primitives; it must not recreate navigation, auth checks, organization
selection, language controls, or error handling.

Signing in lands on `/{locale}/projects`: everything operational hangs off a
project, so the project list is the useful starting point. Chat (`/{locale}/chat`,
delivered in #32 — see `docs/web-chat.md` for its decisions) is a primary surface
reached from the nav, not the landing view. Primary surface routes are `/{locale}/recipes`,
`/{locale}/services`, `/{locale}/projects`, `/{locale}/locations`,
`/{locale}/fields`, and `/{locale}/statistics`; organization settings, including
the read-only member roster, are at `/{locale}/settings`. Locale is always the
short URL segment (`es` or `en`). Every entity detail is deep-linkable using
`/{locale}/{collection}/{id}`: for example, `/es/services/{id}`,
`/es/recipes/{id}`, `/es/projects/{id}`, `/es/locations/{id}`, and
`/es/fields/{id}`. Detail screens inherit the same shell.

The guard order is deliberate: Clerk authentication first, then Convex user
provisioning, then organization selection. While a signed-in Clerk user is being
provisioned, the shell renders a known-shape skeleton and does not redirect or
interpret the temporary `getCurrentUser() === null` result as no organization.
Only a provisioned user with zero memberships sees the organization-creation
flow.

Errors surface in the application route-level error boundary and in the small
number of mutation/query call sites that can recover locally. Both use
`presentConvexError()`; a generic not-found-or-inaccessible result always becomes
`UnavailableState`, with no action. A route-level panel is preferred to a toast:
the failed surface remains visible in context, it is durable for keyboard and
screen-reader users, and it does not create a second, transient error pattern.

The theme toggle remains deferred. The shell preserves the documented
OS-preference and `data-theme` token behavior, but does not add a preference
control or persistence policy before that behavior has a dedicated product
decision.
