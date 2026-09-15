# Authorization, roles and tenant isolation

## The access chain (I1)

I1 is a **two-path** model:

```
identity (auth adapter)
  → users row for (authProvider, authSubject)
  → principal
      ├─ member:   organizationMemberships row for the target organization
      └─ provider: an active providerAccessGrants row for (provider, project)
  → capability
      ├─ member:   membership role ≥ the operation's minimum role
      └─ provider: the requested intent ∈ the grant's closed capability set
  → ownership of every referenced entity, re-derived from the stored graph
```

Knowing a Convex id grants nothing, on either path. Neither arm derives capability from
identity alone: a member proves a stored membership row and a role rank, a provider proves
a stored grant row and a named capability. The two vocabularies do not compose — a
provider's rank inside its *own* Organization confers nothing here, and a coordinator's
role confers nothing through a grant its tenant issued.

**Both paths exist in code.** #71 landed the second arm: the `Principal` discriminated
union, the `providerAccessGrants` table, the closed capability set, and one gate. The
decision it implements is recorded in [`provider-access.md`](provider-access.md),
including the enumerated may-see / may-not-see lists and the rule that grants are
non-transitive.

Error discipline is identical on both paths (I9): an ungranted provider probing an
adjacent id gets the same generic error as a stranger probing a fabricated one. Audit
carries both actor dimensions — which user, acting under which grant
(`auditEvents.onBehalfOfProviderId`, absent on member-arm rows).

### The single gate

```
requirePrincipalForProject(ctx, projectId, intent) -> MemberPrincipal | ProviderPrincipal
```

