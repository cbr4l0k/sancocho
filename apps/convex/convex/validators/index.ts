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

/** Shared persisted and returned shape for organization-owned locations. */
export const locationFields = {
  organizationId: v.id('organizations'),
  name: v.string(),
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
}>;

/** Code-owned semantics; tenant data may name a type but can never grant capabilities. */
export const semanticRegistry = Object.freeze({
  eventName: { expectedDataType: 'text', capabilities: ['eventName'] },
  eventDescription: { expectedDataType: 'longText', capabilities: ['eventDescription'] },
  eventDate: { expectedDataType: 'date', capabilities: ['eventDate'] },
  eventTime: { expectedDataType: 'time', capabilities: ['eventTime'] },
  eventLocation: { expectedDataType: 'location', capabilities: ['eventLocation'] },
  'passenger.count': {
    expectedDataType: 'number',
    capabilities: ['passengerTotals', 'occupancyMetrics', 'capacityValidation'],
  },
  'transport.origin': { expectedDataType: 'location', capabilities: [] },
  'transport.destination': { expectedDataType: 'location', capabilities: [] },
  'aviation.flightNumber': { expectedDataType: 'text', capabilities: ['flightTracking'] },
  'luggage.count': { expectedDataType: 'number', capabilities: [] },
  'accessibility.wheelchairCount': {
    expectedDataType: 'number',
    capabilities: ['accessibilityRequirements'],
  },
  'contact.primary': { expectedDataType: 'text', capabilities: [] },
  'aviation.terminal': { expectedDataType: 'text', capabilities: [] },
  'general.notes': { expectedDataType: 'longText', capabilities: [] },
} satisfies Record<string, SemanticDefinition>);

export type SemanticType = keyof typeof semanticRegistry;

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
  description: v.optional(v.string()),
  status: fieldDefinitionStatusValidator,
  semanticType: v.optional(semanticTypeValidator),
  // Data type + rules + options bound in one discriminated union.
  config: fieldConfigValidator,
};
