# Deliberate deviations and decisions

Every deviation from the original issue specs, and every decision that a reader of the specs
alone would find surprising, recorded with its reason. Harvested from the closing comments of
issues #1–#14 and from the code they produced. This is the record that must survive; the
issue tracker is not a durable substitute.

"Where" points at the authoritative statement in the code or docs.

## Tooling and build

| Decision | Why | Where |
| --- | --- | --- |
| Tests run under **vitest + `@edge-runtime/vm`**, not `bun test` | convex-test requires the edge-runtime environment to simulate the Convex runtime; bun's native runner cannot provide it. bun stays as package manager and script runner | `apps/convex/vitest.config.ts`, `README.md` |
| `convex codegen` needs a configured deployment; development used an **anonymous local one** (`CONVEX_AGENT_MODE=anonymous convex dev --once`) | Offline codegen with no Convex login and no cloud project. A fresh clone must configure a deployment once before `bun run codegen` works — but not before `typecheck`/`test`, because `_generated` is committed | `README.md` |
| `CLERK_JWT_ISSUER_DOMAIN` must be set **on the deployment** or every push and codegen fails | `auth.config.ts` throws on an unset issuer instead of silently matching none; the Convex CLI also refuses the push | `apps/convex/convex/auth.config.ts`, `README.md` |
| convex-test's documented glob `!(*.*.*)*.*s` is replaced with the array form plus a `.d.ts` exclude, and a minimal ambient `import.meta.glob` type is declared | The documented extglob matches nothing under vitest 4; bun does not hoist `vite`, so `vite/client` types do not resolve | `apps/convex/tests/helpers.ts`, `apps/convex/tests/import-meta.d.ts` |
| `@edge-runtime/vm` pinned to `^5` | `^6` does not exist | `apps/convex/package.json` |
| `convex/_generated` is committed | Source imports work immediately after checkout, and the clone-to-tests path needs no deployment | `.gitignore` |

## Identity and auth

| Decision | Why | Where |
| --- | --- | --- |
| **No Clerk webhooks.** Users are provisioned on demand by an idempotent `ensureUser` mutation | Webhooks would push Clerk-shaped payloads into domain code and break the provider-swap story | `auth/model.ts`, [`auth.md`](auth.md) |
| The **`fva` (factor verification age) claim is unavailable** to the backend | Clerk excludes it from the Convex identity. Any future step-up auth must use frontend reverification; no server-side permission may depend on factor age | [`auth.md`](auth.md), `architecture-review.md` §2 |
| `authProvider` stores the **full normalized token issuer**, not a `'clerk'` label | Subjects are unique only within an issuer. Hostname matching collapsed distinct Clerk instances into one subject space (an account-takeover vector) and broke custom-domain migrations. Consequence: changing an issuer URL is an identity migration | `lib/authAdapter.ts` |
| Email is persisted **only when the provider reports it verified**, and is never an identity key | A future invite flow must not be pre-claimable with an attacker-supplied address | `auth/model.ts` |
| `getCurrentUser` maps its response explicitly instead of returning the document | Internal identity keys stay server-side, and schema drift becomes a compile error | `auth/queries.ts` |

## Tenancy, roles and errors

