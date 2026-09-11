# Audit log

A log, not event sourcing. Application state is never rebuilt from audit rows, and no code
reads them except the two administrative queries.

## Shape and guarantees

`auditEvents` rows are written by `audit/model.ts:recordAuditEvent` inside the same mutation
as the domain operation, so the operation and its log entry are transactional: no audit
without the op, no op without the audit. A test asserts the rollback direction.

| Column | Notes |
| --- | --- |
| `organizationId` | Non-optional. Every audit row belongs to a tenant |
| `actorUserId` | Non-optional `Id<'users'>` |
| `action` | Closed literal union, 41 members (`organization.created` … `invitation.accepted`) |
| `entityType` | Closed literal union, 12 members |
| `entityId` | The document id as a string |
| `metadata` | Flat scalar record, restricted to a code-owned key set |
| `_creationTime` | Convex's own column is the log's time axis |

Append-only is structural: **no audit mutation exists anywhere in the codebase**, so there is
no update or delete path to authorize.

Domain modules diff before writing. A no-op update writes no audit row, and `changedFields`
names what actually changed. (One exception is recorded as a known gap: `updateOrganization`
does not diff — see [`deviations.md`](deviations.md#known-gaps).)

## Metadata safety, enforced

The policy is "metadata never contains secrets, tokens, provider claims, or excessive PII".
Two gates make it enforceable rather than aspirational:

- **Compile time.** `recordAuditEvent`'s `metadata` parameter is typed
  `Partial<Record<AuditMetadataKey, …>>`, so a misspelled or newly invented key fails
  `typecheck` instead of throwing inside a domain mutation at runtime.
- **Runtime.** `sanitizeAuditMetadata` re-checks the key against the same allowlist and bounds
  string lengths at 512 characters.

The allowed keys are global and code-owned rather than per-action, deliberately: every call
site lives in this repository's domain models — no caller ever names a metadata key — so a
per-action map would duplicate what the call sites already state while adding a second place
to edit for every new action. The property that matters (a key not on the list can never reach
the database) holds either way.

Assignment checkpoints audit only the Assignment id and their code-owned kind. Their optional
note and all driver phone numbers stay on the protected domain rows and are never copied into
audit metadata; `auditMetadataKeys` remains the closed runtime allowlist that enforces this.

`changedFields`, `clonedFromVersion`, `fieldCount`, `fieldDefinitionId`, `key`, `name`,
`position`, `previousRole`, `previousStatus`, `serviceKindVersionId`, `role`, `slug`,
`sourceServiceId`, `status`, `targetServiceId`, `type`, `versionNumber`.

### Reject versus truncate

The length bound treats two kinds of value differently, and the distinction is the fix for a
real regression the 121-test suite would otherwise have shipped:

| Kind | Behaviour | Reasoning |
| --- | --- | --- |
| Caller-influenced values (`name`, `key`, `slug`, …) | **Rejected** over the bound | Every one is already bounded far below 512 by its own validator (names 200, keys 64, slugs 63, the rest code-owned literals or document ids), so exceeding it means domain validation was bypassed |
| Server-generated summaries (`changedFields`) | **Truncated** to whole comma-separated entries plus `+N more` | Their length tracks how much the user legitimately changed. A 200-field version yields ~6.6 KB; throwing there would roll back a valid edit and blame the user's input for the log's own limit |

The regression: the 512-character cap broke `updateServiceFields` whenever roughly 15 or more
field values changed in one call, because that path audits a comma-joined list of 32-character
ids. No existing test edited more than two values at once.

The invariant this produces, stated once: **no domain mutation can ever fail because of its
own audit row.**

## Reading

| Query | Role | Ordering |
| --- | --- | --- |
| `audit.listOrganizationAuditEvents` | admin+ | `by_org`, newest first, paginated |
| `audit.listEntityAuditEvents` | admin+ | `by_org_entity`, newest first, paginated |

Owners and admins only; planners, operators and viewers cannot read the log. `entityId` is the
one free-form caller string on this domain and is bounded at 128 characters *after* membership
is proven, so the bound cannot be used to probe organizations the caller cannot read (stored
document ids are ~33 characters, so anything longer could not match anyway).

## The org-less gap

Two operations write no audit row at all, and this is deliberate:

- `auth.ensureUser` — provisions the app user before any membership exists.
- `fields.createBuiltinFieldDefinition` — seeds deployment-wide definitions owned by no tenant.

`auditEvents.organizationId` is non-optional, and there is no `user` entity type. Making the
column nullable would weaken the tenant-scoped index that every audit read depends on
(I1/I6), for two idempotent provisioning operations that are not tenant activity. If they ever
need auditing, it belongs in a separate deployment-scoped log, not this table.
