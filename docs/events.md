# Events, typed field values, time, and relationships

An Event is operational data. Its universal columns live on the `events` document;
everything recipe-specific lives in `eventFieldValues`, one row per field.

| Column | Meaning |
| --- | --- |
| `projectId` | Container; also the archival freeze boundary |
| `recipeVersionId` | The exact published version this Event was created from. Permanent |
| `recipeId`, `organizationId` | Derived server-side from the version and the stored graph (I4); no mutation accepts them |
| `name`, `status` | `draft \| planned \| confirmed \| active \| completed \| cancelled` |
| `startsAt` | Canonical absolute timestamp in ms. Never redefined by a recipe datetime field |
| `endsAt?` | Optional absolute timestamp, `>= startsAt`, clearable with `null` |

`recipeVersionId` is structurally immutable: no public mutation takes it after creation.

## Creating an event

`events.createEventFromRecipe` (planner+) runs one transaction:

1. `requireProjectAccess(projectId, 'planner')` — the full I1 chain.
2. The project must accept new events: not `archived`, not `completed`.
3. Load the recipe version and its recipe; the project's organization and the version's must
   match, or the generic not-found error.
4. The version must be `published` and its recipe not `archived`. Because a recipe has at
   most one published version at a time, "this version is published" is equivalent to "this
   is the recipe's current version" — so events can never be created from a superseded or
   unfinished rule set.
5. Validate the name and the dates (finite, ordered).
6. **Materialize defaults**: every composed row the client omitted that carries a
   `defaultValue` is added to the submitted set — *before* the required-field check, so a
   required field with a configured default succeeds when omitted. Materialized defaults go
   through the same validation gate as submitted ones, so a default whose location has since
   been archived fails creation exactly as an explicit value would.
7. Validate the complete set through `validateEventAgainstRecipe` (below).
8. Insert the event, then one `eventFieldValues` row per resolved value, deriving the
   `locationId` mirror from each value.
9. Write the `event.created` audit row.

Defaults are a creation-time concept only. `updateEventFields` never re-applies them: after
creation, the absence of a value is a deliberate state, not an unfilled blank.

## The validation gate

`events/model.ts:validateEventAgainstRecipe` is the sole typed-value gate and the only place
a submitted `fieldDefinitionId` is resolved to the recipe field row that governs it. Both
`createEventFromRecipe` and `updateEventFields` use it.

Every rule comes from `recipeField.config` — the immutable snapshot — and never from the live
`fieldDefinitions` row. `updateEventFields` loads the event's **own** `recipeVersionId` rows
with no status filter, because a retired version is still the rule set its events were
written against. Reading anything else (the recipe's currently published version, or the live
definitions) would silently reinterpret history. This is the I3 headline case, and the test
suite pins it: a value legal under V1 but illegal under a narrowed V2 is still accepted on a
V1 event after V1 is retired.

What the gate enforces:

- A definition the version does not compose — including another tenant's — is refused once,
  generically.
- A repeated definition in one submission is refused.
- `null` means "clear"; clearing a `required` field is refused.
- `validateFieldValueAgainstConfig` (shared with recipe defaults) checks the discriminator
  against the config kind, then the kind-specific rules: finite numbers, integer-only,
  numeric bounds, string length bounds, calendar-valid dates, clock-valid times, lexicographic
  date/time bounds, known option ids, no repeated multi-select ids, selection-count bounds.
- Location values additionally resolve to a live, same-organization location
  (`assertUsableLocation`), with the generic error on any failure.
- On creation only, every `required` field must end up with a value.

The union in `validators/index.ts` is structurally loose at the Convex layer for the
`date` / `time` / `number` / `datetime` branches (bare strings and float64s), precisely
because Convex validators cannot express calendar validity or finiteness. The union alone is
never sufficient validation for a mutation — every write path must go through this gate.

## Updating

| Mutation | Role | Behaviour |
| --- | --- | --- |
| `updateEventCoreFields` | planner | `name`, `startsAt`, `endsAt` (pass `null` to clear). Date ordering is checked on the **merged** pair, so moving `startsAt` past a stored `endsAt` is refused |
| `updateEventFields` | planner | Upsert per `(eventId, fieldDefinitionId)`; `value: null` clears (deletes the row, and its location mirror with it) |
| `changeEventStatus` | **operator** | The lifecycle matrix below |

Both update paths diff against what is stored: echoing a value back writes neither a document
patch nor an audit row. `updateEventFields` records the field definition ids that actually
changed in `metadata.changedFields`.

