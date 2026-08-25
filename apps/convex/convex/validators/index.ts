import { v, type Validator } from 'convex/values';

/**
 * The Convex pagination envelope, stated once for every paginated public query.
 *
 * The shape must match `PaginationResult` exactly — a `returns` validator that
 * omits `splitCursor`/`pageStatus` rejects legitimate pages at runtime. It was
 * previously copied into five query modules, so a fix to one could silently
 * leave the other four wrong; this is the single definition they all build on.
 */
export function paginatedResult<DocValidator extends Validator<unknown, 'required', string>>(docValidator: DocValidator) {
  return v.object({
    page: v.array(docValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())),
  });
}

export const roleValidator = v.union(
  v.literal('owner'),
  v.literal('admin'),
  v.literal('planner'),
  v.literal('operator'),
  v.literal('viewer'),
);

export const recipeStatusValidator = v.union(
  v.literal('draft'),
  v.literal('active'),
  v.literal('archived'),
);

/**
 * `pending` is the only status a caller ever creates; the rest are
 * server-assigned outcomes (I4). There is no scheduled sweep (I8: no
 * workflow/cron machinery added speculatively), so `expired` is settled
 * lazily and asymmetrically:
 *
 * - `acceptInvitation` CANNOT persist the transition — a Convex mutation is
 *   one atomic transaction, and it always throws when an invitation is past
 *   `expiresAt`, which rolls back any write made in the same call. It
 *   compares `expiresAt` to now directly instead and leaves `status`
 *   untouched.
 * - `createInvitation` CAN — it is a success path with no throw afterward,
 *   so when a duplicate-address check finds a `pending` row past its own
 *   `expiresAt`, it settles that row to `expired` before proceeding, which
 *   is also what frees the address up for a fresh invitation.
 *
 * Every OTHER reader of this table (the pending-invitation lists) must still
 * treat a `pending` row past its own `expiresAt` as effectively expired
 * rather than trusting `status` alone, since nothing guarantees a
 * `createInvitation` call has ever run against that address since it lapsed.
 */
export const invitationStatusValidator = v.union(
  v.literal('pending'),
  v.literal('accepted'),
  v.literal('revoked'),
  v.literal('expired'),
);

export const recipeVersionStatusValidator = v.union(
  v.literal('draft'),
  v.literal('published'),
  v.literal('retired'),
);

export const eventStatusValidator = v.union(
  v.literal('draft'),
  v.literal('planned'),
  v.literal('confirmed'),
  v.literal('active'),
  v.literal('completed'),
  v.literal('cancelled'),
);

/** Archival is preferred over destructive deletion for projects and fields. */
export const archivalStatusValidator = v.union(v.literal('active'), v.literal('archived'));
export const projectStatusValidator = v.union(
  v.literal('draft'),
  v.literal('active'),
  v.literal('completed'),
  v.literal('archived'),
);
export const fieldDefinitionStatusValidator = archivalStatusValidator;

/** Code-owned location taxonomy; locations are reference data, never free-form types. */
export const locationTypeValidator = v.union(
  v.literal('airport'),
  v.literal('hotel'),
  v.literal('venue'),
  v.literal('office'),
  v.literal('station'),
  v.literal('depot'),
  v.literal('custom'),
);

/**
 * Single definition of the projects table shape: `schema.ts` builds the table
 * from it and the public queries build their `returns` validator from it, so
 * the stored document and the documented API contract cannot drift.
 */
export const projectFields = {
  organizationId: v.id('organizations'),
  name: v.string(),
  description: v.optional(v.string()),
  status: projectStatusValidator,
  startsAt: v.optional(v.number()),
  endsAt: v.optional(v.number()),
};

export const projectDocValidator = v.object({
  _id: v.id('projects'),
  _creationTime: v.number(),
  ...projectFields,
});

/**
 * Single definition of the eventRecipes table shape, mirroring `projectFields`/
 * `eventFields` above: `schema.ts` builds the table from it and every public
 * query builds its `returns` validator from it, so the stored document and the
 * documented API contract cannot drift. Before this it was declared a second
 * time (schema.ts had its own inline shape, and `recipes/queries.ts` and
 * `statistics/queries.ts` each hand-rolled their own copy of the return
 * shape) — a column added to one would have been silently rejected by the
 * others at runtime.
 */
