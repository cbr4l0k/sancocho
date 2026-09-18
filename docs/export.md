# Export to Excel

The decision record for #36. Written before implementation, as that issue's first
acceptance criterion requires.

An export is a **bulk extraction of tenant data** into one `.xlsx` workbook the operator
opens in Excel. It is the read-side mirror of the workbook import (#77): the import
decides how a spreadsheet becomes Services, this decides how the operational record
becomes a spreadsheet again.

## Authority

Export is **member-only and floored at `admin`**.

Most of what it reads is viewer-level: `listOrganizationEvents`,
`listOrganizationServices`, `listProjects`, `listLocations`, `listServiceKinds`,
`listProviders` (through `requireProviderCatalogueAccess`, which is plain membership),
`listCostCentres`, the Vehicle Class and Fleet lists, and the Assignment reads whose
member floor for `readAssignment` is `viewer`. One read is not: `listRateCards` and
`requireRateCardAccess` both floor at `organizationConfigurationRole`, which is `admin`.

The whole action takes the highest floor it touches rather than exporting seven sheets
and failing the eighth. Two reasons beyond tidiness. An export is qualitatively unlike
the screens it draws from — a screen shows a planner the rows they are working on, an
export hands them the tenant in a file that leaves the product — and the member rank that
already governs the commercial catalogue is the honest floor for that. And a single floor
gives the gate one place to be, one place to test, and one answer to give.

**A Provider Principal cannot export.** It sees no affordance and, if it forged the gate
call, receives the same generic not-found every other member-only read gives it (I9).

The precise reason matters, because the obvious one is not quite true. Most of what the
walk reads resolves through `requireOrganizationMembership` or `requireOrganizationRole`,
which refuse a Principal holding only a scoped grant. But one source does not:
`listAssignmentRevisions` gates on `readAssignment`, an intent the Provider arm holds, and
returns that firm's own narrowed projection of its own Assignment's revisions
(`assignments/model.ts`). That is correct and deliberate — it is what the Provider portal
reads.

What makes the export member-only is therefore two things, not one. The gate refuses a
Provider outright. And the Assignments sheet's source, `listServiceAssignmentRows`,
**refuses the Provider arm explicitly** rather than projecting it, so a Provider can never
enumerate the Assignments it would need in order to walk any revisions at all. The Provider
arm's own reads remain exactly as wide as `docs/provider-access.md` says; none of them is
an export.

The console hides the affordance below `admin` through `lib/roles.ts`. That is
presentation only and never the check that holds (I1).

### What the floor does and does not cover

Be precise about what that admin floor buys, because it is easy to overstate.

It governs the **recorded export path**: the blessed action, the one that writes an audit
row and the one the console offers. It is not a claim that the underlying data is
admin-only. Every query the walk drives enforces its own chain, and most of them floor at
plain membership — `listProjects`, `listMembers`, `listLocations`, `listCostCentres`,
`listServiceKinds`, `listOrganizationEvents` and `listOrganizationServices` all admit a
viewer. A member who may read those queries can drive them with any Convex client and
assemble a byte-identical workbook **without producing an `export.requested` row**.

So the audit log records the exports that went through the product, not every bulk read of
the tenant. Closing that gap means raising the per-query floors — making the Services
screen admin-only — which trades a real working surface for a log entry, and is not a
trade this product should make. What the floor and the log genuinely give is a named,
attributable, member-only way to take the whole record out, and a refusal for anyone below
admin who asks the product for one.

The tenant boundary is unaffected either way: nothing here lets a caller read what their
own chain does not already admit, and a Provider Principal reaches none of it.

## The audit event

**Yes, an export records one**, through a new public mutation in the `audit` domain with
a fixed `export.requested` action, gated at `admin`.

`recordAuditEvent` is an internal helper called from inside domain mutations; there is no
public "record this" path today, so this is a genuinely new shape and stays narrow:

- The action literal is fixed in code. The caller does not name it.
- `organizationId` is the argument; the actor is derived server-side from the resolved
  Principal, never supplied.
- `entityType` is `organization` and `entityId` is that organization's id: an export has
  no other subject.
- Metadata is the **requested scope**: the sheet set, drawn from a closed union of sheet
  names, and `projectId` when the operator narrowed by one — validated as an id and proved
  to belong to that organization, not merely accepted alongside it (I4). No free-form
  string reaches the log. The status narrowing is deliberately not recorded: Events and
  Services have different status vocabularies, and one metadata key holding either would
  say something ambiguous about which list it narrowed.
- **`projectId` narrows the Events and Services sheets only.** Projects, Locations, Service
  Kinds — and the Cost Centres and member roster the Events sheet resolves its names
  from — are organization-wide in every export, because they are the configuration the
  operational rows point at and a Project-shaped slice of them would be missing names its
  own rows need. A reader of the log must not take a row carrying `projectId` to mean that
  only that Project left the tenant. The console says the same thing under the filter, so
  the operator is not misled either.
- The sheet list is bounded by the union itself: `sheets` is closed to the union's members
  and may not repeat, so it can never name more than the five sheets that exist. There is
  no separate length guard, because any longer array is necessarily a repeated one and such
  a guard could refuse nothing the duplicate rule does not.

It is emitted **before the walk, not after**, which is why the action says `requested`
rather than `generated`. The mutation is also the export's single authorization gate, and
a gate that runs after the data has already been read out of the tenant is decoration.
The cost of that ordering is stated plainly: the row records an **authorized extraction
that began**, and an export that fails or is cancelled mid-walk leaves a row describing a
file nobody received. Recording completion instead would mean the only member-only check
on a bulk extraction happens once the extraction is over.

## Fetching

Every sheet is filled by walking the **ordinary authorized paginated queries** the console
already uses, page by page, until `isDone`. No privileged path, no internal function, no
unbounded fetch-all endpoint, and no `.collect()` added to a public read (I6).

The export is the first console surface to drive Convex **imperatively** — `useConvex()`
and `client.query(...)` in a loop — rather than through `usePaginatedQuery`. Subscribing
to eight datasets through hooks to fill a file that is written once means holding every
page live for a screen that renders none of them. Imperative one-shot reads pass through
exactly the same authorization, and they are what makes a real progress count and a
resumable failure state possible.

Progress is reported per sheet as pages arrive. A failure at any page stops the walk,
names the sheet it stopped on, and offers a retry; nothing partial is written to disk.

## Sheets

Nine sheets, written in this order — operational first, configuration last:

| Sheet | Source |
| --- | --- |
| Events | `listOrganizationEvents` |
| Services | `listOrganizationServices` |
| Assignments | `listServiceAssignmentRows`, per exported Service |
| Assignment Revisions | `listAssignmentRevisions`, per Assignment |
| Projects | `listProjects` |
| Service Kinds & Versions | `listServiceKinds`, then `getServiceKind` per kind |
| Locations | `listLocations` |
| Providers | `listProviders` |
| Rate Cards | `listRateCards`, then `listRateCardVersions` and `getRateCardVersion` |

The two commercial operational sheets are **N+1 by construction**, and the backend is why:
`assignmentRevisions` has no Project- or Organization-scoped index and a revision row
carries no `projectId`, so revisions can only be listed one Assignment at a time. The
Assignments sheet avoids the worse half of that by using `listServiceAssignmentRows`, which
already joins each Assignment to its current and latest revision and to the Provider,
Vehicle Class and Cost Centre **names** — one query per Service rather than per Assignment.
The fan-out runs at most eight queries in flight; adding a paginated project-scoped
revision query would remove it, and is the fix if it ever bites.

Vehicle Classes are walked but are not a sheet: rate lines and revisions carry a class id,
and the export writes names. A failure there is reported against the Rate Cards sheet.

Every sheet carries its rows in the order the underlying query returns them; no sheet
re-sorts, so the file and the screen agree. Archived and retired rows are **included**,
with their status in a `status` column — an export that silently dropped them would
misrepresent the record it claims to be — and the filters below are the only thing that
removes a row.

Two columns are deliberately withheld. A Provider row exports its business contact
details but **not** `searchText` (a server-derived index column that means nothing to a
reader) or `linkedOrganizationId` (another tenant's id, and not this tenant's fact to
publish). An Assignment exports the driver's **name but not their phone number**: the name
is what an operator needs to recognise a dispatch in a spreadsheet, and a personal phone
number is the one field in this export that identifies a private individual rather than a
firm. Neither is a gap to fill later without deciding it again.

Foreign references are written as **display values, never Convex ids**: a Project name,
a Location name, a Cost Centre name, a user's name or email. Ids are not exported at all.
They are meaningless outside the deployment, they are the one column an operator might
paste back into a sheet they then try to import, and #77's import resolves everything by
name already.

## The Services column strategy

This is the issue's largest design question: Services created from different Service Kind
Versions compose different fields, so there is no single natural column set.

**Decision: one Services sheet with a stable union of columns.** Semantic columns first,
in a fixed order, then one column per distinct Field Definition encountered anywhere in
the exported rows, with blanks where a Service's version does not compose that field.

A sheet per Kind, or per Kind and Version, was rejected. It multiplies sheets by kind ×
version, and it breaks the single thing an operator opens a spreadsheet to do — sort,
filter and pivot the whole set at once. The product exists to replace a spreadsheet; an
export that fragments the one table they had is a step backwards.

The union costs nothing to compute. `listOrganizationServices` already returns
`serviceRow.fields[]` carrying `fieldDefinitionId`, `key`, `label`, `position` and the
immutable `config` snapshot — **including fields the Service holds no value for** —
so the column set falls out of the rows already fetched, with no extra query.

**The column set is the one the Services table already builds**, from
`lib/service-columns.ts` `serviceFieldColumns`: identity is the field's `key`, and the
order is the earliest `position` any version gives the field, then label, then key. The
export does not invent a second strategy. Reusing it means the file's columns are the
screen's columns, which is what an operator exporting what they are looking at expects,
and it keeps one rule to maintain instead of two that can drift.

`key` is the right identity because it is unique per organization (the `orgId + field key`
constraint) and it is the stable half of the definition join, so the same built-in field
composed by two Service Kinds is one column rather than two. The ordering is total: the
position comparison is broken by label and then by key, so a column set never depends on
which rows happened to arrive first.

**Collisions.** Two Field Definitions may share a `label`; they are different fields and
get **two columns**, and the export appends each one's key to its header so the two are
told apart. Labels are tenant-authored and carry no uniqueness guarantee, so a header must
never be the thing that identifies a column. The Services table can leave duplicate
headers alone because a reader sees the data under them; a spreadsheet column that is
sorted, filtered and referenced by its header cannot.

A Service whose version composes a field it has no value for, and a Service whose version
does not compose that field at all, both produce an empty cell. The distinction is real
but not representable in a flat sheet, and inventing a sentinel for it would corrupt every
column's type.

## Cell types

Typed cells, not localized strings. The rules below are the whole contract.

`write-excel-file` converts a `Date` to an Excel serial as
`date.getTime() / 86400000 + 25569` — **pure UTC, with no local-zone adjustment**. Every
rule here follows from that, and each has a test under `TZ=America/Bogota`, the zone the
import suite is already pinned to and the product's default locale.

| Value | Cell | Why |
| --- | --- | --- |
| `date` (`YYYY-MM-DD`) | `Date` at **UTC midnight**, format `yyyy-mm-dd` | A calendar date carries no zone. Building it at local midnight would offset the serial by the zone and roll to the previous or next day east of UTC. This mirrors the import's `excelSerialToDateString`, which reads serials with the UTC getters for the same reason. |
| `datetime` (absolute ms) | `Date` shifted by the local offset, format `yyyy-mm-dd hh:mm` | Excel has no zone, so the honest cell is the **local wall clock** the console shows. Since the conversion is UTC, the shift has to be applied before it: `ms - offset(ms)`. This is the exact inverse of the import's `composeInstant`, which composes in the browser's local zone. |
| `time` (`HH:mm`) | `Number` = fraction of a day, format `hh:mm` | A real Excel time, sortable and formattable, with no date attached. Again the inverse of the import's `excelFractionToTimeString`. |
| `number` | `Number` | Never a grouped string. |
| `boolean` | `Boolean` | |
| `text`, `longText` | `String` | Verbatim. |
| `select` | `String` — the option **label** from the version's immutable `config` snapshot | The stored value is an option id. The label is resolved through the snapshot the Service was created with, not the live field, so a renamed option does not rewrite history (I3). An id with no matching option in the snapshot exports as an empty cell rather than a raw id. |
| `multiSelect` | `String` — labels joined by `"; "` | One cell, because a column cannot vary in width per row. |
| `location` | `String` — the location name already joined by the query | |
| absent | empty cell | Never `"-"`, `"N/A"` or `""` dressed as a value. |

## Money

Money is stored as integer minor units with a fixed exponent of 2 (`docs/rates.md`).
Export writes the **major-unit number** — `minorUnits / 100` — as a `Number` cell with a
currency-appropriate number format, and the currency in its own adjacent column.

Never a pre-formatted string. Never a thousands separator baked into text. Never a blended
total across currencies, and never a conversion — there is no rate and there will not be
one. A sheet holding two currencies holds two currency values in its currency column and
leaves any cross-currency arithmetic to the operator, who knows something the product
does not.

The division is exact enough to round-trip: minor units are safe integers, and the
shortest decimal representation of `n / 100` re-reads as `n / 100`. The format string
controls the displayed decimals; the stored number stays the true value.

## Filters

The export scope is the **current Organization**, narrowed optionally by **Project** and
by a **date window**.

The Project filter is the one `listOrganizationEvents` and `listOrganizationServices`
both accept and both mean the same thing by. That narrowing applies to **those two
sheets only**. The configuration sheets stay whole: a Service in the chosen Project
points at a Service Kind, a Location and a Cost Centre, and slicing those catalogues by
Project would leave the operational rows referring to names the file does not contain.
The screen states this under the filter rather than leaving the operator to discover it
in the file.

**The date window filters Events and Services by `startsAt`.** It is inclusive at both
ends, and the operator means whole days in their own zone: `from` is the local start of
that day and `to` is its last millisecond. The Assignment and Assignment Revision sheets
follow the Services that survive, so filtering the Services array before the per-Service
assignment fan-out is enough — everything downstream follows.

No organization-scoped backend query accepts `from`/`to`, so a window can only narrow the
**file**, never the walk. The pages still come out of the tenant in full; the filter
drops rows after they have been read. Pushing the window into the backend would mean new
indexes on two domains.

The configuration sheets — Projects, Service Kinds, Locations, Providers, Rate Cards —
are **not** filtered by the window, for the same reason they are not filtered by Project.
Dropping a Location because its calendar date is out of range would leave Services
referring to a name the file does not contain.

**The audit row does not record the window.** The window removes rows from the file but
everything was still read out of the tenant, so recording it would make the row claim
less left than actually did. `projectId` is recorded because it actually narrows the
fetch.

**Status is deliberately not offered.** Events and Services have different status
vocabularies, so a single control would either narrow one sheet and not the other or
silently mean two different things per sheet. It is the same reason the audit row does not
record a status. A per-sheet status filter is a bigger control than this screen should
grow before anyone has asked for it.

## Localization

Sheet names, column headers and code-owned statuses render in the **active locale**, from
the ordinary `next-intl` catalogues.

**Tenant-authored text is exported verbatim** — Event, Service, Project, Location, Cost
Centre, Provider and Service Kind names, field labels, option labels, descriptions and
notes. The same rule the console already follows: the catalogues cover chrome and
code-owned vocabulary only, and translating a customer's own words would corrupt the
record.

The file name carries the organization name and the export date.

## Out of scope

No Provider-facing export. No server-side file generation and no scheduled or emailed
export — if browser generation ever proves insufficient, that is a separate bounded Convex
action issue, not a widening of this one. No currency conversion. No `.csv`, no Google
Sheets, and no import round-trip guarantee: the export is a record to read, and the import
has its own mapping screen for a reason.
