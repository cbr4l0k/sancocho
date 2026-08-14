# Field definitions, the semantic registry, and recipe versions

This is the part of the system that makes historical data safe. Everything here exists to
guarantee that an Event stays interpretable under exactly the rules it was written against
(I3), while configuration keeps evolving.

## Field definitions

A field definition is a reusable unit of information. Two scopes:

| Scope | `organizationId` | Created by | Key uniqueness |
| --- | --- | --- | --- |
| `builtin` | absent | `fields.createBuiltinFieldDefinition` (`internalMutation`, seeds only, behind `SANCOCHO_ENABLE_SEED`) | Globally unique across the deployment |
| `organization` | present | `fields.createFieldDefinition` (planner+) | Unique per organization, and may not shadow a built-in key |

Keys are 2–64 character lowerCamelCase identifiers (`/^[a-z][a-zA-Z0-9]*$/`). Both the
per-org uniqueness read and the built-in shadow probe are indexed point reads on
`by_org_key`; neither scans. Both live in one helper (`assertKeyAvailable`) called by
creation *and* rename — a create-then-rename path once skipped the shadow probe, which would
have let a custom key permanently shadow a global built-in once published.

### The config union

Data type, validation rules and options are bound together in one discriminated union
(`fieldConfigValidator`), so a document can never carry rules that disagree with its data
type. The same union is used by `fieldDefinitions.config` (the live definition) and
`recipeFields.config` (the immutable snapshot).

| `kind` | Rule properties | Event value shape |
| --- | --- | --- |
| `text` | `minLength?`, `maxLength?` | `{ kind: 'text', value: string }` |
| `longText` | `minLength?`, `maxLength?` | `{ kind: 'longText', value: string }` |
| `number` | `min?`, `max?`, `integer?` | `{ kind: 'number', value: number }` |
| `boolean` | — | `{ kind: 'boolean', value: boolean }` |
| `date` | `min?`, `max?` (`YYYY-MM-DD`) | `{ kind: 'date', value: 'YYYY-MM-DD' }` |
| `datetime` | `min?`, `max?` (ms timestamps) | `{ kind: 'datetime', value: number }` |
| `time` | `min?`, `max?` (`HH:mm`) | `{ kind: 'time', value: 'HH:mm' }` |
| `select` | `options: {id,label}[]` | `{ kind: 'select', optionId: string }` |
| `multiSelect` | `options`, `minSelections?`, `maxSelections?` | `{ kind: 'multiSelect', optionIds: string[] }` |
| `location` | — | `{ kind: 'location', locationId: Id<'locations'> }` |

There is no `reference` data type and no string/JSON fallback branch (I8).

Convex's `v.number()` accepts `NaN` and `Infinity`, and its `v.string()` accepts any string,
so structural validity is not enough. `assertValidFieldConfig` additionally enforces, at
create and update time: finite numeric bounds, `max >= min`, calendar-valid `YYYY-MM-DD`
bounds, clock-valid `HH:mm` bounds, at least one option with unique non-empty ids, and
selection bounds that are actually satisfiable by the option list. These checks matter
because a config is copied verbatim into an immutable snapshot; an incoherent one would
become the permanent rule set for historical events.

### Semantic capability registry

`semanticType` is optional metadata that grants **capabilities** — a closed set of things
the platform can do with a field. The registry is a frozen TypeScript map in
`validators/index.ts`, not database data: tenants can name a semantic type but can never
grant a capability, and an unrecognized type grants nothing (I8). Adding one is a code
change, deliberately. A compile-time guard asserts that `semanticTypeValidator`'s literals
are exactly the registry's keys.

| Semantic type | Expected data type | Capabilities |
| --- | --- | --- |
| `eventName` | `text` | `eventName` |
| `eventDescription` | `longText` | `eventDescription` |
| `eventDate` | `date` | `eventDate` |
| `eventTime` | `time` | `eventTime` |
| `eventLocation` | `location` | `eventLocation` |
| `passenger.count` | `number` | `passengerTotals`, `occupancyMetrics`, `capacityValidation` |
| `transport.origin` | `location` | — |
| `transport.destination` | `location` | — |
| `aviation.flightNumber` | `text` | `flightTracking` |
| `aviation.terminal` | `text` | — |
| `luggage.count` | `number` | — |
| `accessibility.wheelchairCount` | `number` | `accessibilityRequirements` |
| `contact.primary` | `text` | — |
| `general.notes` | `longText` | — |

`capabilitiesForField` is the only reader, and it returns the narrow `SemanticCapability`
union so consumers can never match capabilities by free-form string comparison. A semantic
type must be compatible with the config's `kind`, checked on both halves of any merged update.

### Semantic immutability

A field definition's **historical meaning** is `key`, `semanticType` and `config`. Once the
definition is referenced by a **published or retired** recipe version, those three columns
are frozen; only `label` and `description` remain editable.

