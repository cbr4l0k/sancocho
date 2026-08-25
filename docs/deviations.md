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
| Lifecycle checks are ordered **after** the org comparison in `createRelationship` | A caller must never learn a foreign event's status from a specific error | `relationships/model.ts` |
| **Operators may change event status**; authoring stays planner+ | Operators exist to *run* events (activate, complete, cancel on the ground) without changing what an event says it is | `events/model.ts` (`operatingRole`), [`authorization.md`](authorization.md) |
| `by_org_role` index for cheaper owner counting was not added | Owner counting reads the `by_org_user` org prefix, which is also what makes concurrent owner removals conflict. Optimization deferred | `organizations/model.ts` |

## Fields, recipes and versions

| Decision | Why | Where |
| --- | --- | --- |
| The **semantic registry is frozen TypeScript, not data** | Tenants may name a semantic type but can never grant a capability (I8). A compile-time guard keeps the validator's literals in sync with the registry keys | `validators/index.ts` |
| `recipeFields` snapshot the **whole config union** (data type + rules + options), not just select options | Makes I3 structural: historical validation reads the snapshot and never the live definition, and mismatched rules/type combinations are unrepresentable | `schema.ts`, `validators/index.ts` |
| **Snapshots are taken at draft-composition time, and publish validates coherence** — it does not overwrite them | A recipe may narrow a definition for its own use (tighter bounds, option subsets). Publishing re-checks kind identity, narrowing-only bounds and option-subset against the definition as it stands then, so a stale snapshot fails publishing honestly. This resolved an ambiguity in the Stage A review; `architecture-review.md` §7 was updated to match | `recipes/model.ts:assertSnapshotCoherentWithDefinition`, [`recipes.md`](recipes.md#the-snapshot-contract) |
| One coherence rule for add, update **and** publish | The rule existed twice and had already diverged: composition enforced narrowing-only bounds, publish did not, and clone bypassed composition entirely | `recipes/model.ts` |
| Field-definition immutability triggers on reference by a **published or retired** version | Retired versions remain historically interpretable, and counting them is what makes `getEvent`'s live `key` join safe. Narrowing to published-only would break I3 with nothing failing in the fields tests — commented at both sites | `fields/model.ts:isReferencedByPublishedVersion`, `events/model.ts:getEvent` |
| `label` and `description` stay editable after the freeze | A display string has no identity meaning; a rename should be visible immediately | `fields/model.ts` |
| Immutability gates on **change**, not on argument presence | A read-modify-write client echoing the current values back must not be rejected | `fields/model.ts` |
| Key rules (format, per-org uniqueness, built-in shadow probe) live in one helper used by create **and** rename | Create-then-rename skipped the shadow probe, which would have let a custom key permanently shadow a built-in once published | `fields/model.ts:assertKeyAvailable` |
| `assertValidFieldConfig` validates config *contents* (finiteness, bound ordering, calendar/clock validity, option identity, satisfiable selection bounds) | Convex validators are structural only. An incoherent config would be frozen verbatim into an immutable snapshot and become permanent | `fields/model.ts` |
| `maxFieldsPerVersion = 200` is enforced | Makes the "bounded child set" claim that justifies `.collect()` structural rather than assumed (I6) | `recipes/model.ts` |
| `archiveRecipe` retires the live published version in the same transaction | An archived recipe must stop being a source of new events while its versions stay readable (I3) | `recipes/model.ts` |
| Hard-deleting a `recipeFields` row is allowed, but only in a draft | A version never returns to draft, so no draft row can be the rule set behind an existing event. The argument is written down at the call site | `recipes/fields/model.ts:removeRecipeField` |

## Events and relationships

| Decision | Why | Where |
| --- | --- | --- |
| Recipe defaults are **materialized at event creation only** | Before the required-field check, so a required field with a default succeeds when omitted; and never re-applied on update, because after creation an absent value is a deliberate state | `events/model.ts` |
| Materialized defaults go through the same validation gate as submitted values | A default whose location has since been archived must fail creation exactly as an explicit value would | `events/model.ts` |
| `visible: false` is **presentation metadata**, not a write or read rule | A hidden field may legitimately hold a value (a materialized default, or a value written when it was visible). Enforcing on write would let a version orphan values it owns; enforcing on read would hide data the audit trail says exists | `events/model.ts`, [`events.md`](events.md#visibility) |
| **Archival is a freeze through every door**, relationships included | Links could otherwise be created and removed on events in a fully archived project. One definition of "writable event" (`assertEventWritable`) is shared by both domains | `events/model.ts`, `relationships/model.ts` |
| Archiving a project is allowed regardless of how many events it holds | A project with events is exactly the project worth archiving; a reference guard would make the most-used projects unarchivable. Archival freezes, it does not cascade | `projects/model.ts:archiveProject` |
| A `completed` project accepts no new events but its existing ones stay editable | A finished piece of work should be correctable without being reopened | `events/model.ts:assertProjectAcceptsNewEvents` |
| **Events are never hard-deleted**; cancellation is the terminal path | They are operational records | `events/model.ts`, [`deletion-and-archival.md`](deletion-and-archival.md) |
| `updateEventFields` does not re-validate a submitted value **identical to the stored one** | The gate ran on every submitted value while the diff happened afterwards, so a read-modify-write client (load event, edit one field, resubmit the form) failed on an untouched location value once that location was archived — with a bare "not found" on an event in its own org and no repair path. Structural checks (unknown field, duplicate definition, clearing a required field) still run over the whole submission. Same "gate on change, not on argument presence" rule the fields domain states | `events/model.ts:validateEventAgainstRecipe`, [`events.md`](events.md#updating) |
| Typed-value edits audit as **`event.fieldsUpdated`**, core-column edits as `event.updated` | Both write `metadata.changedFields`, but one holds field-definition ids and the other column names; one action for both left log consumers sniffing the value to tell which vocabulary they were reading | `validators/index.ts`, `events/model.ts` |
| **Absolute caps on stored string values** (`text` 2000, `longText` 10000), enforced on the value AND on any config that would promise more | A snapshot's `maxLength` is optional (the seeded `notes` built-in omits it), so values were unbounded. Writes stay small — one row per field — but `getEvent` collects them all, and the I6 argument for that collect bounds the row COUNT, not the bytes: a few huge values make an Event permanently unreadable while still writable, and Events are never deleted | `fields/values.ts`, `fields/model.ts:assertValidFieldConfig` |
| `projects.description` is bounded at **2000** characters | It was the only unbounded free-text column left (siblings: field/recipe descriptions 2000, addresses 500, names 200). `listProjects` pages whole documents and projects are never deleted, so enough oversized rows would make a tenant's project list permanently unreadable | `projects/model.ts` |
| `updateProject` cannot set `status: 'archived'` | It would bypass `archiveProject`'s own audit action and its documented policy; the transition helper routes it | `projects/model.ts` |
| **Two directional relationship queries** rather than one merged list | No index spans both source and target; merging would require an unbounded read before pagination (I6) | `relationships/model.ts` |
| An anomalous row is skipped inside a relationship page, not thrown on | One inconsistent row would otherwise make an entire directional list permanently unreadable. A short page is legal in Convex pagination | `relationships/model.ts:joinCounterparts` |
| `relationship.created` records both endpoints | Rows are hard-deleted, so a created entry read in isolation must still describe the link | `relationships/model.ts` |
| No cycle detection, no traversal, no workflow execution | Structured link catalogue, not a workflow engine (I8) | `relationships/model.ts` |
| Finiteness is checked at runtime everywhere a number is stored or compared | Convex `v.number()` accepts `NaN` / `Infinity`, which silently pass every ordering comparison | `validators/index.ts:isFiniteNumber` and its callers |

## Locations

| Decision | Why | Where |
| --- | --- | --- |
| Location values are **references to the live entity**, not snapshots | Reference data stays correctable in one place. The cost — later edits are visible from historical events — is accepted; audit-grade snapshots are future work | `locations/model.ts`, [`locations.md`](locations.md) |
| `recipeFields.defaultLocationId` mirror column + `by_defaultLocation` index | `deleteLocation` guarded only `eventFieldValues`, missing location defaults frozen inside published (immutable) versions; deleting one would have left a dangling reference in a version that can never be repaired | `schema.ts`, `locations/model.ts:deleteLocation` |
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
| Built-in keys, recipe field order and per-field `required` flags are declared explicitly, never derived from array position | All three freeze at publish (I2) and a built-in key is permanent deployment-wide. Deriving `required` from an index once coupled it to catalogue order | `seed/mutations.ts` |
| The demo event's `startsAt` is a literal absolute timestamp for an 18:40 local arrival | Demonstrates the temporal rule that `startsAt` is an instant, and keeps every seeded deployment and test run identical | `seed/mutations.ts` |

## Known gaps

Deferred deliberately (tracked in issue #18). None of these are bugs discovered late; each was
a decision to stop rather than guess.

1. **`addMember` has no consent step.** It attaches an existing user id directly, so an admin
   who learns any user's Convex id can add them, and the added user immediately gains read
   access to the member roster (names and emails). A verified-email invite flow should replace
   it as the user-facing path. `organizations/model.ts` carries the note.
2. **Field archival is irreversible, and asymmetric with the location case.** There is no
   unarchive for a field definition, and an archived field cannot be composed into a draft —
   so a clone-then-publish of a version that uses it fails until the field is removed from
   the draft (recoverable, unlike the location case below, which degrades an already-published
   immutable version with no repair at all). Both are the same underlying choice: archival is
   a one-way lifecycle, and the reference guards protect history rather than restoring it.
3. **Archiving a location degrades already-published versions.** A published, immutable
   version whose field carries a location default stops being usable for new events once that
   location is archived, and there is no unarchive. Deliberate and asserted by
   `events.test.ts`. The alternative — tolerating pre-existing published defaults while
   refusing new selections — is a revision-system question worth deciding before this reaches
   real tenants. See [`locations.md`](locations.md#known-consequence-archival-degrades-published-versions).
4. **`organizations` diverges from the audit convention.** Every other domain diffs before
   writing: no-op updates write no audit row and `metadata.changedFields` names what changed.
   `updateOrganization` writes `metadata: { name }` with no diffing, so re-sending the stored
   name writes a second audit row. Either bring it in line or document why organizations
   differ; `organizations.test.ts` currently asserts the actual behaviour, so changing it means
   changing the tests too.
5. **Mirror-column backfill.** `recipeFields.defaultLocationId` was added mid-Stage-B with no
   backfill — correct at the time, since no real data existed. Any deployment carrying
   recipe-field location defaults written before that commit needs a one-off backfill, or
   `deleteLocation`'s guard will miss them.

Also unbuilt by design, and not gaps: per-field permissions, structured conditional rules on
recipe fields (the plug-in point is documented in `recipes/fields/model.ts`), organization
archival, organization slug renaming, and any location revision/snapshot system.
