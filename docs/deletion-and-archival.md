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
| `events` | `archiveEvent`, terminal | Yes, `deleteEvent`, archived-only | First-hit read on `services.by_event_startsAt` must find nothing; deletion writes `event.deleted` first |
| `fieldDefinitions` | `archiveFieldDefinition`, idempotent | Yes, `deleteFieldDefinition` | First-hit reads on `serviceKindFields.by_field` **and** `serviceFieldValues.by_field` must both find nothing |
| `serviceKinds` | `archiveServiceKind` (retires the live published version too) | **Never** | — |
| `serviceKindVersions` | `retired`, via publish or archive | **Never** | — |
| `serviceKindFields` | — | Yes, `removeServiceKindField`, **draft versions only** | The edit gate proves the owning version is still a draft |
| `services` | `cancelled` status | **Never** | — |
| `serviceFieldValues` | — | Yes, when a value is cleared (`value: null`) | A `required` field cannot be cleared |
| `locations` | `archiveLocation`, idempotent | Yes, `deleteLocation`, archived-only | First-hit reads on `serviceFieldValues.by_location` **and** `serviceKindFields.by_defaultLocation` must both find nothing |
| `serviceRelationships` | — | Yes, `removeRelationship` | Source service must be writable; the audit row records both endpoints |
| `auditEvents` | — | **No mutation exists anywhere** | Append-only |

## Why the hard deletes are safe

- **Service Kind fields in a draft.** A version never returns to `draft` once published, and services
  reference published versions and validate against those versions' rows. So no draft row can
  be the rule set behind an existing service; deleting one destroys unreferenced configuration,
  not history.
- **Field definitions.** Both reference tables are checked. `serviceKindFields` covers
  configuration references (including drafts); `serviceFieldValues` covers operational data, so
  a definition carrying stored service values survives even if no service kind still lists it.
- **Locations.** See [`locations.md`](locations.md#archival-and-deletion).
- **Relationships.** Links are not historical operational records and the services they joined
  remain. The audit row is self-describing so removal is still reconstructible.
- **Memberships.** A removed membership is an access revocation, not history; the audit row
  records `previousRole`.

## Archival as a freeze, not a cascade

Archiving a project is deliberately allowed no matter how many services it holds — a project
with services is exactly the project worth archiving, and a reference guard would make the
most-used projects the only unarchivable ones. There is no cascade: the services stay readable,
listable and interpretable under their own service kind versions forever.

The shared Project-lifecycle predicates live in `projects/model.ts`; the Event and Service
domains retain distinct stable error codes while consulting the same status policy:

| Helper | Refuses |
| --- | --- |
| `assertProjectAcceptsChildWrites` | Every Event or Service write in an archived project — including Service cancellation and Event deletion |
| `assertServiceWritable` | The above, plus writes to a `completed` or `cancelled` service |
| `assertProjectAcceptsNewChildren` | New Events or Services in an `archived` **or** `completed` project |

`relationships/model.ts` gates on the same two helpers, so archival is a freeze through every
door — a planner cannot restructure the link graph of frozen history.

A `completed` project is a middle state on purpose: it accepts no new services, but the services
it already has stay editable, so a finished piece of work can still be corrected without being
reopened. Only archival freezes editing.

`archived` is terminal for projects, service kinds, field definitions and locations. There is no
unarchive operation anywhere.

## Status transition rules

| Entity | Transitions |
| --- | --- |
| `projects` | `draft`, `active`, `completed` move between each other freely; `archived` is reachable only through `archiveProject` (so it keeps its own audit action and policy) and is terminal |
| `events` | `draft` → `active` → `completed`; each non-archived state may reach `archived` only through `archiveEvent`; `archived` is terminal |
| `serviceKinds` | `draft` → `active` on first publish; `archived` terminal |
| `serviceKindVersions` | `draft` → `published` → `retired`; no status-editing mutation exists |
| `services` | `draft` → `planned` → `confirmed` → `active` → `completed`, one step at a time; any non-terminal state → `cancelled`; `completed` and `cancelled` terminal |
| `fieldDefinitions`, `locations` | `active` → `archived`, terminal |
