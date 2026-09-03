# Provider access — decision record

**Status: decided, not built.** Nothing described here exists in
`apps/convex/convex/` yet. The access chain today has exactly one principal type
(`organizationMemberships`), structurally baked into the return types of every helper in
`lib/access.ts`. This document records the target so that #82 (the rename), #92 (the Event
layer), #71 (the principal union and grants), #86 (provider accounts), #87 (the portal)
and #88 (provider writes) all implement the same model instead of six approximations of
it.

Companion to [`authorization.md`](authorization.md) (the chain as it is implemented today)
and [`../CLAUDE.md`](../CLAUDE.md) (I1–I11). This record answers decision issue #63 and
supersedes it.

## The question

The product exists "for both parts" — the coordinator who plans the movements and the
transport company that executes them. Today there is exactly one kind of participant: a
member of an Organization, holding a role on the `owner > admin > planner > operator >
viewer` ladder. I1 is written in terms of that single participant.

A transport company that signs in to see the movements addressed to it does not fit that
chain. It is not a member of the festival producer's Organization and it must never
become one: membership would expose every Project, every Service, every other provider's
tariffs, and the whole budget.

## The two shapes that were considered

### (a) Provider as a reference row inside the coordinator's tenant — REJECTED

A `providers` row in the coordinator's Organization, shaped like a Location: a name, a
contact, no identity, no login, no cross-tenant reach. The coordinator records who is
supplying, what was agreed, and which driver showed up. The provider receives a day sheet
as a PDF or an `.xlsx` export.

What is attractive about it: I1 is completely untouched, there is zero new authorization
surface, and it ships immediately.

Why it is rejected: **it does not deliver "made for both parts."** Under (a) the provider
is still working from a document somebody emailed them — which is precisely the failure
mode the platform exists to replace. The coordinator stops using a spreadsheet and the
provider keeps using one. Execution state (driver, vehicle, plate, arrival) comes back by
WhatsApp and is retyped by a coordinator, so the operational record is second-hand and
already stale when it is written. Half a product is not a smaller product; it is the same
product the workbook already is.

### (b) Provider as its own Organization with a scoped grant — CHOSEN

