# Authorization, roles and tenant isolation

## The access chain (I1)

Every public operation proves the same chain, implemented once in `lib/access.ts`:

```
identity (auth adapter)
  → users row for (authProvider, authSubject)
  → organizationMemberships row for the target organization
  → membership role ≥ the operation's minimum role
  → ownership of every referenced entity, re-derived from the stored graph
```

Knowing a Convex id grants nothing. `requireAuthenticatedUser`, `requireOrganizationMembership`,
`requireOrganizationRole` and `requireOrganizationAccess` are the only entry points; domains
add one resolver each on top (`requireProjectAccess`, `requireEventAccess`,
`requireLocationAccess`, `requireRecipeAccess`, `requireVersionAccess`,
`requireDraftVersionForEdit`, `requireOrganizationFieldAccess`) that loads the entity,
cross-checks its stored parent, and then delegates the role check.

Two ordering rules are load-bearing:

- **Authenticate before looking up a caller-supplied id.** An earlier implementation of
  `changeMemberRole` / `removeMember` loaded the membership before any auth check, which let
  an anonymous caller distinguish real ids from fabricated ones. Every id-taking function now
  authenticates first, and regression tests probe both unauthenticated and
  authenticated-outsider cases with real and fabricated ids.
- **Compare organizations before reporting lifecycle state.** `createRelationship` checks that
  the two events belong to the same organization *before* checking whether they are writable,
  so a caller never learns a foreign event's status from an error message.

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
| `fields.createFieldDefinition`, `updateFieldDefinition`, `archiveFieldDefinition`, `deleteFieldDefinition` | planner | Built-in definitions are not editable through any public door |
| `fields.listFieldDefinitions` | viewer | |
| `fields.listBuiltinFieldDefinitions` | authenticated app user | The catalogue is deployment-wide, not tenant data |
| `fields.createBuiltinFieldDefinition` | internal only | `internalMutation`; reachable from seeds and the CLI, never from a client — and gated on the `SANCOCHO_ENABLE_SEED` deployment opt-in, because it squats a built-in key deployment-wide and permanently |
| `recipes.createRecipe`, `updateRecipeMetadata`, `archiveRecipe`, `createInitialDraftVersion`, `clonePublishedVersionToDraft`, `publishRecipeVersion` | planner | |
| `recipes.getRecipe`, `listRecipes`, `getRecipeVersion` | viewer | |
| `recipes.fields.addRecipeField`, `updateRecipeField`, `reorderRecipeFields`, `removeRecipeField` | planner | Draft versions only (I2) |
| `recipes.fields.listRecipeFields` | viewer | |
| `locations.createLocation`, `updateLocation`, `archiveLocation`, `deleteLocation` | planner | |
| `locations.getLocation`, `listLocations` | viewer | |
| `events.createEventFromRecipe`, `updateEventCoreFields`, `updateEventFields` | planner | Authoring an event is planner work |
| `events.changeEventStatus` | **operator** | Deliberately one step lower: operators run events (activate, complete, cancel) without changing what an event says it is |
| `events.getEvent`, `listProjectEvents` | viewer | |
| `relationships.createRelationship`, `removeRelationship` | planner | Same floor as event authoring; gated by the same writability rules |
| `relationships.listOutgoingRelationships`, `listIncomingRelationships` | viewer | |
| `audit.listOrganizationAuditEvents`, `listEntityAuditEvents` | admin | Administrative visibility; planners, operators and viewers cannot read the log |

Per-field permissions do not exist. A planner may edit every field a version composes.
`recipeFields.visible` is presentation metadata, not an authorization rule — see
[`events.md`](events.md#visibility).

## Tenant isolation

- Every tenant-scoped table carries a server-derived `organizationId` (I4). It is an index
  cache; authorization walks the stored graph and rejects any row whose column disagrees with
  its parent. `removeRelationship` resolves the source event and compares, rather than
  trusting the link's own column.
- Ownership of a referenced entity means: load it, derive its organization from its stored
  parent, compare against the proven membership. `createEventFromRecipe` compares the
  project's organization against the recipe version's; `getEvent` compares the event's project
  against the event; `getRecipeVersion` and `listRecipeFields` both compare the version's
  recipe against the version.
- Foreign field definitions are refused by the same gate that refuses unknown ones: a value
  naming a definition the event's version does not compose fails with one generic error.

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
membership, project, recipe, event or location id exists at all — is opaque to a caller
without access.

Audit reads accept one free-form caller string (`entityId`) and bound it at 128 characters
after proving membership, so the bound cannot be used to probe organizations the caller
cannot read.
