# Services, typed field values, time, and relationships

A Service is operational data. Its universal columns live on the `services` document;
everything service kind-specific lives in `serviceFieldValues`, one row per field.

| Column | Meaning |
| --- | --- |
| `projectId` | Container; also the archival freeze boundary |
| `serviceKindVersionId` | The exact published version this Service was created from. Permanent |
| `serviceKindId`, `organizationId` | Derived server-side from the version and the stored graph (I4); no mutation accepts them |
| `name`, `status` | `draft \| planned \| confirmed \| active \| completed \| cancelled` |
| `startsAt` | Canonical absolute timestamp in ms. Never redefined by a service kind datetime field |
| `endsAt?` | Optional absolute timestamp, `>= startsAt`, clearable with `null` |

`serviceKindVersionId` is structurally immutable: no public mutation takes it after creation.

## Creating a service

`services.createServiceFromServiceKind` (planner+) runs one transaction:

1. `requireProjectAccess(projectId, 'planner')` — the full I1 chain.
2. The project must accept new services: not `archived`, not `completed`.
3. Load the service kind version and its service kind; the project's organization and the version's must
   match, or the generic not-found error.
4. The version must be `published` and its service kind not `archived`. Because a service kind has at
   most one published version at a time, "this version is published" is equivalent to "this
   is the service kind's current version" — so services can never be created from a superseded or
   unfinished rule set.
5. Validate the name and the dates (finite, ordered).
6. **Materialize defaults**: every composed row the client omitted that carries a
   `defaultValue` is added to the submitted set — *before* the required-field check, so a
   required field with a configured default succeeds when omitted. Materialized defaults go
   through the same validation gate as submitted ones, so a default whose location has since
   been archived fails creation exactly as an explicit value would.
7. Validate the complete set through `validateServiceAgainstServiceKind` (below).
8. Insert the service, then one `serviceFieldValues` row per resolved value, deriving the
   `locationId` mirror from each value.
9. Write the `service.created` audit row.

Defaults are a creation-time concept only. `updateServiceFields` never re-applies them: after
creation, the absence of a value is a deliberate state, not an unfilled blank.

## The validation gate

`services/model.ts:validateServiceAgainstServiceKind` is the sole typed-value gate and the only place
a submitted `fieldDefinitionId` is resolved to the service kind field row that governs it. Both
`createServiceFromServiceKind` and `updateServiceFields` use it.

Every rule comes from `serviceKindField.config` — the immutable snapshot — and never from the live
`fieldDefinitions` row. `updateServiceFields` loads the service's **own** `serviceKindVersionId` rows
with no status filter, because a retired version is still the rule set its services were
written against. Reading anything else (the service kind's currently published version, or the live
definitions) would silently reinterpret history. This is the I3 headline case, and the test
suite pins it: a value legal under V1 but illegal under a narrowed V2 is still accepted on a
V1 service after V1 is retired.

What the gate enforces:

- A definition the version does not compose — including another tenant's — is refused once,
  generically.
- A repeated definition in one submission is refused.
- `null` means "clear"; clearing a `required` field is refused.
- `validateFieldValueAgainstConfig` (shared with service kind defaults) checks the discriminator
  against the config kind, then the kind-specific rules: finite numbers, integer-only,
  numeric bounds, string length bounds, calendar-valid dates, clock-valid times, lexicographic
  date/time bounds, known option ids, no repeated multi-select ids, selection-count bounds.
- **Absolute string ceilings**, independent of the snapshot: `text` 2000 characters,
  `longText` 10000. A snapshot's own `maxLength` is optional (the seeded `notes` built-in
  omits one), and `getService` collects every value of a service at once — the bounded-child-set
  argument for that collect bounds the row count, not the bytes. `assertValidFieldConfig`
  refuses any config that would promise more, so a snapshot can never advertise a bound the
  value gate would not honour.
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
| `updateServiceCoreFields` | planner | `name`, `startsAt`, `endsAt` (pass `null` to clear). Date ordering is checked on the **merged** pair, so moving `startsAt` past a stored `endsAt` is refused |
| `updateServiceFields` | planner | Upsert per `(serviceId, fieldDefinitionId)`; `value: null` clears (deletes the row, and its location mirror with it) |
| `changeServiceStatus` | **operator** | The lifecycle matrix below |

Both update paths diff against what is stored: echoing a value back writes neither a document
patch nor an audit row. `updateServiceFields` records the field definition ids that actually
changed in `metadata.changedFields`, under its own audit action **`service.fieldsUpdated`** —
`updateServiceCoreFields` writes `service.updated` with column names under the same key, and a
log consumer must not have to sniff the value to tell the two vocabularies apart.

