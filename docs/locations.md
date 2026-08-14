# Locations and reference semantics

Locations are organization-owned reference data: a name, a type from a closed taxonomy
(`airport | hotel | venue | office | station | depot | custom`), optional free-form address
text (≤ 500 characters), and optional coordinates.

Coordinates are both-or-neither, finite, `latitude ∈ [-90, 90]`, `longitude ∈ [-180, 180]`,
validated on create and on the **merged** pair for partial updates. They cannot be cleared
through the update API — clients either omit both or supply numeric replacements.

No geocoding, no address normalization, no mapping (explicit non-goals).

## Reference, not snapshot

A `location` field value stores a `locationId`. It is a **reference to the live entity**, so
later edits to the location are visible from historical Events: correcting an airport's
address updates what every past event shows.

That is a deliberate choice with a real cost, and the cost is stated rather than hidden:

- **What it buys**: reference data stays correctable in one place. A typo fixed once is fixed
  everywhere, and there is no snapshot fan-out per event.
- **What it costs**: an Event is *not* a record of where the location was at the time. If a
  hotel is renamed or moved, history reads as if it always had the new name. Audit-grade
  location snapshots would require a revision system and are deliberately **not built**.

This is the one place where the I3 guarantee is scoped rather than absolute: an event's
*rules* are frozen (the recipe snapshot), and its *values* are frozen (`locationId` never
changes on its own), but the referenced location document is live.

## Archival and deletion

| Operation | Rule |
| --- | --- |
| `archiveLocation` | Always allowed (idempotent). An archived location is rejected by every subsequent event-value write and every recipe default validation |
| `updateLocation` | Refused for archived locations |
| `deleteLocation` | Only after archival, and only if no reference exists |

Deletion is guarded by two indexed first-hit reads, both of which must find nothing:

| Guard | Index | Covers |
| --- | --- | --- |
| `eventFieldValues.locationId` | `by_location` | Operational data — any stored event value pointing at the location |
| `recipeFields.defaultLocationId` | `by_defaultLocation` | Configuration — any recipe field default pointing at the location |

Both columns are **server-derived mirrors** of the `location` value beside them, written
through the single shared helper `fields/values.ts:locationIdFromValue` on every write path —
add, update, clone, event create, event update, and every clear (where it returns `undefined`
and the column must be removed). A write path that forgot it would leave a location deletable
while a row still referenced it.

The second guard is the structural one. A published recipe version is immutable (I2), so a
default it carries can never be repaired. Deleting the location out from under it would leave
a dangling reference that fails every later event creation and every clone-then-publish,
permanently disabling that version with a generic error and no recovery. Archival — not
deletion — is the lifecycle path for a location referenced anywhere.

## Known consequence: archival degrades published versions

Accepted, documented in `locations/model.ts`, and asserted by `events.test.ts`:

Archiving a location makes every already-published, immutable recipe version that defaults to
it stop being usable for new events, because the default fails
`validateRecipeFieldDefaultValue`. There is no unarchive operation.

Whether an archived location should keep working for *pre-existing* published defaults while
being refused for *new* selections is a revision-system question — per-version location
snapshots, or a "referenced by a published version" archival guard. It is deliberately left to
that future revision rather than guessed at now. Tracked as a known gap in
[`deviations.md`](deviations.md#known-gaps).