export const recipeFields = {
  organizationId: v.id('organizations'),
  key: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  status: recipeStatusValidator,
};

export const recipeDocValidator = v.object({
  _id: v.id('eventRecipes'),
  _creationTime: v.number(),
  ...recipeFields,
});

/** Shared persisted and returned shape for organization-owned locations. */
export const locationFields = {
  organizationId: v.id('organizations'),
  name: v.string(),
  // Server-derived from `name` through normalizeSearchText; never client-supplied
  // (I4). Optional only for pre-column rows awaiting the administrative backfill.
  searchText: v.optional(v.string()),
  type: locationTypeValidator,
  address: v.optional(v.string()),
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  status: archivalStatusValidator,
};

export const locationDocValidator = v.object({
  _id: v.id('locations'),
  _creationTime: v.number(),
  ...locationFields,
});

/**
 * Single definition of the organizationInvitations table shape (issue #56):
 * `schema.ts` builds the table from it and the public queries build their
 * `returns` validator from it. `email` is the addressing key — never a user
 * id — so an invitation to an address with no account is indistinguishable
 * from one to an address that has one (I9); nothing about this table is ever
 * resolved by looking a user up by email. `status`, `invitedByUserId` and
 * `expiresAt` are server-assigned (I4); a caller supplies only `email` and
 * `role`.
 */
export const organizationInvitationFields = {
  organizationId: v.id('organizations'),
  // Normalized (trimmed, lowercased) at write time so the uniqueness index
  // and the recipient's equality check both compare like-for-like.
  email: v.string(),
  role: roleValidator,
  status: invitationStatusValidator,
  invitedByUserId: v.id('users'),
  expiresAt: v.number(),
};

export const organizationInvitationDocValidator = v.object({
  _id: v.id('organizationInvitations'),
  _creationTime: v.number(),
  ...organizationInvitationFields,
});

/**
 * Single definition of the events table shape: `schema.ts` builds the table from
 * it and the public queries build their `returns` validator from it, so the
 * stored document and the documented API contract cannot drift. It was declared
 * twice — once per side — and a column added to one would have silently been
 * rejected by the other at runtime.
 *
 * `recipeId` is derived from `recipeVersionId` server-side and `organizationId`
 * from the stored entity graph (I4); neither is ever accepted from client args,
 * which is why no public mutation validator repeats them.
 */
export const eventFields = {
  organizationId: v.id('organizations'),
  projectId: v.id('projects'),
  recipeId: v.id('eventRecipes'),
  recipeVersionId: v.id('recipeVersions'),
  name: v.string(),
  status: eventStatusValidator,
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
};

export const eventDocValidator = v.object({
  _id: v.id('events'),
  _creationTime: v.number(),
  ...eventFields,
});

/** Built-in vs org-owned field definitions; must agree with organizationId presence. */
export const fieldScopeValidator = v.union(v.literal('builtin'), v.literal('organization'));

/** Code-owned relationship taxonomy (issue #12); never a free string (I8). */
export const relationshipTypeValidator = v.union(
  v.literal('dependsOn'),
  v.literal('follows'),
  v.literal('parentOf'),
  v.literal('relatedTo'),
);

export const fieldDataTypeValidator = v.union(
  v.literal('text'),
  v.literal('longText'),
  v.literal('number'),
  v.literal('boolean'),
  v.literal('date'),
  v.literal('datetime'),
  v.literal('time'),
  v.literal('select'),
  v.literal('multiSelect'),
  v.literal('location'),
);

/** Convex stores date/time values as strings; runtime code also checks calendar/clock validity. */
export const dateStringValidator = v.string();
export const timeStringValidator = v.string();

export const dateStringPattern = /^\d{4}-\d{2}-\d{2}$/;
export const timeStringPattern = /^\d{2}:\d{2}$/;