On an update that replaces a location value with a different kind, the `locationId` mirror is
written explicitly as `undefined` in the same patch — a stale mirror would keep a location
referenced by an index and undeletable forever.

## Status lifecycle

```
draft → planned → confirmed → active → completed
  └───────┴──────────┴──────────┴──→ cancelled
```

Forward one step at a time; skipping and reversing are refused, and no state succeeds itself
(so re-declaring the current status is refused too). `completed` and `cancelled` are terminal.
Cancellation gets its own audit action (`event.cancelled`) so the terminal removal path is
greppable in the log.

Write gate, in two shared helpers so relationships obey the same rules:

- `assertProjectAcceptsEventWrites` — an archived project is read-only for all its events,
  cancellation included.
- `assertEventWritable` — the above, plus: completed and cancelled events are read-only.

Events are **never hard-deleted.** Cancellation is their terminal removal path. See
[`deletion-and-archival.md`](deletion-and-archival.md).

## Visibility

`recipeFields.visible: false` is presentation metadata — "do not put this on the operator's
form" — not an authorization or integrity rule. It is deliberately *not* enforced on write or
on read. A hidden field may legitimately carry a value (a default materialized at creation, or
a value written while the field was visible in an earlier version), and `getEvent` returns it.
Making it a write rule would let a published version silently orphan values it still owns;
making it a read rule would hide data the audit trail says exists. Enforcement is the client's
concern until a per-field permission model — deliberately out of scope — gives it a
server-side meaning. The one related rule that *is* enforced: `required ⇒ visible`, because a
required field nobody can see is unfillable.

## Reading

`getEvent` returns the event plus its values, each joined with `key` and `label` from the
live field definition. The **semantics** come from the snapshot; only those two display
strings are live. That join is safe for `key` only because the field-immutability trigger
counts retired versions as well as published ones — see
[`recipes.md`](recipes.md#semantic-immutability). A stored value row whose `recipeFieldId`
does not belong to the event's own version is treated as corruption and rejected, not
reinterpreted.

`listProjectEvents` is paginated over `by_project_startsAt`.

## Temporal semantics

| Concept | Representation | Rule |
| --- | --- | --- |
| `datetime` field value, `events.startsAt` / `endsAt`, `projects.startsAt` / `endsAt` | Absolute timestamp, milliseconds, `v.number()` | Must be finite. `endsAt >= startsAt`, checked on merged updates |
| `date` field value | `YYYY-MM-DD` string | Pattern **and** calendar validity (month range, month length, leap years). Never converted to a timestamp |
| `time` field value | `HH:mm` string | Strict 24-hour: `00–23` / `00–59`. Never converted to a timestamp |
| Audit row time | Convex `_creationTime` | No separate `createdAt` column exists |

`date` and `time` are wall-clock facts, not instants — a pickup "at 09:00" is 09:00 wherever
the vehicle is, and converting it to a timestamp would invent a timezone the data does not
have. Only `startsAt` / `endsAt` and `datetime` values are absolute instants. An Event's
canonical `startsAt` is always a complete absolute timestamp and is never redefined by a
recipe `datetime` field.

Both string formats are zero-padded, so lexicographic comparison is correct ordering — which
is what the `min` / `max` bound checks rely on. No timezone is stored anywhere, and no
timezone conversion happens anywhere.

## Relationships

Typed directed links between two events of the same organization:
`dependsOn | follows | parentOf | relatedTo` (closed union, I8). Unique on
`(sourceEventId, targetEventId, type)` via indexed read-before-write. Self-links are refused.

There is **no cycle detection, no traversal, and no workflow execution** — this is a
structured link catalogue, not a workflow engine.

A link is a write to its **source** event, so it passes the same `assertEventWritable` gate as
any other event write: archived projects and cancelled/completed events can neither gain nor
lose links. The **target** is gated on its project only, not its own status — pointing a live
event at a completed one ("this follows the arrival that already happened") is ordinary
planning, whereas writing into an archived project is not.

Reads are two directional paginated queries (`listOutgoingRelationships`,
`listIncomingRelationships`), each joined with the counterpart event. They are separate
because **no index spans both directions**; merging them would require an unbounded read
before pagination (I6). An anomalous row — counterpart missing, or its organization
disagreeing with the link's — is skipped rather than thrown on, so one inconsistent row
degrades a page instead of making a directional list permanently unreadable. The security
argument does not rest on that loop: the caller already proved access to the anchor event, and
the create path only ever writes links whose endpoints are the same tenant's.

Relationship rows are hard-deleted (they are not historical operational records, and the
events themselves remain), so the `relationship.created` audit row records both endpoints and
the type — a created entry read in isolation must still say what the link joined.
