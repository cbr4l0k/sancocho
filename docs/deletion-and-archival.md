# Deletion and archival policy

The default is archival or cancellation. Hard deletion is allowed only for data that is
provably unreferenced and provably not history, and every destructive operation verifies its
references through indexes first.

## Per-entity policy

| Entity | Archive / cancel | Hard delete | Guard before deleting |
| --- | --- | --- | --- |
| `organizations` | Not implemented (no archival status) | **No operation exists** | — |
| `organizationMemberships` | — | Yes, `removeMember` | Final owner can never be removed; touching an owner requires owner. **Deliberately not guarded by `events.accountableUserId`** — see below |
| `projects` | `archiveProject`, idempotent, terminal | **Never** | — |
| `events` | `archiveEvent`, terminal | Yes, `deleteEvent`, archived-only | First-hit read on `services.by_event_startsAt` must find nothing; deletion writes `event.deleted` first |
| `fieldDefinitions` | `archiveFieldDefinition`, idempotent | Yes, `deleteFieldDefinition` | First-hit reads on `serviceKindFields.by_field` **and** `serviceFieldValues.by_field` must both find nothing |
| `serviceKinds` | `archiveServiceKind` (retires the live published version too) | **Never** | — |
| `serviceKindVersions` | `retired`, via publish or archive | **Never** | — |
| `serviceKindFields` | — | Yes, `removeServiceKindField`, **draft versions only** | The edit gate proves the owning version is still a draft |
| `services` | `cancelled` status | **Never** | — |
| `serviceFieldValues` | — | Yes, when a value is cleared (`value: null`) | A `required` field cannot be cleared |
| `locations` | `archiveLocation`, idempotent | Yes, `deleteLocation`, archived-only | First-hit reads on `serviceFieldValues.by_location`, `serviceKindFields.by_defaultLocation` **and** `events.by_venueLocation` must all find nothing |
| `costCentres` | `archiveCostCentre`, idempotent | Yes, `deleteCostCentre`, archived-only | A first-hit read on `events.by_clientCostCentre` must find nothing |
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
- **Cost Centres.** A Cost Centre an Event still names as its client is history in the same
  sense a venue is: archival keeps it readable where it is already referenced, deletion is
  refused until nothing points at it.

### Why accountability does *not* guard member removal

`events.accountableUserId` is the one reverse reference that is **not** allowed to refuse its
target's removal, and the asymmetry is deliberate.

Membership is the only principal arm today, so `removeMember` is the tenant's only
access-revocation path. A reference guard there would not merely inconvenience an admin — it
would make revocation *impossible* for reachable data: `archiveProject` is terminal, and an
archived Project freezes every Event write beneath it, so an Event naming a departing member
could be neither reassigned nor deleted, and that member would keep read access to the whole
tenant forever. The same trap closes on an archived Event holding at least one Service.

So `accountableUserId` follows the ordinary rule for stored references (compare
`assertUsableLocation`): it is proven at **write** time and the stored value survives
afterwards. Nothing dangles, because `users` rows are never deleted, and an archived Event
keeps the true record of who was accountable while it ran. The one thing a former member
cannot be is *newly* assigned.

Deleting a Location or a Cost Centre is different in kind — it is optional cleanup, and
archival is the documented lifecycle path for a referenced row — so refusing there strands
nothing.

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