export function isValidDateString(value: string): boolean {
  if (!dateStringPattern.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isValidTimeString(value: string): boolean {
  if (!timeStringPattern.test(value)) return false;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export const selectOptionValidator = v.object({
  id: v.string(),
  label: v.string(),
});

/**
 * One config union binds data type, validation rules, and options together so a
 * document can never carry rules or options that disagree with its data type
 * (impossible states unrepresentable). Used by fieldDefinitions (source of
 * truth for drafts) and recipeFields (immutable snapshot taken at publish —
 * this snapshot is what historical event validation reads, making I3
 * structural rather than procedural). For select/multiSelect the snapshotted
 * `options` list IS the allowed set.
 */
export const fieldConfigValidator = v.union(
  v.object({ kind: v.literal('text'), minLength: v.optional(v.number()), maxLength: v.optional(v.number()) }),
  v.object({ kind: v.literal('longText'), minLength: v.optional(v.number()), maxLength: v.optional(v.number()) }),
  v.object({ kind: v.literal('number'), min: v.optional(v.number()), max: v.optional(v.number()), integer: v.optional(v.boolean()) }),
  v.object({ kind: v.literal('boolean') }),
  v.object({ kind: v.literal('date'), min: v.optional(dateStringValidator), max: v.optional(dateStringValidator) }),
  v.object({ kind: v.literal('datetime'), min: v.optional(v.number()), max: v.optional(v.number()) }),
  v.object({ kind: v.literal('time'), min: v.optional(timeStringValidator), max: v.optional(timeStringValidator) }),
  v.object({ kind: v.literal('select'), options: v.array(selectOptionValidator) }),
  v.object({
    kind: v.literal('multiSelect'),
    options: v.array(selectOptionValidator),
    minSelections: v.optional(v.number()),
    maxSelections: v.optional(v.number()),
  }),
  v.object({ kind: v.literal('location') }),
);

/** Convex accepts NaN/Infinity in v.number(); numeric field values must pass this at runtime. */
export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Typed event values are shared by schema and future mutation arguments. Each
 * discriminator carries only the data valid for that field type (I8).
 * date/time/number/datetime branches are structurally loose at the Convex
 * layer (bare string/float64); every write path MUST go through the
 * centralized event validation gate (issue #10) which enforces calendar/clock
 * validity, finiteness, and recipe rules. Never use this union alone as the
 * only validation of a public mutation's field values.
 */
export const eventFieldValueValidator = v.union(
  v.object({ kind: v.literal('text'), value: v.string() }),
  v.object({ kind: v.literal('longText'), value: v.string() }),
  v.object({ kind: v.literal('number'), value: v.number() }),
  v.object({ kind: v.literal('boolean'), value: v.boolean() }),
  v.object({ kind: v.literal('date'), value: dateStringValidator }),
  v.object({ kind: v.literal('datetime'), value: v.number() }),
  v.object({ kind: v.literal('time'), value: timeStringValidator }),
  v.object({ kind: v.literal('select'), optionId: v.string() }),
  v.object({ kind: v.literal('multiSelect'), optionIds: v.array(v.string()) }),
  v.object({ kind: v.literal('location'), locationId: v.id('locations') }),
);

/** Code-owned audit vocabulary (extended by each domain issue); never free strings (I8). */
export const auditActionValidator = v.union(
  v.literal('organization.created'),
  v.literal('organization.updated'),
  v.literal('membership.created'),
  v.literal('membership.updated'),
  v.literal('membership.removed'),
  v.literal('project.created'),
  v.literal('project.updated'),
  v.literal('project.archived'),
  v.literal('fieldDefinition.created'),
  v.literal('fieldDefinition.updated'),
  v.literal('fieldDefinition.archived'),
  v.literal('fieldDefinition.deleted'),
  v.literal('recipe.created'),
  v.literal('recipe.updated'),
  v.literal('recipe.archived'),
  v.literal('recipeVersion.created'),
  v.literal('recipeVersion.published'),
  v.literal('recipeVersion.retired'),
  v.literal('recipeField.added'),
  v.literal('recipeField.updated'),
  v.literal('recipeField.removed'),
  v.literal('recipeVersion.fieldsReordered'),
  v.literal('event.created'),
  // Two distinct update vocabularies, so two distinct actions: `event.updated`
  // records COLUMN NAMES in `metadata.changedFields` (updateEventCoreFields),
  // `event.fieldsUpdated` records FIELD DEFINITION IDS (updateEventFields).
  // One action for both forced every log consumer to sniff the value.
  v.literal('event.updated'),
  v.literal('event.fieldsUpdated'),
  v.literal('event.statusChanged'),
  v.literal('event.cancelled'),
  v.literal('location.created'),
  v.literal('location.updated'),
  v.literal('location.archived'),
  v.literal('location.deleted'),
  v.literal('relationship.created'),
  v.literal('relationship.removed'),
  // The statistics counter backfill is a deployment-administrative operation
  // (see statistics/model.ts), not a tenant-facing write, but it is still
  // destructive and still gets exactly one audit action like everything else.
  v.literal('organization.statisticsBackfilled'),
  v.literal('invitation.created'),
  v.literal('invitation.revoked'),
  v.literal('invitation.accepted'),
);

/**
 * Every entity type here is org-owned, which is exactly what `auditEvents`
 * requires: `organizationId` is non-optional, so an audit row can only exist for
 * something a tenant owns. There is deliberately no `user` member — the two
 * org-less operations in the codebase (`ensureUser`, which provisions the app
 * user before any membership exists, and `createBuiltinFieldDefinition`, which
 * seeds deployment-wide definitions) therefore write no audit row at all. That
 * gap is accepted rather than papered over: a nullable `organizationId` would
 * weaken the tenant-scoped index every audit read depends on (I1/I6), and both
 * operations are idempotent provisioning, not tenant activity. Should they ever
 * need auditing, it belongs in a separate deployment-scoped log, not here.
 */
export const auditEntityTypeValidator = v.union(
  v.literal('organization'),
  v.literal('membership'),
  v.literal('project'),
  v.literal('fieldDefinition'),
  v.literal('eventRecipe'),
  v.literal('recipeVersion'),
  v.literal('recipeField'),
  v.literal('event'),
  v.literal('location'),
  v.literal('eventRelationship'),
  v.literal('invitation'),
);

/**
 * Metadata remains schema-compatible as a flat scalar record, but writes are
 * restricted to this code-owned key set in `recordAuditEvent`. That runtime
 * gate is what makes the audit policy's ban on secrets, tokens, provider
 * claims, and excessive PII enforceable rather than aspirational.
 */
export const auditMetadataKeys = [
  'changedFields',
  'clonedFromVersion',
  'fieldCount',
  'fieldDefinitionId',
  'key',
  'name',
  'phase',
  'position',
  'previousRole',
  'previousStatus',
  'recipeVersionId',
  'role',
  'slug',
  'sourceEventId',
  'status',
  'targetEventId',
  'type',
  'versionNumber',
] as const;

export const auditMetadataKeySet: ReadonlySet<string> = new Set(auditMetadataKeys);
export type AuditMetadataKey = (typeof auditMetadataKeys)[number];
export const maxAuditMetadataStringLength = 512;

/**
 * Keys whose values are ASSEMBLED BY SERVER CODE (joined column names and
 * document ids) rather than copied from caller input. They are the only keys
 * allowed to exceed `maxAuditMetadataStringLength`, and they are truncated
 * instead of rejected — see `recordAuditEvent`.
 */
export const auditMetadataSummaryKeys = ['changedFields'] as const satisfies readonly AuditMetadataKey[];
export const auditMetadataSummaryKeySet: ReadonlySet<string> = new Set(auditMetadataSummaryKeys);

/**
 * Public audit reads accept a caller-supplied `entityId`; it is compared against
 * stored document ids (~33 characters), so anything longer cannot match and is
 * refused rather than turned into an index scan on unbounded input.
 */
export const maxAuditEntityIdLength = 128;

/**
 * Flat scalar metadata only. The key set above is GLOBAL and code-owned rather
 * than per-action, and deliberately so: every `recordAuditEvent` call site lives
 * in this repository's domain models (no caller ever names a metadata key), so a
 * per-action key map would only duplicate what the call sites already state,
 * while adding a second place to edit on every new action. The global set still
 * delivers the property that matters — a key not on this list can never reach
 * the database — and the compiler is the first gate: `recordAuditEvent`'s
 * `metadata` parameter is typed to these keys, so a misspelled or newly invented
 * key fails `typecheck`, with the runtime guard as defense in depth.
 *
 * This shape alone cannot prove the absence of secrets/tokens/PII; the key set
 * plus the string bound is what makes that policy enforceable.
 */
export const auditMetadataValidator = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.null()),
);

/**
 * Persisted audit row shape, shared by schema.ts and the public audit query
 * contract. `_creationTime` is the log time axis; Convex supplies it, so audit
 * rows deliberately have no duplicate `createdAt` column.
 */
export const auditEventFields = {
  organizationId: v.id('organizations'),
  actorUserId: v.id('users'),
  action: auditActionValidator,
  entityType: auditEntityTypeValidator,
  entityId: v.string(),
  metadata: auditMetadataValidator,
};

export const auditEventDocValidator = v.object({
  _id: v.id('auditEvents'),
  _creationTime: v.number(),
  ...auditEventFields,
});

export type FieldDataType = typeof fieldDataTypeValidator.type;

/**
 * Code-owned capability vocabulary. Exported so callers receive a narrow union
 * instead of `string` and can never match capabilities by free-form comparison (I8).
 */
export type SemanticCapability =
  | 'eventName'
  | 'eventDescription'
  | 'eventDate'
  | 'eventTime'
  | 'eventLocation'
  | 'passengerTotals'
  | 'occupancyMetrics'
  | 'capacityValidation'
  | 'flightTracking'
  | 'accessibilityRequirements';
type SemanticDefinition = Readonly<{
  expectedDataType: FieldDataType;
  capabilities: readonly SemanticCapability[];
  // Only meaningful when `expectedDataType` is `'number'`: a `count` of
  // discrete things (passengers, luggage pieces, wheelchairs) is never
  // fractional, so a field bound to one of these types must declare
  // `integer: true` on its `number` config. Without this, a maintained
  // running-sum counter (statistics/model.ts `statisticsSemanticCounters`)
  // accumulating fractional deltas over many add/edit/clear cycles can drift
  // by IEEE-754 floating-point residue — a permanently nonzero `sum` at
  // `count: 0` that the live-scan path (which recomputes from the stored
  // rows every time) would never reproduce, so the maintained and scanned
  // totals silently disagree forever. Omitted (falls back to `false`
  // implicitly, i.e. absent) for semantic types with no such invariant.
  requiresInteger?: true | undefined;
  // Only meaningful for a type `statistics/model.ts` actually resolves field
  // definitions for (today: `passenger.count`, `accessibility.wheelchairCount`
  // — see `TrackedSemanticType` there). `fields/model.ts` enforces this at
  // field CREATE/UPDATE time (`assertSemanticTypeCapacity`), and
  // `statistics/model.ts` `getTrackedFieldDefinitionsForType` enforces it
  // AGAIN defensively on every read (`.take(cap + 1)`, throws if exceeded) —
  // the creation-time check cannot retroactively bound rows already written
  // before the cap existed. Both checks read the SAME number from here, so
  // they can never silently disagree. See the doc comment on
  // `maxFieldDefinitionsPerSemanticType` in fields/model.ts for why this
  // specific number was chosen. Omitted for every type this file's
  // statistics layer never resolves a field list for.
  maxFieldDefinitionsPerSemanticType?: number | undefined;
}>;

/** Code-owned semantics; tenant data may name a type but can never grant capabilities. */
// A tenant can bind at most this many field definitions to
// `passenger.count` or `accessibility.wheelchairCount` — the only semantic
// types `statistics/model.ts` `getTrackedFieldDefinitionsForType` resolves a
// field list for. Without a cap, an org that (deliberately or accidentally)
// bound an unusually large number of custom fields to the same tracked type
// could push `createEventFromRecipe`/`updateEventFields`/`changeEventStatus`
// — which resolve this list on every single write — past Convex's
// per-transaction read limit; the failure mode is service creation breaking
// for that tenant, not a dashboard getting slow. 25 is real headroom over
// what a realistic tenant needs (a dozen or so: adult/child/infant/staff
// passenger counts, a couple of accessibility variants) while keeping the
// worst case — a filtered read scanning `maxFilteredScan` (500) events, each
// resolving up to this many field definitions — comfortably inside a single
// transaction's budget (500 × 26 = 13,000 targeted point reads).
export const maxTrackedFieldDefinitions = 25;

/** Code-owned semantics; tenant data may name a type but can never grant capabilities. */
export const semanticRegistry = Object.freeze({
  // `requiresInteger: undefined` / `maxFieldDefinitionsPerSemanticType:
  // undefined` are stated explicitly (not merely omitted) on every entry
  // that doesn't need them, so `semanticRegistry[type]` stays ONE consistent
  // object shape across every union member — a property only some entries
  // declared would make TypeScript reject reading it off the others at all
  // (not just report `undefined`), since `satisfies` (unlike `as`) preserves
  // each entry's own literal shape rather than unifying them.
  eventName: { expectedDataType: 'text', capabilities: ['eventName'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  eventDescription: { expectedDataType: 'longText', capabilities: ['eventDescription'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  eventDate: { expectedDataType: 'date', capabilities: ['eventDate'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  eventTime: { expectedDataType: 'time', capabilities: ['eventTime'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  eventLocation: { expectedDataType: 'location', capabilities: ['eventLocation'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'passenger.count': {
    expectedDataType: 'number',
    capabilities: ['passengerTotals', 'occupancyMetrics', 'capacityValidation'],
    requiresInteger: true,
    maxFieldDefinitionsPerSemanticType: maxTrackedFieldDefinitions,
  },
  'transport.origin': { expectedDataType: 'location', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'transport.destination': { expectedDataType: 'location', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'aviation.flightNumber': { expectedDataType: 'text', capabilities: ['flightTracking'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'luggage.count': { expectedDataType: 'number', capabilities: [], requiresInteger: true, maxFieldDefinitionsPerSemanticType: undefined },
  'accessibility.wheelchairCount': {
    expectedDataType: 'number',
    capabilities: ['accessibilityRequirements'],
    requiresInteger: true,
    maxFieldDefinitionsPerSemanticType: maxTrackedFieldDefinitions,
  },
  'contact.primary': { expectedDataType: 'text', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'aviation.terminal': { expectedDataType: 'text', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'general.notes': { expectedDataType: 'longText', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
} satisfies Record<string, SemanticDefinition>);

export type SemanticType = keyof typeof semanticRegistry;

/**
 * Every semantic type whose registry entry declares `capability` among its
 * `capabilities`, computed from the registry itself rather than a
 * hand-maintained list — so a statistics feature keyed on a capability (e.g.
 * `passengerTotals`, `accessibilityRequirements`) automatically follows any
 * future field bound to that capability, and a field whose semantics are
 * never wired to a capability is automatically excluded. This is what
 * "compute from semanticType, never by matching on field keys or labels"
 * means in code: the caller names a capability, never a field key.
 */
export function semanticTypesForCapability(capability: SemanticCapability): readonly SemanticType[] {
  return (Object.keys(semanticRegistry) as SemanticType[]).filter((type) =>
    (semanticRegistry[type].capabilities as readonly SemanticCapability[]).includes(capability),
  );
}

/** Must stay in sync with semanticRegistry keys; the satisfies check below enforces it. */
export const semanticTypeValidator = v.union(
  v.literal('eventName'),
  v.literal('eventDescription'),
  v.literal('eventDate'),
  v.literal('eventTime'),
  v.literal('eventLocation'),
  v.literal('passenger.count'),
  v.literal('transport.origin'),
  v.literal('transport.destination'),
  v.literal('aviation.flightNumber'),
  v.literal('luggage.count'),
  v.literal('accessibility.wheelchairCount'),
  v.literal('contact.primary'),
  v.literal('aviation.terminal'),
  v.literal('general.notes'),
);

// Compile-time guard: the validator's type must be exactly the registry's key set.
type AssertSameKeys = typeof semanticTypeValidator.type extends SemanticType
  ? SemanticType extends typeof semanticTypeValidator.type
    ? true
    : never
  : never;
const _semanticKeysInSync: AssertSameKeys = true;
void _semanticKeysInSync;

/**
 * Single definition of the fieldDefinitions table shape: `schema.ts` builds the
 * table from it and the public queries build their `returns` validator from it,
 * so the stored document and the documented API contract cannot drift.
 *
 * Declared here (after `semanticTypeValidator`) rather than beside
 * `projectFields` only because it references validators defined further down.
 */
export const fieldDefinitionFields = {
  // scope must agree with organizationId presence: builtin ⇔ organizationId
  // absent. Enforced by the field-creation helpers in fields/model.ts.
  scope: fieldScopeValidator,
  organizationId: v.optional(v.id('organizations')),
  key: v.string(),
  label: v.string(),
  // Server-derived from `key` and `label` through normalizeSearchText; never
  // client-supplied (I4). Optional only for pre-column rows awaiting backfill.
  searchText: v.optional(v.string()),
  description: v.optional(v.string()),
  status: fieldDefinitionStatusValidator,
  semanticType: v.optional(semanticTypeValidator),
  // Data type + rules + options bound in one discriminated union.
  config: fieldConfigValidator,
};