| Decision | Why | Where |
| --- | --- | --- |
| Denormalized server-derived `organizationId` on every tenant-scoped table | Indexed tenant access without join walks. The stored entity graph stays authoritative; the column is a cache and is cross-checked, never trusted | `schema.ts`, [`architecture.md`](architecture.md) |
| **Slug conflicts are the one intentional cross-tenant signal** | Organization slugs are a deployment-wide namespace, so a conflict necessarily reveals that *some* tenant holds the slug — never which one | `organizations/model.ts`, [`authorization.md`](authorization.md) |
| Every id-taking mutation authenticates **before** the lookup | `changeMemberRole` / `removeMember` were an unauthenticated existence oracle on membership ids (found by runtime probe, #5) | `lib/access.ts` call sites, [`authorization.md`](authorization.md) |
| Lifecycle checks are ordered **after** the org comparison in `createRelationship` | A caller must never learn a foreign service's status from a specific error | `relationships/model.ts` |
| **Operators may change service status**; authoring stays planner+ | Operators exist to *run* services (activate, complete, cancel on the ground) without changing what a service says it is | `services/model.ts` (`operatingRole`), [`authorization.md`](authorization.md) |
| `by_org_role` index for cheaper owner counting was not added | Owner counting reads the `by_org_user` org prefix, which is also what makes concurrent owner removals conflict. Optimization deferred | `organizations/model.ts` |
| **Invitations (#56) are addressed to an email, never a user id, and nothing looks a user up by address** | The only way to keep "invite an address with an account" indistinguishable from "invite one without" (I9). Acceptance proves the caller is the recipient by comparing the authenticated caller's own `users.email` — which `auth/model.ts` only ever sets from a provider-*verified* claim — against the invitation's stored (normalized) address; a mismatch returns the same generic error as a missing invitation, before anything about the invitation's lifecycle state is revealed | `invitations/model.ts:acceptInvitation` |
| Invitation `expired` status settles **asymmetrically**: `createInvitation` writes it, `acceptInvitation` never does | A Convex mutation is one atomic transaction — a status write made right before `acceptInvitation` throws its rejection would be rolled back with everything else in the call, so accept compares `expiresAt` to now directly instead and leaves `status` untouched. `createInvitation` is a success path (no throw after its write), so when its duplicate-address check finds a `pending` row already past `expiresAt`, it settles that row to `expired` and proceeds — which is also what frees the address up for re-inviting instead of reporting a bare `conflict()` against a dead row (found by `invariant-auditor` on #56). No cron sweep exists (I8). Every OTHER reader (the pending-invitation lists) still treats a `pending` row past `expiresAt` as effectively expired rather than trusting `status` alone, since nothing guarantees a `createInvitation` call has run against that address since it lapsed | `invitations/model.ts` |
| `users.email` normalization happens **at comparison time in the invitations domain, not at storage time in `auth/model.ts`** | `auth/model.ts` stores the provider's email claim verbatim (no case folding), while `organizationInvitations.email` is stored trimmed+lowercased. `invitations/model.ts:normalizeEmailForComparison` folds both sides to the same case wherever an invitation is matched against the caller's own email (`acceptInvitation`, `listMyPendingInvitations`) — found by `invariant-auditor` on #56 as a HIGH defect (a mixed-case IdP claim could see an empty pending-invitations list forever). Normalizing at write time in `auth/model.ts` instead would be the more thorough fix (it would also fix member-roster/display consistency) but changes a shared, deployment-wide table read by every domain and would need a backfill migration for existing rows; the local fix is scoped to this domain and sufficient for correctness here | `invitations/model.ts` |
| A **membership** invitation's role is authorized once at creation; a `providerClaim` re-authorizes its inviter at acceptance | The #56 membership behavior remains deliberately pinned: demoting or removing its inviter does not cancel the promised role. #86 closes that gap for the cross-tenant claim arm because completing it manufactures a new principal path into coordinator data: the inviter must still hold `admin` at acceptance or the claim is refused. Neither arm uses a user lookup by email, and no offboarding cascade is introduced | `invitations/model.ts`, `providers/model.ts`, `tests/invitations.test.ts`, `tests/providerClaims.test.ts` |

## Fields, service kinds and versions

| Decision | Why | Where |
| --- | --- | --- |
| The **semantic registry is frozen TypeScript, not data** | Tenants may name a semantic type but can never grant a capability (I8). A compile-time guard keeps the validator's literals in sync with the registry keys | `validators/index.ts` |
| `serviceKindFields` snapshot the **whole config union** (data type + rules + options), not just select options | Makes I3 structural: historical validation reads the snapshot and never the live definition, and mismatched rules/type combinations are unrepresentable | `schema.ts`, `validators/index.ts` |
| **Snapshots are taken at draft-composition time, and publish validates coherence** — it does not overwrite them | A service kind may narrow a definition for its own use (tighter bounds, option subsets). Publishing re-checks kind identity, narrowing-only bounds and option-subset against the definition as it stands then, so a stale snapshot fails publishing honestly. This resolved an ambiguity in the Stage A review; `architecture-review.md` §7 was updated to match | `serviceKinds/model.ts:assertSnapshotCoherentWithDefinition`, [`service-kinds.md`](service-kinds.md#the-snapshot-contract) |
| One coherence rule for add, update **and** publish | The rule existed twice and had already diverged: composition enforced narrowing-only bounds, publish did not, and clone bypassed composition entirely | `serviceKinds/model.ts` |
| Field-definition immutability triggers on reference by a **published or retired** version | Retired versions remain historically interpretable, and counting them is what makes `getService`'s live `key` join safe. Narrowing to published-only would break I3 with nothing failing in the fields tests — commented at both sites | `fields/model.ts:isReferencedByPublishedVersion`, `services/model.ts:getService` |
| `label` and `description` stay editable after the freeze | A display string has no identity meaning; a rename should be visible immediately | `fields/model.ts` |
| Immutability gates on **change**, not on argument presence | A read-modify-write client echoing the current values back must not be rejected | `fields/model.ts` |
| Key rules (format, per-org uniqueness, built-in shadow probe) live in one helper used by create **and** rename | Create-then-rename skipped the shadow probe, which would have let a custom key permanently shadow a built-in once published | `fields/model.ts:assertKeyAvailable` |
| `assertValidFieldConfig` validates config *contents* (finiteness, bound ordering, calendar/clock validity, option identity, satisfiable selection bounds) | Convex validators are structural only. An incoherent config would be frozen verbatim into an immutable snapshot and become permanent | `fields/model.ts` |
| `maxFieldsPerVersion = 200` is enforced | Makes the "bounded child set" claim that justifies `.collect()` structural rather than assumed (I6) | `serviceKinds/model.ts` |
| `archiveServiceKind` retires the live published version in the same transaction | An archived service kind must stop being a source of new services while its versions stay readable (I3) | `serviceKinds/model.ts` |
| Hard-deleting a `serviceKindFields` row is allowed, but only in a draft | A version never returns to draft, so no draft row can be the rule set behind an existing service. The argument is written down at the call site | `serviceKinds/fields/model.ts:removeServiceKindField` |

## Services and relationships

| Decision | Why | Where |
| --- | --- | --- |
| Service Kind defaults are **materialized at service creation only** | Before the required-field check, so a required field with a default succeeds when omitted; and never re-applied on update, because after creation an absent value is a deliberate state | `services/model.ts` |
| Materialized defaults go through the same validation gate as submitted values | A default whose location has since been archived must fail creation exactly as an explicit value would | `services/model.ts` |
| `visible: false` is **presentation metadata**, not a write or read rule | A hidden field may legitimately hold a value (a materialized default, or a value written when it was visible). Enforcing on write would let a version orphan values it owns; enforcing on read would hide data the audit trail says exists | `services/model.ts`, [`services.md`](services.md#visibility) |
| **Archival is a freeze through every door**, relationships included | Links could otherwise be created and removed on services in a fully archived project. One definition of "writable service" (`assertServiceWritable`) is shared by both domains | `services/model.ts`, `relationships/model.ts` |
| Archiving a project is allowed regardless of how many services it holds | A project with services is exactly the project worth archiving; a reference guard would make the most-used projects unarchivable. Archival freezes, it does not cascade | `projects/model.ts:archiveProject` |
| A `completed` project accepts no new services but its existing ones stay editable | A finished piece of work should be correctable without being reopened | `services/model.ts:assertProjectAcceptsNewServices` |
| **Services are never hard-deleted**; cancellation is the terminal path | They are operational records | `services/model.ts`, [`deletion-and-archival.md`](deletion-and-archival.md) |
| `updateServiceFields` does not re-validate a submitted value **identical to the stored one** | The gate ran on every submitted value while the diff happened afterwards, so a read-modify-write client (load service, edit one field, resubmit the form) failed on an untouched location value once that location was archived — with a bare "not found" on a service in its own org and no repair path. Structural checks (unknown field, duplicate definition, clearing a required field) still run over the whole submission. Same "gate on change, not on argument presence" rule the fields domain states | `services/model.ts:validateServiceAgainstServiceKind`, [`services.md`](services.md#updating) |
| Typed-value edits audit as **`service.fieldsUpdated`**, core-column edits as `service.updated` | Both write `metadata.changedFields`, but one holds field-definition ids and the other column names; one action for both left log consumers sniffing the value to tell which vocabulary they were reading | `validators/index.ts`, `services/model.ts` |
| **Absolute caps on stored string values** (`text` 2000, `longText` 10000), enforced on the value AND on any config that would promise more | A snapshot's `maxLength` is optional (the seeded `notes` built-in omits it), so values were unbounded. Writes stay small — one row per field — but `getService` collects them all, and the I6 argument for that collect bounds the row COUNT, not the bytes: a few huge values make a Service permanently unreadable while still writable, and Services are never deleted | `fields/values.ts`, `fields/model.ts:assertValidFieldConfig` |
| `projects.description` is bounded at **2000** characters | It was the only unbounded free-text column left (siblings: field/service kind descriptions 2000, addresses 500, names 200). `listProjects` pages whole documents and projects are never deleted, so enough oversized rows would make a tenant's project list permanently unreadable | `projects/model.ts` |
| `updateProject` cannot set `status: 'archived'` | It would bypass `archiveProject`'s own audit action and its documented policy; the transition helper routes it | `projects/model.ts` |
| **Two directional relationship queries** rather than one merged list | No index spans both source and target; merging would require an unbounded read before pagination (I6) | `relationships/model.ts` |
| An anomalous row is skipped inside a relationship page, not thrown on | One inconsistent row would otherwise make an entire directional list permanently unreadable. A short page is legal in Convex pagination | `relationships/model.ts:joinCounterparts` |
| `relationship.created` records both endpoints | Rows are hard-deleted, so a created entry read in isolation must still describe the link | `relationships/model.ts` |
| No cycle detection, no traversal, no workflow execution | Structured link catalogue, not a workflow engine (I8) | `relationships/model.ts` |
| Finiteness is checked at runtime everywhere a number is stored or compared | Convex `v.number()` accepts `NaN` / `Infinity`, which silently pass every ordering comparison | `validators/index.ts:isFiniteNumber` and its callers |

## Locations

| Decision | Why | Where |
| --- | --- | --- |
| Location values are **references to the live entity**, not snapshots | Reference data stays correctable in one place. The cost — later edits are visible from historical services — is accepted; audit-grade snapshots are future work | `locations/model.ts`, [`locations.md`](locations.md) |
| `serviceKindFields.defaultLocationId` mirror column + `by_defaultLocation` index | `deleteLocation` guarded only `serviceFieldValues`, missing location defaults frozen inside published (immutable) versions; deleting one would have left a dangling reference in a version that can never be repaired | `schema.ts`, `locations/model.ts:deleteLocation` |
| Both mirrors are derived through one shared helper on every write path, including clears | A path that forgets the mirror leaves a location deletable while still referenced | `fields/values.ts:locationIdFromValue` |
| Coordinates cannot be cleared through `updateLocation` | Clients omit both or supply replacements; the merged pair is validated | `locations/model.ts` |

## Audit

| Decision | Why | Where |
| --- | --- | --- |
| Convex `_creationTime` is the log's time axis; there is **no `createdAt` column** (deviates from the issue text) | The column already exists and `by_org` orders on it | `validators/index.ts:auditEventFields`, [`audit.md`](audit.md) |
| `actorId?` is implemented as a **required `actorUserId`** (stricter than the issue text) | Every audited operation has a proven actor | `validators/index.ts` |
| Metadata keys are enforced by a **compile-time** allowlist plus a runtime check | A misspelled key should fail `typecheck`, not throw inside a domain mutation | `audit/model.ts:AuditMetadata` |
| One **global** key set instead of per-action maps | Every call site is in this repo and already states its keys; a per-action map would duplicate that and add a second place to edit | `validators/index.ts` |
| Server summaries are **truncated**, caller-influenced values are **rejected** | The 512-char cap otherwise aborted legitimate bulk edits (~15+ changed values) and blamed the user's input for the log's own limit. Invariant: no domain mutation can fail because of its own audit row | `audit/model.ts:sanitizeAuditMetadata` |
| The **org-less audit gap** is accepted: `ensureUser` and built-in field seeding write no audit row | `auditEvents.organizationId` is non-optional; making it nullable would weaken the tenant-scoped index every audit read depends on, for two idempotent provisioning operations | `validators/index.ts:auditEntityTypeValidator`, [`audit.md`](audit.md#the-org-less-gap) |
| Audit is append-only by construction | No audit mutation exists anywhere, so there is no write path to authorize | `audit/queries.ts` |

## Seeds (Stage D)

| Decision | Why | Where |
| --- | --- | --- |
| Every seed write goes through the **ordinary domain functions**; zero direct `ctx.db` writes | The demo proves the invariants (publish validation, server-assigned version numbers, the typed-value gate, mirror derivation) instead of sidestepping them | `seed/mutations.ts` |
| `PRIAMO_ENABLE_SEED` deployment opt-in guards all three seed mutations **and `createBuiltinFieldDefinition`** | Seeding is irreversible: it consumes the deployment-wide-unique demo slug (no `deleteOrganization` exists) and permanently squats built-in field keys for every tenant. Creating a single built-in is the same irreversible effect through a fourth door, so it asserts the same switch; being an `internalMutation` is not a guard against whoever can run `convex run --prod`. The guard therefore lives outside `seed/` | `lib/seedGuard.ts`, `fields/mutations.ts` |
| The seed accepts an optional **real owner identity**, and `grantDemoMembership` repairs an already-seeded deployment | The original fabricated issuer matched no possible token, leaving the demo organization unadministrable *and* unremovable | `seed/mutations.ts` |
| Built-in keys, service kind field order and per-field `required` flags are declared explicitly, never derived from array position | All three freeze at publish (I2) and a built-in key is permanent deployment-wide. Deriving `required` from an index once coupled it to catalogue order | `seed/mutations.ts` |
| The demo service's `startsAt` is a literal absolute timestamp for an 18:40 local arrival | Demonstrates the temporal rule that `startsAt` is an instant, and keeps every seeded deployment and test run identical | `seed/mutations.ts` |

## Known gaps

Deferred deliberately (tracked in issue #18). None of these are bugs discovered late; each was
a decision to stop rather than guess.

1. **Resolved by #56.** `addMember` still has no consent step and is still callable by any
   admin, but it is no longer the user-facing path: `invitations.createInvitation` →
   `invitations.acceptInvitation` (`invitations/model.ts`) is, and it is addressed to an email,
   never a user id, with membership created only inside the recipient's own `acceptInvitation`
   call. `addMember` stays public rather than becoming `internalMutation` because ~70 existing
   test fixtures across every other domain's suite provision memberships through it directly;
   migrating all of them to route through invitations is a mechanical follow-up, not part of
   #56. No product surface calls `addMember` anymore. `organizations/model.ts` carries the note.
2. **Field archival is irreversible, and asymmetric with the location case.** There is no
   unarchive for a field definition, and an archived field cannot be composed into a draft —
   so a clone-then-publish of a version that uses it fails until the field is removed from
   the draft (recoverable, unlike the location case below, which degrades an already-published
   immutable version with no repair at all). Both are the same underlying choice: archival is
   a one-way lifecycle, and the reference guards protect history rather than restoring it.
3. **Archiving a location degrades already-published versions.** A published, immutable
   version whose field carries a location default stops being usable for new services once that
   location is archived, and there is no unarchive. Deliberate and asserted by
   `services.test.ts`. The alternative — tolerating pre-existing published defaults while
   refusing new selections — is a revision-system question worth deciding before this reaches
   real tenants. See [`locations.md`](locations.md#known-consequence-archival-degrades-published-versions).
4. **`organizations` diverges from the audit convention.** Every other domain diffs before
   writing: no-op updates write no audit row and `metadata.changedFields` names what changed.
   `updateOrganization` writes `metadata: { name }` with no diffing, so re-sending the stored
   name writes a second audit row. Either bring it in line or document why organizations
   differ; `organizations.test.ts` currently asserts the actual behaviour, so changing it means
   changing the tests too.
5. **Mirror-column backfill.** `serviceKindFields.defaultLocationId` was added mid-Stage-B with no
   backfill — correct at the time, since no real data existed. Any deployment carrying
   service kind-field location defaults written before that commit needs a one-off backfill, or
   `deleteLocation`'s guard will miss them.
6. **A membership invitation's role is authorized once, at creation, never re-checked at
   acceptance (#56).** If its inviter is later demoted or removed, the still-pending membership
   invitation keeps granting the original role — including `owner` — for up to the 14-day TTL.
   This gap is now membership-only: #86's `providerClaim` arm re-authorizes the inviter's current
   `admin` rank at acceptance and refuses a stale authority. No cascade-revoke exists for the
   remaining membership case; offboarding an admin/owner should include revoking what they invited.
7. **Invitation-kind schema backfill.** The required `kind` discriminator is safe because no
   deployment carries invitation rows written before #86; the only existing data is demo data,
   and `seed/` writes no invitations. Any deployment that did carry pre-#86 invitation rows would
   need a one-off backfill patching `kind: 'membership'` before the schema push.

8. **The projection carries the tenant `label` as display text.** Selection is purely
   semantic, as specified, but each entry also returns the Field Definition's current label.
   `passenger.count` admits up to 25 definitions per organization, so one Service can hold
   several fields sharing a projected semantic ("adults" and "children"); keyed by semantic
   alone they render as anonymous numbers. A projected field's label sits in the same
   disclosure class as its value, which is already disclosed. `label` is never matched
   against — only emitted.
9. **`listMyProviderEngagements` narrows its page twice**, so a page can come back shorter
    than `numItems` (or empty) while `isDone` is false: the index range pre-narrows on
    `status`, then `grantConfersAccess` re-proves the other six conditions per row. Resolving
    before paginating would be an unbounded read. It is also ordered by `projectId` — an
    opaque id — because no orderable column is disclosable to a Provider; ordering becomes
    meaningful through the Provider name now returned by MAY-see #1.

10. **Execution and revision status labels live under the `portal.` i18n group.** They are
    backend-owned vocabulary that `stage:Q`'s coordinator surfaces (#90, #72) will also need,
    so those issues will either reach into `portal.` or duplicate the keys. Left as-is rather
    than pre-emptively moved, because where stage:Q wants its status vocabulary is a decision
    that stage should make with its screens in front of it. The tokens themselves are already
    shared, in `lib/status.ts`, and are `satisfies Record<Status, StatusToken>` — so a new
    backend status is a `tsc` failure either way.

11. **#90 added backend functions inside a console issue.** `stage:Q` is the console stage, but
    the Events surface it specifies was not expressible against the shipped API: `events` carried
    no organization index and no organization-scoped query, so an org-wide list with status and
    Project filters could only have been assembled by fanning out per Project and filtering in the
    browser — the I6 violation the issue's own bullet forbids. And the header it specifies names an
    accountable person, while no public query turned an `Id<'users'>` into a display name.
    `listOrganizationEvents`, `getEventDetail` and three indexes were added, each mirroring the
    shape `services` already uses.

12. **Gap 10 is closed, in the direction it left open.** `moneyValue` moved from the `portal.`
    i18n group to `common.`, because the Events budget made a coordinator screen read its
    vocabulary out of the Provider portal's namespace. The execution and revision *status* labels
    named in gap 10 stay under `portal.` until a stage:Q screen actually renders one.

13. **`subtotalsByCurrency` was written, tested, and then removed.** #90's required-tests list
    names "cross-currency grouping boundaries", and the natural reading is a function that groups
    money by currency. Its only plausible consumer was the budget rollup surface in #76, which is
    closed as descoped — so it shipped with a test and no call site, and mutation testing showed
    its accompanying "no blended total exists" assertion was a denylist of two function names that
    a real blended total under any third name walked straight past. The boundary is structural
    instead: `moneyDisplay` accepts one amount and returns that amount's own currency with it, both
    budget call sites go through it, and no function in `lib/money.ts` accepts more than one amount.
    If a rollup surface is ever specified, the grouping function comes back with a consumer.

14. **#72's Provider and Fleet surfaces live at `/settings/providers` and `/settings/fleet`.** The
    issue asked for top-level `/proveedores` and `/flota`, and also for "navigation entries under
    configuration, not operations". Those conflict, and the placement rule was taken as the binding
    half: `docs/web-design.md` §14 puts configuration under `/settings`, and every shipped route is
    English with the locale as its own segment. Resolving the placement settled the spelling.

15. **Two fleet columns cannot be cleared from the console.** `year` on a Fleet Vehicle and
    `passengerCapacity` on a Vehicle Class are `v.optional(v.number())` with no `null` clearing arm,
    unlike `updateEvent`, which takes `T | null | absent` on every optional column. Blanking either
    in the editor leaves the stored value. The console does not work around it, and the fix is a
    backend argument change that a console issue should not be making. Text columns are clearable —
    they accept a trimmed `''`, which stores an empty string rather than removing the column, and
    `storedOptionalText` renders `''` as "not set" so the two read alike.

16. **A Provider's pending claim invitation is known only as far as the loaded page.**
    `listProviderClaimInvitations` is organization-wide with no per-Provider counterpart, so a
    surface cannot ask "does this row have a live invitation" directly. The invite affordance is
    therefore withheld until the invitation query reaches `Exhausted`, rather than offered on
    incomplete knowledge: `inviteProviderOrganization` keys its conflict on
    `(organizationId, email, 'pending')` — **address-scoped, not Provider-scoped** — so inviting a
    different address on a row with an out-of-view pending invitation would have succeeded and left
    two live claim offers on one Provider, whichever mailbox accepted first taking the row.

17. **#73 knowingly does not satisfy its requested currency-specific decimal test.** The
    requested `COP` display without decimals would require a per-currency exponent table, while
    [`rates.md`](rates.md) deliberately defines one fixed exponent of 2 and #90's shared money
    helpers implement that decision. The Rate Card grid therefore uses those helpers unchanged:
    COP 810,000 renders as `COP 810.000,00` in `es-CO` and `COP 810,000.00` in `en-US`, while USD
    also renders with two decimals. No currency exponent is chosen or duplicated in the console.

18. **Gap 10's modality half is closed by #73.** The code-owned modality labels moved from
    `portal.modalities` to `common.modalities` when the coordinator Rate Card grid became their
    second consumer. Execution and revision status labels remain under `portal.` until a
    coordinator surface consumes them, as recorded in gap 12.

17. **#73's Rate Card list shows no Version count, and groups by nothing.** The issue asks for a
    list "grouped by Provider, showing current published Version and Version count". No public
    query publishes a count — `listRateCardVersions` is paginated with no total, so counting per row
    means paging every card's history on a list screen — and grouping a cursor-paginated result
    produces incomplete groups, because one Provider's cards can straddle a page boundary and each
    half then looks complete. The list carries a Provider column and an index-served Provider
    filter instead, and the published Version *number* is shown on the detail screen, where one
    bounded read supplies it.

18. **#73's required COP test is knowingly not satisfied.** It asks for "COP with no displayed
    decimals, USD with two decimals", which is a per-currency exponent. `docs/rates.md` states
    there is deliberately no such table, and #90 shipped `apps/web/lib/money.ts` with a fixed
    exponent of 2 citing it. COP therefore renders as `COP 810,000.00`. Introducing a display-only
    exponent would also have changed `parseMoneyInput` and the appearance of the money surfaces
    already shipped in #88 and #90 — a decision worth making on its own evidence rather than as a
    side effect of a console issue, so `docs/rates.md`'s deferral stands unamended.

19. **#74 gives Assignment pricing its own intent at the `planner` floor, widening a recorded
    `admin`-only decision.** `docs/authorization.md` said public rate reads are organization
    configuration and admin-gated, and that Assignment authoring uses the domain-internal
    resolver "only after its Project gate has authorized the enclosing write". The console cannot
    obey #74's central rule — resolve and display the rate live, never let a user type it —
    unless the role that authors Assignments can also read one, and `writeAssignmentTerms` floors
    at `planner`. `assignments.resolveAssignmentRate` therefore reads a single
    (Provider, Class, modality) cell at `planner`, through a **separately named**
    `readAssignmentPricing` intent rather than by borrowing the write intent, so the widening is
    a word in the gate vocabulary instead of a side effect, and so the pricing floor can move
    later without dragging authoring with it.

    **Accepted consequence, stated rather than mitigated:** `listProviders` and
    `listVehicleClasses` are viewer-floor and the modality union is closed, so a planner issuing
    one call per combination can reconstruct the organization's *active published* rate grid.
    A planner learns each cell anyway by assigning it, and the alternative is pricing blind. The
    catalogue doors — browsing Cards, Versions, grids, drafts and retired Versions — remain
    admin-only.

20. **#74 returns pricing outcomes as values, not errors.** `resolveAssignmentRate` answers
    `resolved`, `ambiguous` or `unpriceable` instead of throwing when no published Card prices a
    cell. A missing rate is a configuration gap a planner can repair, not a permission event, and
    a Convex query that throws reaches the console as a render-time error rather than a state the
    form can hold selections through. Authorization and bad references still exit through the
    generic refusal, so I9 is unaffected.

21. **A Provider may have several active Rate Cards, and #74 refuses rather than choosing.**
    `createRateCard` enforces no uniqueness on `(organization, provider)`, so two published Cards
    can price the same cell at different amounts. Rather than picking one — which would make the
    console decide a price, the one thing the issue forbids — the lookup returns `ambiguous` with
    the competing Cards named, and the only remedy offered is retiring a published Version. The
    `ambiguous` payload deliberately omits `rateLineId` so an ambiguous answer cannot be
    submitted. Adding the uniqueness constraint was considered and deferred: it is a backend
    policy change with a migration story, not a console issue's to make.

22. **#74's "execution capability vs terms capability" test asks for an actor that cannot
    exist.** The issue requires proving that "execution capability does not reveal reprice/terms
    actions, and terms capability does not reveal unrelated coordinator actions". There is no
    principal holding terms capability without execution capability: a member at the `planner`
    floor necessarily clears the lower `operator` floor, and a Provider grant confers
    `respondToTerms` and `writeExecution` together as a closed set. Inventing such an actor for
    the console would have meant inventing a principal arm the backend does not have, and the
    console's affordance table would then have stopped mirroring `memberRoleForCapability`.
    The suite instead pins the one real execution-only actor — an `operator` member, which sees
    no terms actions — and pins the complete action set for every other combination.

23. **The Provider portal cannot know whether a Service is writable, so it renders response
    actions optimistically.** `docs/provider-access.md` forbids disclosing the linked Service's
    lifecycle to a Provider, so the portal has nothing to answer "is this Service frozen?" with.
    It passes `serviceWritable: true` into the display-only affordance rule and lets the
    mutation's own gates refuse. A Provider can therefore see an accept button on a Service that
    was frozen after their last read, and get a mapped error on click. Showing a button that the
    server refuses is strictly better than adding a Provider read the access model forbids, and
    hiding it would require exactly that read.

24. **The console offers "remove Assignment" one condition short of the backend's rule.**
    `removeAssignment` refuses when an Assignment has revisions **or** checkpoints; the console
    mirrors only the revision half, because the panel already loads revisions and does not load
    checkpoints. An Assignment with checkpoints but no revisions therefore shows a remove button
    that answers `assignmentRemoveBlocked`. Closing the gap means either a checkpoint-count read
    on every panel row or a new backend field, for an affordance that is already correct in the
    common case and maps to a clear error otherwise.

Also unbuilt by design, and not gaps: per-field permissions, structured conditional rules on
service kind fields (the plug-in point is documented in `serviceKinds/fields/model.ts`), organization
archival, organization slug renaming, and any location revision/snapshot system.