A submitted value **identical to the stored one is not re-validated**: the service's values are
loaded before the gate runs, and an unchanged one skips the rule checks (bounds, option
identity, and the referenced location's usability). It already passed this exact immutable
snapshot when it was written, so re-judging it against the world as it is now would break the
ordinary read-modify-write shape — load a service, edit one field, resubmit the whole form —
the moment a location it references is archived. Structural checks (unknown field, repeated
definition, clearing a required field) still run over the entire submission, and a value that
actually changes is validated in full.

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
Cancellation gets its own audit action (`service.cancelled`) so the terminal removal path is
greppable in the log.

Write gate, in two shared helpers so relationships obey the same rules:

- `assertProjectAcceptsServiceWrites` — an archived project is read-only for all its services,
  cancellation included.
- `assertServiceWritable` — the above, plus: completed and cancelled services are read-only.

Services are **never hard-deleted.** Cancellation is their terminal removal path. See
[`deletion-and-archival.md`](deletion-and-archival.md).

## Visibility

`serviceKindFields.visible: false` is presentation metadata — "do not put this on the operator's
form" — not an authorization or integrity rule. It is deliberately *not* enforced on write or
on read. A hidden field may legitimately carry a value (a default materialized at creation, or
a value written while the field was visible in an earlier version), and `getService` returns it.
Making it a write rule would let a published version silently orphan values it still owns;
making it a read rule would hide data the audit trail says exists. Enforcement is the client's
concern until a per-field permission model — deliberately out of scope — gives it a
server-side meaning. The one related rule that *is* enforced: `required ⇒ visible`, because a
required field nobody can see is unfillable.

## Reading

`getService` returns the service plus its values in `by_service_field` **index order — not
`position` order**. Ordering is a presentation concern and lives on the service kind version, so a
client rendering a form joins `serviceKinds.fields.listServiceKindFields(serviceKindVersionId)` (bounded, one
read) and orders by its `position`. Each value is joined with `key` and `label` from the
live field definition. The **semantics** come from the snapshot; only those two display
strings are live. That join is safe for `key` only because the field-immutability trigger
counts retired versions as well as published ones — see
[`service-kinds.md`](service-kinds.md#semantic-immutability). A stored value row whose `serviceKindFieldId`
does not belong to the service's own version is treated as corruption and rejected, not
reinterpreted.

`listProjectServices` is paginated over `by_project_startsAt`.

`listOrganizationServices` is the organization-wide list the console's Services screen is built
on: every project's services in one page, ordered by start time. `projectId` and `status` are
optional narrowings, and each combination picks its own index (`by_org_startsAt`,
`by_org_status_startsAt`, `by_project_startsAt`, `by_project_status_startsAt`) rather than
filtering an already-paginated page (I6). When `projectId` is supplied, the project is proven
through `requireProjectAccess` **and** cross-checked against `organizationId`, so neither id
can be used to reach the other's tenant (I1); the refusal is the generic one (I9).

Each returned row carries more than the service document, because the screen it serves is
column-configurable and edits rows in place: the owning project's name, status and window,
and **every visible field the service's own version composes** — valued or not — with that
field's immutable `config` snapshot beside it. Repeated lookups (project, version fields,
field definitions, locations) are memoized across the page. `location` values are joined to
their location's name, here and in `getService`, so a client never has to render a bare id.

## Project window

A Service's `startsAt`/`endsAt` must fall inside its Project's own `startsAt`/`endsAt` window.
Each bound is enforced only when the project declares it, both boundaries are inclusive, and
an open-ended service is judged by its start (`endsAt ?? startsAt` is its last instant). The
codes are `serviceBeforeProjectWindow` and `serviceAfterProjectWindow`, deliberately distinct
from `serviceDateRangeInvalid` — "outside the project" is a different mistake from "these two
times are inverted". Creation and every core-field edit go through the same check, and the
edit checks the *merged* pair, so moving one end out of the window is refused exactly as
writing both outside it is.

The rule is **write-time and not retroactive**: narrowing a project's window later cannot
reject already-stored services without scanning every service in the project (I6), so
`updateProject` leaves history alone and this gate governs everything written from then on.

## Temporal semantics

| Concept | Representation | Rule |
| --- | --- | --- |
| `datetime` field value, `services.startsAt` / `endsAt`, `projects.startsAt` / `endsAt` | Absolute timestamp, milliseconds, `v.number()` | Must be finite. `endsAt >= startsAt`, checked on merged updates |
| `date` field value | `YYYY-MM-DD` string | Pattern **and** calendar validity (month range, month length, leap years). Never converted to a timestamp |
| `time` field value | `HH:mm` string | Strict 24-hour: `00–23` / `00–59`. Never converted to a timestamp |
| Audit row time | Convex `_creationTime` | No separate `createdAt` column exists |

`date` and `time` are wall-clock facts, not instants — a pickup "at 09:00" is 09:00 wherever
the vehicle is, and converting it to a timestamp would invent a timezone the data does not
have. Only `startsAt` / `endsAt` and `datetime` values are absolute instants. A Service's
canonical `startsAt` is always a complete absolute timestamp and is never redefined by a
service kind `datetime` field.

Both string formats are zero-padded, so lexicographic comparison is correct ordering — which
is what the `min` / `max` bound checks rely on. No timezone is stored anywhere, and no
timezone conversion happens anywhere.

## Relationships

Typed directed links between two services of the same organization:
`dependsOn | follows | parentOf | relatedTo` (closed union, I8). Unique on
`(sourceServiceId, targetServiceId, type)` via indexed read-before-write. Self-links are refused.

There is **no cycle detection, no traversal, and no workflow execution** — this is a
structured link catalogue, not a workflow engine.

A link is a write to its **source** service, so it passes the same `assertServiceWritable` gate as
any other service write: archived projects and cancelled/completed services can neither gain nor
lose links. The **target** is gated on its project only, not its own status — pointing a live
service at a completed one ("this follows the arrival that already happened") is ordinary
planning, whereas writing into an archived project is not.

Reads are two directional paginated queries (`listOutgoingRelationships`,
`listIncomingRelationships`), each joined with the counterpart service. They are separate
because **no index spans both directions**; merging them would require an unbounded read
before pagination (I6). An anomalous row — counterpart missing, or its organization
disagreeing with the link's — is skipped rather than thrown on, so one inconsistent row
degrades a page instead of making a directional list permanently unreadable. The security
argument does not rest on that loop: the caller already proved access to the anchor service, and
the create path only ever writes links whose endpoints are the same tenant's.

Relationship rows are hard-deleted (they are not historical operational records, and the
services themselves remain), so the `relationship.created` audit row records both endpoints and
the type — a created entry read in isolation must still say what the link joined.