The transport company has its own Organization, with its own members and its own ordinary
role ladder. A `providers` row in the coordinator's tenant carries
`linkedOrganizationId`, written exactly once through the verified claim flow (#86). A
separate `providerAccessGrants` row links `(providerId, projectId)` and confers a narrow,
enumerated, closed capability set — nothing else.

The two links are deliberately separate objects. A claimed Provider with no grant reads
nothing. A revoked grant loses access on the very next call; no grant decision is ever
cached in a token, a session, or a resolved result.

What this costs, stated plainly so nobody discovers it later:

- Authorization becomes **two-dimensional**. There is a second, disjoint path to the same
  entities with a much smaller permission set. That is a change to the *shape* of the
  check, not an extra condition inside it.
- **I9 gets harder.** A provider can hold ids adjacent to data it was not granted. Probing
  them must be indistinguishable from probing ids that do not exist.
- **Audit gains a second actor dimension.** "Who did this" now needs "and on whose behalf"
  (`auditEvents.onBehalfOfProviderId`).

These are accepted. The mitigation is structural, not procedural: **one gate**.
`requireAssignmentAccess(ctx, assignmentId, intent)` (#71) is the only place either arm is
resolved. No Assignment-touching operation may inline either arm. Adding a third principal
later must be one file, not forty.

## What a Provider MAY see

Enumerated. Anything not on this list is not visible, and the list is not extensible by
configuration.

1. Its own `providers` row in the granting coordinator's tenant — the identity the
   coordinator recorded for it, and nothing else from that tenant's catalogue.
2. Its own Provider Organization: members, roles, and everything ordinarily readable
   inside a tenant it actually belongs to.
3. The Assignments addressed to it under a current, active grant, on the granted Project
   only.
4. The revisions of those Assignments — proposed, countered, accepted, declined and
   superseded terms for its own supply lines, which is its own commercial record.
5. The execution state of those Assignments: dispatch status, driver, vehicle, plate, and
   the timestamped `assignmentCheckpoints` it is entitled to write.
6. The **code-owned semantic projection** of the Service each granted Assignment links to
   — the enumerated operational fields defined in §"Visibility is a code-owned semantic
   projection" below, and no other field of that Service.

## What a Provider MAY NOT see

Enumerated, and every entry is a required negative test in #71 and #87.

1. The **Project** itself — not as a first-class read, and not smuggled back as contextual
   data hanging off an Assignment response.
2. Any **other Service** in the Project, granted or not.
3. Any **other Assignment**, including another Provider's Assignment on the same Service
   and the coordinator's own supply lines.
4. Any **other Provider's** existence, rates, execution state, or drivers.
5. **Service Kinds** (the versioned configuration formerly called Event Recipes), their
   versions, their fields, or the Field Definition catalogue.
6. The **Locations** catalogue. It sees the specific locations its own projection names,
   as values on the projection, never as a browsable tenant catalogue.
7. **Cost Centres** and the party a movement is charged to.
8. **Rate Cards**, Rate Card Versions and Rate Lines. A Provider knows what it charges,
   because that is on its own revisions; it never learns the coordinator's card, the grid
   it was resolved from, or what any other Provider charges.
9. The Event's **budget** (`budgetAmount`, `budgetCurrency`), `clientCostCentreId`, and
   accountable owner.
10. **Statistics** of any kind — counters, totals, semantic breakdowns, occupancy,
    rollups.
11. The coordinator's **audit log**, members, invitations, or organization settings.
12. Anything at all on a Project it was not granted. A grant for Project A confers nothing
    on Project B, same Provider.

## Visibility is a code-owned semantic projection

The linked-Service projection is built **exclusively from `semanticType`**. It never
matches Field Definition keys, never matches labels, and never reads a per-field flag.
`semanticRegistry` in `validators/index.ts` is already code-owned for exactly this
reason: tenant data may *name* a semantic type, but naming one can never confer a
capability the code did not already grant it.

The projection is defined once, in one exported backend file, as a closed list (#87):
`serviceName`, `serviceDate`, `serviceTime`, `serviceLocation`, `transport.origin`,
`transport.destination`, `passenger.count`, `aviation.flightNumber`, `aviation.terminal`,
`contact.primary`, `general.notes`.

Everything else is excluded by construction, not by an omitted flag. Of the semantic types
the registry declares today, that means the Service's description, `luggage.count` and
`accessibility.wheelchairCount` are outside the projection; so is every tenant field that
carries no `semanticType` at all, whatever it is called.

**There is no tenant-settable per-field audience flag, and there will not be one.**
`recipeFields.visible` is presentation metadata and is not an authorization rule (see
[`events.md`](events.md#visibility)); it must never be repurposed as one.

The trade this makes is symmetric, and both halves are deliberate:

- A tenant **cannot widen disclosure by misconfiguration.** There is no checkbox, no
  audience setting, no field-level share toggle, and therefore no way for an operator to
  hand a competitor a rival's party sizes by clicking the wrong thing. Disclosure is a
  property of the code, reviewable in one file, testable in one assertion.
- A tenant **cannot share a genuinely needed custom field without a code change.** If a
  production needs its drivers to see a field nobody anticipated, the answer is a new
  semantic type in the registry and a new entry on the projection list — a pull request,
  a review and a deploy — not a setting.

That is the correct side to be wrong on. A missing field is an inconvenience that
surfaces immediately and is fixed in one place; an over-shared field is a cross-tenant
disclosure that surfaces after the festival, if ever. This is the same reasoning as I8:
structured flexibility, no escape hatches, and no tenant-configurable disclosure rule.

## Grants are non-transitive

**A grant can never be re-granted onward. There is no subcontracting, ever.**

The real workbook shows brokering — one producer coordinating for OCESA, Promotoría and
Club Colombia — and that is structurally the same relationship one level up. Answering
"no, never" now is cheap; discovering the requirement after grants have become delegable
is not.

Concretely:

- A Provider principal has no capability to create, modify, delegate or extend a
  `providerAccessGrants` row. Grant creation and revocation are coordinator member
  operations, full stop.
- A grant confers nothing transitively through the Provider Organization's own
  memberships in other tenants. Reach is `(provider row, project)`, resolved from current
  database state on every call.
- If a broker genuinely needs to involve a second firm, the coordinator issues that firm
  its own Provider row, its own claim and its own grant. The coordinator always knows
  every party that can read its data, because the coordinator issued every grant that
  exists.

## The capability set is enumerated and closed

The grant confers a typed, closed capability set — **not a role.** The organization role
ladder is a different mechanism for a different purpose and is not reused here.

| Capability | What it permits |
| --- | --- |
| `readAssignment` | Read the granted Assignment and its revisions |
| `writeExecution` | Write execution fields — dispatch status, driver, vehicle, plate — and append bounded checkpoints |
| `respondToTerms` | Accept, counter or decline a revision; never a direct patch of commercial columns |
| `readLinkedServiceProjection` | Read the code-owned semantic projection of the linked Service |

That is the whole set. There is deliberately no `readProject`, no `readOtherAssignments`,
and no `readRates`. The capabilities do not imply one another: `writeExecution` does not
imply `respondToTerms`, and `respondToTerms` does not permit patching `unitAmount`,
`quantity`, `vehicleClassId`, `modality`, `rateCardVersionId`, `rateLineId`, `lineTotal`
or currency directly — commercial change goes through a new server-numbered revision (I7),
and accepted amounts are immutable (I10).

Adding a capability is a schema and code change with tests, reviewed as a security change.
It is not configuration.

## Two axes, and why conflating them is the failure mode

A Provider Organization is an Organization. It therefore has its own internal members with
the ordinary five-role ladder — `owner > admin > planner > operator > viewer` — governing
its *own* tenant data. That ladder is real, and it is **a separate axis from the
cross-tenant grant.**

| | Membership role | Provider grant |
| --- | --- | --- |
| Scope | One Organization's own data | One `(provider, project)` pair in *another* Organization |
| Granted by | That Organization's owners/admins | The coordinator's members, never the provider |
| Vocabulary | Five ranked roles | Four unranked, enumerated capabilities |
| Ranking | `roleAtLeast` | None — capabilities are a set, not a ladder |
| Revocation | Membership removal | Grant revocation, or link revocation, effective on the next call |

The two never compose. A Provider Organization's `owner` gains **no** coordinator
capability whatsoever; being an owner of your own firm is not an argument about somebody
else's festival. Equally, a coordinator's `viewer` gains nothing from a grant their tenant
issued.

Conflating the axes — treating the grant as "a role in the coordinator's org" or letting
the provider's internal rank widen what the grant returns — is exactly how a provider's
own admin ends up reading someone else's festival tariffs. Two principals, two
vocabularies, one gate.

## What this changes about I1 and I9

I1 becomes `identity → app user → principal (member | provider grant) → capability →
ownership of every referenced entity`. Neither arm obtains capability from identity alone,
and knowing a Convex id still grants nothing.

I9 applies to both arms identically. An ungranted Provider probing an adjacent Assignment
id receives the same `notFoundOrInaccessible()` as a stranger probing a fabricated one.
The one intentional cross-tenant signal remains the Organization slug, unchanged.

## Where this is implemented

Nowhere, yet. Sequencing:

| Issue | Stage | What it lands |
| --- | --- | --- |
| #82 | `stage:M` | The rename: `events → services`, recipe machinery → Service Kinds |
| #92 | `stage:M` | The new `events` table between Project and Service |
| #71 | `stage:N` | The `Principal` union, `providerAccessGrants`, the single `requireAssignmentAccess` gate, the closed capability set |
| #86 | `stage:P` | Provider Organization accounts: invite, verified claim, single-shot link, revocation |
| #87 | `stage:P` | The portal read surface and the one definition of the semantic projection |
| #88 | `stage:P` | Provider writes: accept / counter / decline, checkpoints |

#71 lands **both** arms of the union before any provider-facing surface exists. A
one-armed union is only a rename and does not force call sites to handle the security
boundary.