`convex/lib/access.ts` is the ONLY module that resolves which kind of principal a caller
is, and the only reader of `providerAccessGrants` for authorization. No operation inlines
either arm; adding a third principal must remain a change to that one file.
`tests/providerAccess.test.ts` asserts that mechanically over the sources — the gate is
defined once, `providerAccessGrants` has exactly two readers in the codebase (this gate,
and `providers/grants.ts` which owns the row's lifecycle), and the resolution index
`by_providerOrganization_project` has exactly one reader besides its definition.

`requireAssignmentAccess(ctx, assignmentId, intent)` is **#67's** thin wrapper: it resolves
an Assignment to its Project and delegates here, adding no policy of its own. It does not
exist yet, because `assignments` does not. The build-order decision recorded on #71 chose
this shape deliberately over landing an empty `assignments` shell, and moved four
Assignment-level required tests to #67 and one to #87 rather than stubbing them.

Three orderings inside the gate are load-bearing:

1. **Authenticate before the caller-supplied id is loaded**, so a fabricated project id and
   a real foreign one are indistinguishable to an anonymous caller.
2. **The member arm is tried first.** It is the overwhelming case and costs one indexed
   read; the provider arm's membership walk is only reached by callers who are not members
   of the owning tenant. A caller who *is* a member but whose role does not reach the
   intent is refused there rather than falling through to the provider arm — somebody
   deliberately admitted as a `viewer` does not get more by also belonging to a granted
   provider firm.
3. **Every failure leaves through one `notFoundOrInaccessible()`** — no project, no
   principal, insufficient role, revoked grant, dead claim, unheld capability.

### The provider arm

A `providerAccessGrants` row says: coordinator `organizationId` has granted Provider
`providerId` — whose claimed Organization is `providerOrganizationId` — access to
`projectId`. Nothing else. The row carries **no capability column, no role column and no
delegation column**: what a grant confers is code-owned and closed, so widening a
provider's reach is a reviewed code change, never a row a coordinator can edit (I8).

Resolution walks from the CALLER's side — the signed-in user's own memberships, then "does
this Organization hold a grant on this Project?" — which keeps the work proportional to the
caller rather than to how many firms a festival engaged. Six conditions are re-proven from
stored rows on every single call, and none of them is cached anywhere:

| Re-proven every call | Why |
| --- | --- |
| `grant.status === 'active'` | Revocation bites on the very next call |
| `grant.projectId` (the index range) | A grant for Project A is not in the range read for Project B |
| `grant.organizationId === project.organizationId` | The denormalized coordinator column is checked, never trusted (I4) |
| `provider.organizationId === project.organizationId` | The Provider row must be the granting coordinator's own directory entry |
| `provider.status === 'active'` | Archival is the coordinator's off switch |
| `provider.linkedOrganizationId === membership.organizationId` | THE claim check — revoking or re-pointing a claim kills every grant riding on it without editing a grant row |

The capability set is closed and code-owned:

| Capability | Member-arm equivalent |
| --- | --- |
| `readAssignment` | `viewer` |
| `readLinkedServiceProjection` | `viewer` |
| `writeExecution` | `operator` |
| `respondToTerms` | `planner` |

It is a SET, not a ladder: nothing in it implies anything else in it, and `roleAtLeast` is
never applied to it. There is deliberately no `readProject`, no `readOtherAssignments` and
no `readRates`. The member column is the other axis — how a coordinator's ranked role
answers the same question the grant answers by enumeration — and the two never compose.

`ProviderPrincipal` carries **identifiers only** (`providerId`, `providerOrganizationId`,
`grantId`, `capabilities`), never the rows they came from. That is a confinement decision
distinct from the authorization one: a capability says what a caller may *do* and says
nothing about what a handler may then *return*. Were the principal to carry
`Doc<'providers'>`, any handler authorized for `readAssignment` would be one property
access away from returning the coordinator's private `notes` about that firm — with the
compiler's blessing. A consumer that needs another column adds a named field to that type
deliberately.

### Grant administration is member-only, by construction

`convex/providers/grants.ts` writes grant rows; `lib/access.ts` reads them. Every entry
point there proves a coordinator membership at the `admin` floor through
`requireProjectAccess` / `requireOrganizationRole`, whose return type is
`OrganizationMembershipAccess` — which a Provider Principal can never satisfy, because a
granted firm holds no membership in the granting tenant. **Non-transitivity is therefore
structural, not a rule**: a provider cannot create, delegate, extend or re-grant access,
and there is no delegation column and no code path that would read one.

Creation requires four independent parties to agree, each checked separately: the caller is
an `admin` of the Project's organization; the Provider row belongs to that same
organization; the Provider is claimed, with the granted Organization derived from the row's
own `linkedOrganizationId` (never from a client argument, I4); and that Organization is not
the coordinator itself (`providerGrantSelfReference` — granting to yourself would
manufacture a provider principal out of your own members). An unclaimed Provider is refused
at creation with `providerGrantRequiresClaim`, and resolution independently refuses too, so
a claim revoked afterwards kills the grant without editing it.

Uniqueness is `providerId + projectId`, an indexed read-before-write in the same mutation.
Re-granting after revocation reactivates the existing row rather than inserting a second
one, so no resolution path ever has to choose between two grants for one pair. Revocation
is idempotent — access withdrawal must never be refusable. A Provider referenced by any
grant, active or revoked, cannot be deleted: revoked rows are the record of who used to be
able to read a Project, and orphaning them would leave a dangling `providerId`.

### The member path today

Every public operation proves the member chain, implemented once in `lib/access.ts`.
`requireAuthenticatedUser`, `requireOrganizationMembership`,
`requireOrganizationRole` and `requireOrganizationAccess` are the only entry points; domains
add one resolver each on top (`requireProjectAccess`, `requireServiceAccess`,
`requireLocationAccess`, `requireServiceKindAccess`, `requireVersionAccess`,
`requireDraftVersionForEdit`, `requireOrganizationFieldAccess`) that loads the entity,
cross-checks its stored parent, and then delegates the role check.

Two ordering rules are load-bearing:

- **Authenticate before looking up a caller-supplied id.** An earlier implementation of
  `changeMemberRole` / `removeMember` loaded the membership before any auth check, which let
  an anonymous caller distinguish real ids from fabricated ones. Every id-taking function now
  authenticates first, and regression tests probe both unauthenticated and
  authenticated-outsider cases with real and fabricated ids.
- **Compare organizations before reporting lifecycle state.** `createRelationship` checks that
  the two services belong to the same organization *before* checking whether they are writable,
  so a caller never learns a foreign service's status from an error message.

`preResolvedUser` threads an already-proven `AuthenticatedUser` into the membership helpers so
the app user is read once per request. It can only be produced by `requireAuthenticatedUser`,
so passing it skips no link of the chain.

## Roles

`owner > admin > planner > operator > viewer`, ranked in `lib/roles.ts`. `roleAtLeast` is the
only rank comparison in the codebase; no domain module compares role strings.

`canAssignRole` states the ownership policy once: any change that *touches* the owner role —
granting it, or altering or removing an existing owner — requires the actor to be an owner.
Admins do everything else.

### Minimum role per operation

| Operation | Minimum role | Additional policy |
| --- | --- | --- |
| `auth.ensureUser`, `auth.getCurrentUser` | authenticated identity | No membership involved |
| `organizations.createOrganization` | authenticated app user | Creator becomes `owner` in the same transaction |
| `organizations.listMyOrganizations` | authenticated app user | Returns only the caller's memberships |
| `organizations.getOrganization`, `listMembers` | viewer | Membership required |
| `organizations.updateOrganization` | admin | Name only; the slug is immutable |
| `organizations.addMember` | admin | Granting `owner` requires `owner`. No consent step — see [known gaps](deviations.md#known-gaps) |
| `organizations.changeMemberRole` | admin | Granting or revoking `owner` requires `owner`; the final owner can never be demoted |
| `organizations.removeMember` | admin | Removing an `owner` requires `owner`; the final owner can never be removed |
| `projects.createProject`, `updateProject`, `archiveProject` | planner | Archived projects are read-only |
| `projects.getProject`, `listProjects` | viewer | |
| `providers.createProvider`, `updateProvider`, `archiveProvider`, `deleteProvider` | admin | Deletion is blocked while a claim or any access grant references the Provider |
| `providers.getProvider` | viewer | A Provider Principal may read only the row named by one of its live grants; the response omits coordinator-private/internal columns |
| `providers.listProviders` | viewer | Provider Principals are refused: the coordinator's directory is not browsable by an outside firm |
| `providers.grantProjectAccessToProvider`, `revokeProviderAccessGrant` | **admin** | Same floor as editing the directory that names the firm. Provider Principals cannot reach either (non-transitivity) |
| `providers.listProjectProviderAccessGrants` | **admin** | Includes revoked rows; there is no provider-side counterpart, which would disclose which other firms were engaged |
| `events.createEvent`, `updateEvent`, `changeEventStatus`, `archiveEvent`, `deleteEvent` | planner | Completed projects accept no new Events; archived projects freeze Event writes; Events must be archived and unreferenced before deletion |
| `events.getEvent`, `listProjectEvents` | viewer | |
| `events.getEventDetail` | viewer | The header join. A venue, client Cost Centre or accountable person that is missing, or that belongs to another tenant, degrades to `null` rather than refusing the Event or disclosing the foreign row (I9). The accountable person also degrades to `null` once their membership is removed, so a name stops leaving a tenant the person has left |
| `events.listOrganizationEvents` | viewer | `projectId`, when given, is cross-checked against `organizationId`. Each page's rows are re-derived through their stored Project rather than trusted from the denormalized `events.organizationId` the index selected on (I4) |
| `fields.createFieldDefinition`, `updateFieldDefinition`, `archiveFieldDefinition`, `deleteFieldDefinition` | planner | Built-in definitions are not editable through any public door |
| `fields.listFieldDefinitions` | viewer | |
| `fields.listBuiltinFieldDefinitions` | authenticated app user | The catalogue is deployment-wide, not tenant data |
| `fields.createBuiltinFieldDefinition` | internal only | `internalMutation`; reachable from seeds and the CLI, never from a client — and gated on the `PRIAMO_ENABLE_SEED` deployment opt-in, because it squats a built-in key deployment-wide and permanently |
| `serviceKinds.createServiceKind`, `updateServiceKindMetadata`, `archiveServiceKind`, `createInitialDraftVersion`, `clonePublishedVersionToDraft`, `publishServiceKindVersion` | planner | |
| `serviceKinds.getServiceKind`, `listServiceKinds`, `getServiceKindVersion` | viewer | |
| `serviceKinds.fields.addServiceKindField`, `updateServiceKindField`, `reorderServiceKindFields`, `removeServiceKindField` | planner | Draft versions only (I2) |
| `serviceKinds.fields.listServiceKindFields` | viewer | |
| `locations.createLocation`, `updateLocation`, `archiveLocation`, `deleteLocation` | planner | |
| `locations.getLocation`, `listLocations` | viewer | |
| `services.createServiceFromServiceKind`, `updateServiceCoreFields`, `updateServiceFields` | planner | Authoring a service is planner work |
| `services.changeServiceStatus` | **operator** | Deliberately one step lower: operators run services (activate, complete, cancel) without changing what a service says it is |
| `services.getService`, `listProjectServices`, `listEventServices` | viewer | |
| `services.listOrganizationServices` | viewer | `projectId`, when given, is cross-checked against `organizationId` |
| `relationships.createRelationship`, `removeRelationship` | planner | Same floor as service authoring; gated by the same writability rules |
| `relationships.listOutgoingRelationships`, `listIncomingRelationships` | viewer | |
| `audit.listOrganizationAuditEvents`, `listEntityAuditEvents` | admin | Administrative visibility; planners, operators and viewers cannot read the log |

Per-field permissions do not exist. A planner may edit every field a version composes.
`serviceKindFields.visible` is presentation metadata, not an authorization rule — see
[`services.md`](services.md#visibility).

## Tenant isolation

- Every tenant-scoped table carries a server-derived `organizationId` (I4). It is an index
  cache; authorization walks the stored graph and rejects any row whose column disagrees with
  its parent. `removeRelationship` resolves the source service and compares, rather than
  trusting the link's own column.
- Ownership of a referenced entity means: load it, derive its organization from its stored
  parent, compare against the proven membership. `createServiceFromServiceKind` compares the
  project's organization against the service kind version's; `getService` compares the service's project
  against the service; `getServiceKindVersion` and `listServiceKindFields` both compare the version's
  service kind against the version.
- Foreign field definitions are refused by the same gate that refuses unknown ones: a value
  naming a definition the service's version does not compose fails with one generic error.

## Error discipline (I9)

`lib/errors.ts` defines four throws, and which one is used is a policy decision:

| Helper | Message | Used when |
| --- | --- | --- |
| `unauthenticated()` | `Unauthenticated` | No identity on the request |
| `notFoundOrInaccessible()` | `Not found or inaccessible` | Missing entity, wrong tenant, insufficient role, or a caller-supplied reference that fails a tenant check — indistinguishable by design |
| `conflict()` | `Conflict` | A uniqueness or invariant collision whose subject must not be disclosed (slug taken, duplicate draft, final owner) |
| `invalidInput(message)` | Specific | The caller's *own* input is malformed or their *own* data is in the wrong state. The message may be specific because it discloses nothing about another tenant |

The dividing line, applied consistently: an id that arrives from the caller and fails a
tenant check is generic; a rule about data the caller already owns is specific. Publishing
reports specific errors about rows the organization stored, while composition reports the
generic error for a caller-supplied definition id — same predicate (`isUsableDefinition`),
different caller, different error.

**The one intentional cross-tenant signal** is the organization slug. Slugs are a
deployment-wide namespace, so a conflict at creation necessarily reveals that *some*
organization holds the slug. It never reveals which. Everything else — including whether a
membership, project, service kind, service or location id exists at all — is opaque to a caller
without access.

Audit reads accept one free-form caller string (`entityId`) and bound it at 128 characters
after proving membership, so the bound cannot be used to probe organizations the caller
cannot read.