The trigger counts retired versions on purpose. `events.getEvent` joins `key` and `label`
live from the current definition onto an event's stored values; counting retired versions is
exactly what freezes the key of any definition an event could ever reference, for that
event's whole lifetime. Narrowing the check to published-only would let a retired version's
definition be re-keyed and every historical event would silently start reporting a different
key — I3 broken with nothing failing in the fields tests. Both sites carry a cross-reference
comment. `label` is deliberately left mutable: it is a display string with no identity
meaning, so a rename is visible immediately and by design.

The check is a streaming first-hit read over `recipeFields.by_field`, so its cost is bounded
by the position of the first published/retired hit rather than by the field's total usage.

The gate is on **change**, not on argument presence: a read-modify-write client that echoes a
field's current key and config back is not rejected, because a structural diff runs first.
Archived fields are immutable regardless of which columns are patched.

## Recipes and versions

| Entity | Statuses |
| --- | --- |
| `eventRecipes` | `draft` → `active` (on first publish) → `archived` |
| `recipeVersions` | `draft` → `published` → `retired` |

Rules, all enforced by indexed read-before-write in the mutating transaction:

- At most one `draft` and at most one `published` version per recipe.
- Version numbers are server-assigned: highest existing via `by_recipe_version` descending,
  plus one (I7). Retired versions still count, so numbers never repeat. No public argument
  for a version number exists.
- Publishing is one transaction: verify the version is a draft and the recipe is not
  archived → validate every row → retire the currently published version → mark this one
  published → promote a `draft` recipe to `active` → audit. All or nothing.
- `clonePublishedVersionToDraft` copies the published version's rows into a new draft with
  independent documents (the location mirror is re-derived, never copied, so a clone cannot
  inherit a stale mirror).
- `archiveRecipe` retires the live published version in the same transaction, so an archived
  recipe stops being a source of new events while its versions stay readable. Archived
  recipes reject metadata updates, new drafts, publishing and composition.

### Published immutability (I2)

There is no status-editing mutation; status changes only through lifecycle operations. Every
composition mutation — `addRecipeField`, `updateRecipeField`, `reorderRecipeFields`,
`removeRecipeField` — passes through the single gate `requireDraftVersionForEdit`, which
rejects archived recipes and any version that is not a `draft` in one place. The whole
composed row is frozen: definition, position, required, visible, default, and the config
snapshot. Tests compare published and retired `recipeFields` rows field by field across
retirement and across later draft edits.

Publishing a version with no fields is refused; positions must be unique non-negative
integers; a version may hold at most `maxFieldsPerVersion = 200` rows.

### The snapshot contract

This is the one place where the implementation deliberately settled a question the Stage A
review had left ambiguous (`architecture-review.md` §7 was updated to match).

- **Snapshots are taken at draft-composition time, not at publish time.** `addRecipeField`
  copies the definition's config into the row (or accepts a caller-supplied narrowing).
- **A recipe may narrow its definition, never widen it.** Tighter bounds, integer-only, a
  subset of the definition's options. `assertSnapshotCoherentWithDefinition` is the single
  statement of that rule, called by add, update *and* publish.
- **Publishing validates coherence rather than overwriting the snapshot.** It re-checks kind
  identity, narrowing-only bounds, and option-subset against the definition *as it stands at
  publish time*, so a snapshot left stale by a later definition edit fails publishing
  honestly instead of shipping rules the definition disowns or dead options no operator can
  act on.
- **From publish onward the snapshot is the only rule set historical validation reads.** It
  never consults the live `fieldDefinitions` row.

Publish-time validation additionally re-runs `assertValidFieldConfig` on every snapshot,
checks that each definition is still active and belongs to the organization (or is a
built-in), rejects duplicate definitions, enforces `required ⇒ visible`, and validates every
default value through the same gate that validates event values — including resolving
location defaults to a live, same-organization location. Foreign-tenant location defaults are
rejected with the generic error, so publishing cannot be used to probe another tenant's ids.

### Defaults

A recipe field's `defaultValue` is a full typed value, validated against the row's own
snapshot. When the row carries a location default, the server-derived
`recipeFields.defaultLocationId` mirror column is written from the same value through the
shared `locationIdFromValue` helper — including on clears, where it must be removed in the
same patch. That mirror is what gives locations an indexed reference check over
configuration defaults; see [`locations.md`](locations.md).

Defaults are materialized into events at creation only — see
[`events.md`](events.md#creating-an-event).

## Future conditional rules

Deliberately not built (I8). The documented plug-in point is another closed validator union
on `recipeFields` beside the config snapshot (for example
`{ kind: 'if', fieldId, comparison, value, constraint }`), evaluated by a typed validator at
publish and event-write time. Arbitrary expressions, user scripts and a rules engine are out
of scope.
