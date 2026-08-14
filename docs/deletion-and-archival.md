# Deletion and archival policy

The default is archival or cancellation. Hard deletion is allowed only for data that is
provably unreferenced and provably not history, and every destructive operation verifies its
references through indexes first.

## Per-entity policy

| Entity | Archive / cancel | Hard delete | Guard before deleting |
| --- | --- | --- | --- |
| `organizations` | Not implemented (no archival status) | **No operation exists** | — |
| `organizationMemberships` | — | Yes, `removeMember` | Final owner can never be removed; touching an owner requires owner |
| `projects` | `archiveProject`, idempotent, terminal | **Never** | — |
| `fieldDefinitions` | `archiveFieldDefinition`, idempotent | Yes, `deleteFieldDefinition` | First-hit reads on `recipeFields.by_field` **and** `eventFieldValues.by_field` must both find nothing |
| `eventRecipes` | `archiveRecipe` (retires the live published version too) | **Never** | — |
| `recipeVersions` | `retired`, via publish or archive | **Never** | — |
| `recipeFields` | — | Yes, `removeRecipeField`, **draft versions only** | The edit gate proves the owning version is still a draft |
| `events` | `cancelled` status | **Never** | — |
| `eventFieldValues` | — | Yes, when a value is cleared (`value: null`) | A `required` field cannot be cleared |
| `locations` | `archiveLocation`, idempotent | Yes, `deleteLocation`, archived-only | First-hit reads on `eventFieldValues.by_location` **and** `recipeFields.by_defaultLocation` must both find nothing |
| `eventRelationships` | — | Yes, `removeRelationship` | Source event must be writable; the audit row records both endpoints |
| `auditEvents` | — | **No mutation exists anywhere** | Append-only |

## Why the hard deletes are safe

- **Recipe fields in a draft.** A version never returns to `draft` once published, and events
  reference published versions and validate against those versions' rows. So no draft row can
  be the rule set behind an existing event; deleting one destroys unreferenced configuration,
  not history.
- **Field definitions.** Both reference tables are checked. `recipeFields` covers
  configuration references (including drafts); `eventFieldValues` covers operational data, so
  a definition carrying stored event values survives even if no recipe still lists it.
- **Locations.** See [`locations.md`](locations.md#archival-and-deletion).
- **Relationships.** Links are not historical operational records and the events they joined
  remain. The audit row is self-describing so removal is still reconstructible.
- **Memberships.** A removed membership is an access revocation, not history; the audit row
  records `previousRole`.

## Archival as a freeze, not a cascade

Archiving a project is deliberately allowed no matter how many events it holds — a project
with events is exactly the project worth archiving, and a reference guard would make the
most-used projects the only unarchivable ones. There is no cascade: the events stay readable,
listable and interpretable under their own recipe versions forever.

The enforcing half lives in `events/model.ts`:

| Helper | Refuses |
| --- | --- |
| `assertProjectAcceptsEventWrites` | Every event write in an archived project — field edits, core-field edits, and status transitions *including cancellation* |
| `assertEventWritable` | The above, plus writes to a `completed` or `cancelled` event |
| `assertProjectAcceptsNewEvents` | New events in an `archived` **or** `completed` project |

`relationships/model.ts` gates on the same two helpers, so archival is a freeze through every
door — a planner cannot restructure the link graph of frozen history.

A `completed` project is a middle state on purpose: it accepts no new events, but the events
it already has stay editable, so a finished piece of work can still be corrected without being
reopened. Only archival freezes editing.

`archived` is terminal for projects, recipes, field definitions and locations. There is no
unarchive operation anywhere.

## Status transition rules

| Entity | Transitions |
| --- | --- |
| `projects` | `draft`, `active`, `completed` move between each other freely; `archived` is reachable only through `archiveProject` (so it keeps its own audit action and policy) and is terminal |
| `eventRecipes` | `draft` → `active` on first publish; `archived` terminal |
| `recipeVersions` | `draft` → `published` → `retired`; no status-editing mutation exists |
| `events` | `draft` → `planned` → `confirmed` → `active` → `completed`, one step at a time; any non-terminal state → `cancelled`; `completed` and `cancelled` terminal |
| `fieldDefinitions`, `locations` | `active` → `archived`, terminal |
