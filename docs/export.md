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

**A Provider Principal cannot reach any of it.** Not by a narrower check, but because the
Provider arm is not an organization membership at all: every query above resolves through
`requireOrganizationMembership` or `requireOrganizationRole`, both of which refuse a
Principal holding only a scoped grant, and the export adds no path that skips them.
A Provider sees no export affordance and, if it forged the call, receives the same
generic not-found every other member-only read gives it (I9).

The console hides the affordance below `admin` through `lib/roles.ts`. That is
presentation only and never the check that holds (I1).

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
- Metadata is the **requested scope** — `projectId` and `status` when the operator
  narrowed by them, and the sheet set — drawn from closed unions and validated ids. No
  free-form string reaches the log.

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

The first cut covers the operational half, which is what the demo seed contains:

| Sheet | Source |
| --- | --- |
| Events | `listOrganizationEvents` |
| Services | `listOrganizationServices` |
| Projects | `listProjects` |
| Service Kinds & Versions | `listServiceKinds`, then `getServiceKind` per kind |
| Locations | `listLocations` |

The commercial half — Assignments, Assignment Revisions, Providers, Rate Cards — follows
once the supply seed (#98) exists to check it against. Its shape is fixed here so it is
not redesigned later: the Assignments sheet is built from `listServiceAssignmentRows`,
which already joins each Assignment to its current and latest revision and to the
Provider, Vehicle Class and Cost Centre **names**, and the Revisions sheet from one
`listAssignmentRevisions` walk per Assignment, because `assignmentRevisions` has no
Project- or Organization-scoped index and a revision row carries no `projectId`.

Every sheet carries its rows in the order the underlying query returns them; no sheet
re-sorts, so the file and the screen agree. Archived and retired rows are **included**,
with their status in a `status` column — an export that silently dropped them would
misrepresent the record it claims to be — and the filters below are the only thing that
removes a row.

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

**Column order is by the field's `key`**, ascending, after the semantic columns.
`position` cannot order this set: the same Field Definition sits at different positions
in different versions, so position gives no total order across a union. `key` is unique
per organization (the `orgId + field key` constraint), so it is total, stable across
exports, and independent of which Services happened to be in range.

**Collisions.** Two Field Definitions may share a `label`; they are different fields and
get **two columns**, each header disambiguated by its key. Labels are tenant-authored and
carry no uniqueness guarantee, so a header must never be the thing that identifies a
column.

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

The export scope is the **current Organization**, plus the same narrowings the list
surfaces offer: **Project** and **status**, matching `listOrganizationEvents` and
`listOrganizationServices` exactly.

There is no backend date window to match. #36 asked for filters matching the "list or
statistics" filters, but the statistics subsystem was deleted by #93 and its issues (#70,
#76) closed as descoped; no organization-scoped query accepts `from` or `to`. A date
window is therefore applied **client-side to the rows already walked**, and it is
documented in the UI as narrowing the file rather than the fetch. Pushing a window into
the backend means new indexes on two domains and belongs to whatever rebuilds statistics
against the reshaped model.

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
