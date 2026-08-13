import { v } from 'convex/values';

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
  v.literal('recipe.created'),
  v.literal('recipe.updated'),
  v.literal('recipe.archived'),
  v.literal('recipeVersion.created'),
  v.literal('recipeVersion.published'),
  v.literal('recipeVersion.retired'),
  v.literal('event.created'),
  v.literal('event.updated'),
  v.literal('event.statusChanged'),
  v.literal('event.cancelled'),
  v.literal('location.created'),
  v.literal('location.updated'),
  v.literal('location.archived'),
  v.literal('relationship.created'),
  v.literal('relationship.removed'),
);

export const auditEntityTypeValidator = v.union(
  v.literal('organization'),
  v.literal('membership'),
  v.literal('project'),
  v.literal('fieldDefinition'),
  v.literal('eventRecipe'),
  v.literal('recipeVersion'),
  v.literal('event'),
  v.literal('location'),
  v.literal('eventRelationship'),
  v.literal('user'),
);

/**
 * Flat scalar metadata only. Issue #13 must additionally enforce per-action
 * allowed keys at write time — this shape alone cannot prove the absence of
 * secrets/tokens/PII.
 */
export const auditMetadataValidator = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.null()),
);

export type FieldDataType = typeof fieldDataTypeValidator.type;

type SemanticCapability =
  | 'eventName'
  | 'eventDescription'
  | 'eventDate'
  | 'eventTime'
  | 'eventLocation';
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
} satisfies Record<string, SemanticDefinition>);

export type SemanticType = keyof typeof semanticRegistry;

/** Must stay in sync with semanticRegistry keys; the satisfies check below enforces it. */
export const semanticTypeValidator = v.union(
  v.literal('eventName'),
  v.literal('eventDescription'),
  v.literal('eventDate'),
  v.literal('eventTime'),
  v.literal('eventLocation'),
);

// Compile-time guard: the validator's type must be exactly the registry's key set.
type AssertSameKeys = typeof semanticTypeValidator.type extends SemanticType
  ? SemanticType extends typeof semanticTypeValidator.type
    ? true
    : never
  : never;
const _semanticKeysInSync: AssertSameKeys = true;
void _semanticKeysInSync;
