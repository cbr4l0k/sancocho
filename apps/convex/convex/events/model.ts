import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { locationIdFromValue, sameFieldValue, validateFieldValueAgainstConfig } from '../fields/values';
import {
  requireAuthenticatedUser,
  requireOrganizationMembership,
  requireOrganizationRole,
  type AuthenticatedUser,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { validateEntityName } from '../lib/names';
import type { Role } from '../lib/roles';
import { assertUsableLocation } from '../locations/model';
import { requireProjectAccess } from '../projects/model';
import { getVersionFields } from '../recipes/model';
import { isFiniteNumber, type eventFieldValueValidator, type eventStatusValidator } from '../validators';

type EventFieldValue = typeof eventFieldValueValidator.type;
type EventStatus = typeof eventStatusValidator.type;
type SubmittedValue = { fieldDefinitionId: Id<'fieldDefinitions'>; value: EventFieldValue | null };

/**
 * A submitted value paired with the recipe field row that governs it. The
 * validation gate produces these, and the write loops consume them, so a row is
 * resolved exactly once per request and the "unknown field" error has exactly
 * one site (it used to be re-derived per insert, with an unreachable duplicate
 * of the error behind it).
 */
type ResolvedValue<Value extends EventFieldValue | null> = {
  recipeField: Doc<'recipeFields'>;
  value: Value;
};
type ResolvedValues<Value extends EventFieldValue | null> = Map<Id<'fieldDefinitions'>, ResolvedValue<Value>>;

/**
 * Role floors for this domain, named rather than repeated as bare strings so the
 * policy is one decision instead of four call sites (rank comparison itself
 * lives in lib/roles.ts).
 *
 * Authoring an Event — creating it, editing its core fields, editing its typed
 * values — is planner-and-above, matching projects, recipes, and locations.
 * Advancing an Event's status is deliberately one step lower: operators exist to
 * *run* events (mark them active, complete them, cancel them on the ground)
 * without being able to change what the event says it is. Viewers are excluded
 * from both; reading stays open to any member.
 */
const authoringRole: Role = 'planner';
const operatingRole: Role = 'operator';

/**
 * Creates an Event from a published Recipe Version snapshot.
 *
 * Recipe field defaults are materialized here and nowhere else: any row the
 * client omitted that carries a `defaultValue` is added to the submitted set
 * BEFORE the required-field check, so a required field with a configured default
 * succeeds when omitted. Materialized defaults go through the same validation
 * gate as client-supplied values — a default whose location has since been
 * archived fails creation exactly as an explicitly submitted one would, rather
 * than being written unchecked. Defaults are a creation-time concept only:
 * `updateEventFields` never re-applies them, because after creation the absence
 * of a value is a deliberate state, not an unfilled blank.
 *
 * Events are operational records: they are never hard-deleted; cancellation is
 * their terminal removal path.
 */
export async function createEventFromRecipe(
  ctx: MutationCtx,
  args: {
    projectId: Id<'projects'>;
    recipeVersionId: Id<'recipeVersions'>;
    name: string;
    startsAt: number;
    endsAt?: number;
    values: { fieldDefinitionId: Id<'fieldDefinitions'>; value: EventFieldValue }[];
  },
): Promise<Id<'events'>> {
  const { project, access } = await requireProjectAccess(ctx, args.projectId, authoringRole);
  assertProjectAcceptsNewEvents(project);
  const { version, recipe } = await loadVersion(ctx, args.recipeVersionId);
  // The project and the version must be the same tenant's; knowing one id from
  // each grants nothing (I1).
  if (project.organizationId !== version.organizationId) return notFoundOrInaccessible();
  // A recipe has at most one published version at a time — `publishRecipeVersion`
  // and `archiveRecipe` both go through `retireCurrentPublishedVersion` in
  // recipes/model.ts — which is what makes "this version is published" equivalent
  // to "this is the recipe's *current* version". Events therefore cannot be
  // created from a superseded (retired) or unfinished (draft) rule set, while
  // existing events keep validating against whichever version they were born from.
  if (version.status !== 'published' || recipe.status === 'archived') {
    return invalidInput('eventRecipeUnavailable', 'Events require a published version of an active recipe');
  }
  const name = validateEntityName(args.name, 'event');
  validateEventDates(args.startsAt, args.endsAt);
  const fields = await getVersionFields(ctx, version._id);
  const resolved = await validateEventAgainstRecipe(ctx, version, fields, withRecipeDefaults(fields, args.values), true);

  const eventId = await ctx.db.insert('events', {
    organizationId: version.organizationId,
    projectId: project._id,
    // Both recipe links are derived from the resolved version, never from client
    // args, and the event is permanently bound to this exact snapshot (I3/I4).
    recipeId: version.recipeId,
    recipeVersionId: version._id,
    name,
    status: 'draft',
    startsAt: args.startsAt,
    ...(args.endsAt === undefined ? {} : { endsAt: args.endsAt }),
  });
  for (const [fieldDefinitionId, { recipeField, value }] of resolved) {
    // The location mirror is derived from the value beside it and never
    // client-supplied (I4); see the contract on `locationIdFromValue`. Omitting
    // the key entirely (rather than writing `undefined`) is what keeps the
    // column absent for non-location values.
    const locationId = locationIdFromValue(value);
    await ctx.db.insert('eventFieldValues', {
      organizationId: version.organizationId,
      eventId,
      recipeFieldId: recipeField._id,
      fieldDefinitionId,
      value,
      ...(locationId === undefined ? {} : { locationId }),
    });
  }
  await recordAuditEvent(ctx, {
    organizationId: version.organizationId,
    actorUserId: access.user._id,
    action: 'event.created',
    entityType: 'event',
    entityId: eventId,
    metadata: { recipeVersionId: version._id },
  });
  return eventId;
}

/**
 * The sole typed-value gate, and the only place a submitted field definition is
 * resolved to the recipe field row that governs it.
 *
 * Every rule is read from `recipeField.config` — the immutable publish-time
 * snapshot — and never from the live `fieldDefinition`, which is what makes an
 * Event stay interpretable under exactly the rules it was written against, even
 * after its version is retired or the definition is edited for other recipes
 * (I3).
 *
 * `requireAll` is true for creation (after defaults are materialized) and false
 * for partial field edits.
 *
 * Returns the resolved rows keyed by field definition, in submission order, so
 * the caller's write loop needs no second lookup and carries no unreachable
 * "unknown field" branch. The generic parameter carries the caller's own value
 * type through: the creation path submits non-null values only, and gets back a
 * map the compiler knows contains none.
 *
 * `storedValues` — supplied by the update path only — is what the event already
 * holds, keyed by field definition. A submitted value identical to the stored one
 * skips the RULE checks below (bounds, option identity, and the location's
 * usability): it already passed this exact immutable snapshot when it was
 * written, so re-checking it re-litigates history against the world as it is now.
 * That is what made a read-modify-write client — load the event, edit one field,
 * resubmit the whole form — fail on an untouched location value once that
 * location was archived. Structural checks (unknown field, repeated definition,
 * clearing a required field) still run over the FULL submission, so nothing
 * hides behind an unchanged neighbour, and the write loop diffs again anyway.
 * This is the same "gate on change, not on argument presence" rule
 * `updateFieldDefinition` states for I2/I3.
 *
 * Snapshot `visible: false` is deliberately NOT enforced here or on read.
 * Visibility is presentation metadata — "do not put this on the operator's
 * form" — not an authorization or integrity rule. A hidden field may legitimately
 * carry a value (a default materialized at creation, or a value written while
 * the field was visible in an earlier version), and `getEvent` returns it. Making
 * it a write rule would mean a published version could silently orphan values it
 * still owns, and making it a read rule would hide data the audit trail says
 * exists. Enforcement is the client's concern until a per-field permission model
 * (deliberately out of scope here) gives it a server-side meaning.
 */
export async function validateEventAgainstRecipe<Value extends EventFieldValue | null>(
  ctx: MutationCtx,
  version: Doc<'recipeVersions'>,
  recipeFieldRows: Doc<'recipeFields'>[],
  values: { fieldDefinitionId: Id<'fieldDefinitions'>; value: Value }[],
  requireAll: boolean,
  storedValues?: ReadonlyMap<Id<'fieldDefinitions'>, EventFieldValue>,
): Promise<ResolvedValues<Value>> {
  const byDefinition = new Map(recipeFieldRows.map((field) => [field.fieldDefinitionId, field]));
  const resolved: ResolvedValues<Value> = new Map();
  for (const item of values) {
    const recipeField = byDefinition.get(item.fieldDefinitionId);
    // A definition this version does not compose — including one belonging to
    // another tenant — is refused here, once, for every write path.
    if (recipeField === undefined) return invalidInput('eventFieldUnknown', 'Event value references an unknown recipe field');
    if (resolved.has(item.fieldDefinitionId)) return invalidInput('eventFieldDuplicate', 'Event values must not repeat field definitions');
    resolved.set(item.fieldDefinitionId, { recipeField, value: item.value });

    const value: EventFieldValue | null = item.value;
    if (value === null) {
      // Clearing is the only meaning of null, and a required field cannot be empty.
      if (recipeField.required) return invalidInput('eventFieldRequired', 'Required event fields cannot be cleared');
      continue;
    }
    // An unchanged value is not a write, so it is not re-judged (see above).
    if (sameFieldValue(value, storedValues?.get(item.fieldDefinitionId))) continue;
    validateFieldValueAgainstConfig(recipeField.config, value);
    // The half the pure helper cannot do: the reference must resolve inside this
    // tenant and still be usable, and must fail generically (I1/I9).
    if (value.kind === 'location') await assertUsableLocation(ctx, value.locationId, version.organizationId);
  }
  if (requireAll && recipeFieldRows.some((field) => field.required && !resolved.has(field.fieldDefinitionId))) {
    return invalidInput('eventFieldRequired', 'Required event fields must have a value');
  }
  return resolved;
}

/**
 * Edits an Event's own columns. Cancelled and completed events, and every event
 * of an archived project, are read-only; the recipe links are immutable because
 * no API accepts them.
 */
export async function updateEventCoreFields(
  ctx: MutationCtx,
  args: { eventId: Id<'events'>; name?: string; startsAt?: number; endsAt?: number | null },
): Promise<void> {
  const { event, project, access } = await requireEventAccess(ctx, args.eventId, authoringRole);
  assertEventWritable(event, project);
  // Validated (and therefore trimmed) before the diff, so what is compared
  // against the stored name is exactly what would be stored.
  const name = args.name === undefined ? undefined : validateEntityName(args.name, 'event');
  // Ordering is checked on the MERGED pair, not on the arguments: patching only
  // `startsAt` past the stored `endsAt` must be refused just as an inverted pair
  // would be.
  const startsAt = args.startsAt ?? event.startsAt;
  // `null` explicitly clears the optional end, mirroring how a null field value
  // clears a stored value; omitting the argument leaves the stored end alone.
  const endsAt = args.endsAt === undefined ? event.endsAt : (args.endsAt ?? undefined);
  validateEventDates(startsAt, endsAt);

  // Built column by column rather than spreading client args, so only known
  // columns are written and the audit row names what actually changed.
  const patch: { name?: string; startsAt?: number; endsAt?: number | undefined } = {};
  const changedFields: string[] = [];
  if (name !== undefined && name !== event.name) {
    patch.name = name;
    changedFields.push('name');
  }
  if (args.startsAt !== undefined && args.startsAt !== event.startsAt) {
    patch.startsAt = args.startsAt;
    changedFields.push('startsAt');
  }
  if (endsAt !== event.endsAt) {
    // Assigning `undefined` is what removes the column on an explicit clear.
    patch.endsAt = endsAt;
    changedFields.push('endsAt');
  }
  // A no-op update writes neither a patch nor an empty audit row.
  if (changedFields.length === 0) return;

  await ctx.db.patch(event._id, patch);
  await recordAuditEvent(ctx, {
    organizationId: event.organizationId,
    actorUserId: access.user._id,
    action: 'event.updated',
    entityType: 'event',
    entityId: event._id,
    metadata: { changedFields: changedFields.join(',') },
  });
}

/**
 * Edits an Event's typed values. Planner+ may edit every field the version
 * composes; per-field permission granularity is future work. `null` explicitly
 * clears an optional value.
 *
 * The rule set is the event's OWN `recipeVersionId` rows, loaded with no status
 * filter: a retired version is still the rule set its events were written
 * against, and reading anything else — the recipe's currently published version,
 * or the live field definitions — would silently reinterpret history (I3).
 */
export async function updateEventFields(
  ctx: MutationCtx,
  args: { eventId: Id<'events'>; values: SubmittedValue[] },
): Promise<void> {
  const { event, project, access } = await requireEventAccess(ctx, args.eventId, authoringRole);
  assertEventWritable(event, project);
  const { version } = await loadVersion(ctx, event.recipeVersionId);
  if (version.organizationId !== event.organizationId || version.recipeId !== event.recipeId) {
    return notFoundOrInaccessible();
  }
  const fields = await getVersionFields(ctx, version._id);
  // The event's stored values are read BEFORE the gate, not per field after it,
  // so the gate can tell a real edit from a resubmitted one and skip re-judging
  // the latter (see `validateEventAgainstRecipe`). One read of a bounded child
  // set — at most `maxFieldsPerVersion` rows, exactly like `getEvent` (I6) —
  // replaces one indexed read per submitted field.
  const storedRows = await ctx.db
    .query('eventFieldValues')
    .withIndex('by_event_field', (q) => q.eq('eventId', event._id))
    .collect();
  const stored = new Map(storedRows.map((row) => [row.fieldDefinitionId, row]));
  const resolved = await validateEventAgainstRecipe(
    ctx,
    version,
    fields,
    args.values,
    false,
    new Map(storedRows.map((row) => [row.fieldDefinitionId, row.value])),
  );

  // The audit row names the field definitions that actually changed, matching the
  // `changedFields` convention used by projects, recipes, and locations — a bare
  // count said an edit happened without saying to what, and a resubmitted value
  // recorded an edit that never happened at all. The ACTION is its own literal
  // (`event.fieldsUpdated`), not `event.updated`: those ids are a different
  // vocabulary from the column names `updateEventCoreFields` writes under the
  // same metadata key, and one action for both left a log consumer sniffing the
  // value to tell which it was reading.
  const changedFields: Id<'fieldDefinitions'>[] = [];
  for (const [fieldDefinitionId, { recipeField, value }] of resolved) {
    const existing = stored.get(fieldDefinitionId) ?? null;
    // Diffed against what is stored, so echoing a value back (or clearing an
    // already-absent one) writes neither a row nor an audit entry.
    if (sameFieldValue(value, existing?.value)) continue;
    changedFields.push(fieldDefinitionId);

    if (value === null) {
      // Clearing removes the row outright, which removes the location mirror with it.
      if (existing !== null) await ctx.db.delete(existing._id);
      continue;
    }
    const locationId = locationIdFromValue(value);
    if (existing === null) {
      await ctx.db.insert('eventFieldValues', {
        organizationId: event.organizationId,
        eventId: event._id,
        recipeFieldId: recipeField._id,
        fieldDefinitionId,
        value,
        // Key omitted entirely for non-location values, so the column is absent
        // rather than present-and-undefined.
        ...(locationId === undefined ? {} : { locationId }),
      });
      continue;
    }
    await ctx.db.patch(existing._id, {
      organizationId: event.organizationId,
      eventId: event._id,
      recipeFieldId: recipeField._id,
      fieldDefinitionId,
      value,
      // On an UPDATE the mirror is written explicitly, including as `undefined`:
      // a row that previously held a location and now holds another kind of value
      // must lose its mirror in the same patch, or a location stays referenced by
      // an index and undeletable forever (see `deleteLocation`).
      locationId,
    });
  }
  if (changedFields.length === 0) return;

  await recordAuditEvent(ctx, {
    organizationId: event.organizationId,
    actorUserId: access.user._id,
    action: 'event.fieldsUpdated',
    entityType: 'event',
    entityId: event._id,
    metadata: { changedFields: changedFields.join(',') },
  });
}

/**
 * Lifecycle matrix: draft→planned→confirmed→active→completed; any non-completed
 * state→cancelled. Completed and cancelled are terminal.
 *
 * Open to operators (see `operatingRole`), because running an event is exactly
 * what a status transition is. Still refused for an archived project: an archived
 * project freezes its events entirely, cancellation included.
 */
export async function changeEventStatus(
  ctx: MutationCtx,
  args: { eventId: Id<'events'>; status: EventStatus },
): Promise<void> {
  const { event, project, access } = await requireEventAccess(ctx, args.eventId, operatingRole);
  assertProjectAcceptsEventWrites(project);
  // Same-status is refused by the transition matrix itself (no state is its own
  // successor, and terminal states are refused before that), so there is no
  // no-op branch here to skip the write.
  assertEventTransition(event.status, args.status);
  await ctx.db.patch(event._id, { status: args.status });
  await recordAuditEvent(ctx, {
    organizationId: event.organizationId,
    actorUserId: access.user._id,
    // Cancellation gets its own action so the terminal removal path is greppable
    // in the audit trail rather than hidden among ordinary advances.
    action: args.status === 'cancelled' ? 'event.cancelled' : 'event.statusChanged',
    entityType: 'event',
    entityId: event._id,
    metadata: { previousStatus: event.status },
  });
}

export async function getEvent(
  ctx: QueryCtx,
  eventId: Id<'events'>,
): Promise<{
  event: Doc<'events'>;
  values: { fieldDefinitionId: Id<'fieldDefinitions'>; key: string; label: string; value: EventFieldValue }[];
}> {
  const { event } = await requireEventAccess(ctx, eventId);
  const storedValues = await ctx.db
    .query('eventFieldValues')
    .withIndex('by_event_field', (q) => q.eq('eventId', event._id))
    .collect();
  // One bounded read of the event's own version rows, indexed by definition,
  // replaces a per-value `db.get` of the recipe field.
  const byDefinition = new Map(
    (await getVersionFields(ctx, event.recipeVersionId)).map((field) => [field.fieldDefinitionId, field]),
  );

  const values: { fieldDefinitionId: Id<'fieldDefinitions'>; key: string; label: string; value: EventFieldValue }[] = [];
  for (const stored of storedValues) {
    const recipeField = byDefinition.get(stored.fieldDefinitionId);
    // The stored row must be one this version actually composes, and must point
    // at that exact row: a value whose `recipeFieldId` belongs to another version
    // is corruption, not a reinterpretation to paper over.
    if (recipeField === undefined || recipeField._id !== stored.recipeFieldId) return notFoundOrInaccessible();
    const definition = await ctx.db.get(recipeField.fieldDefinitionId);
    if (definition === null) return notFoundOrInaccessible();
    // CROSS-MODULE COUPLING — read with fields/model.ts `isReferencedByPublishedVersion`.
    // Value SEMANTICS come from `recipeField.config` (the immutable snapshot);
    // `key` and `label` are joined live from the current definition. That join is
    // only safe for `key` because `isReferencedByPublishedVersion` counts RETIRED
    // versions as well as published ones, which freezes the key of any definition
    // an event could ever reference, for that event's whole lifetime. `label` is
    // deliberately mutable — it is a display string with no identity meaning — so
    // renaming a field is visible here immediately and by design.
    // If that helper is ever narrowed to published-only, a retired version's
    // definition becomes re-keyable and every historical event silently changes
    // the key it reports: I3 breaks with no test failing here.
    values.push({ fieldDefinitionId: stored.fieldDefinitionId, key: definition.key, label: definition.label, value: stored.value });
  }
  return { event, values };
}

export async function listProjectEvents(
  ctx: QueryCtx,
  args: { projectId: Id<'projects'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'events'>>> {
  const { project } = await requireProjectAccess(ctx, args.projectId);
  // Paginated and ordered by start time: a project's event list is unbounded (I6).
  return ctx.db
    .query('events')
    .withIndex('by_project_startsAt', (q) => q.eq('projectId', project._id))
    .paginate(args.paginationOpts);
}

/**
 * Resolves an Event, its owning Project, and proves the caller's access.
 *
 * Authenticates before resolving the id so nonexistent and foreign events are
 * indistinguishable (I9). The project is resolved here rather than at each call
 * site so that every event operation sees its container's lifecycle — an event
 * whose project is archived must not be writable through any door (F2) — and so
 * the stored project→event ownership is cross-checked rather than assumed.
 * `minimumRole` omitted means any member (viewer and above).
 */
export async function requireEventAccess(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<'events'>,
  minimumRole?: Role,
  preResolvedUser?: AuthenticatedUser,
): Promise<{ event: Doc<'events'>; project: Doc<'projects'>; access: OrganizationMembershipAccess }> {
  const authenticated = preResolvedUser ?? (await requireAuthenticatedUser(ctx));
  const event = await ctx.db.get(eventId);
  if (event === null) return notFoundOrInaccessible();
  const project = await ctx.db.get(event.projectId);
  if (project === null || project.organizationId !== event.organizationId) return notFoundOrInaccessible();
  const access =
    minimumRole === undefined
      ? await requireOrganizationMembership(ctx, event.organizationId, authenticated)
      : await requireOrganizationRole(ctx, event.organizationId, minimumRole, authenticated);
  return { event, project, access };
}

async function loadVersion(
  ctx: MutationCtx,
  versionId: Id<'recipeVersions'>,
): Promise<{ version: Doc<'recipeVersions'>; recipe: Doc<'eventRecipes'> }> {
  const version = await ctx.db.get(versionId);
  if (version === null) return notFoundOrInaccessible();
  // Authorization follows the stored recipe graph rather than trusting the
  // version's own organizationId (I4).
  const recipe = await ctx.db.get(version.recipeId);
  if (recipe === null || recipe.organizationId !== version.organizationId) return notFoundOrInaccessible();
  return { version, recipe };
}

/**
 * Materializes configured defaults for the rows a client omitted, so the caller
 * can validate one complete set. Submitted values always win, and a duplicate in
 * the submission is still caught by the gate because the client's entries come
 * first. Rows with no `defaultValue` stay absent and remain the required-field
 * check's business.
 */
function withRecipeDefaults(
  recipeFieldRows: Doc<'recipeFields'>[],
  submitted: { fieldDefinitionId: Id<'fieldDefinitions'>; value: EventFieldValue }[],
): { fieldDefinitionId: Id<'fieldDefinitions'>; value: EventFieldValue }[] {
  const provided = new Set(submitted.map((item) => item.fieldDefinitionId));
  const materialized = [...submitted];
  for (const recipeField of recipeFieldRows) {
    if (recipeField.defaultValue === undefined || provided.has(recipeField.fieldDefinitionId)) continue;
    materialized.push({ fieldDefinitionId: recipeField.fieldDefinitionId, value: recipeField.defaultValue });
  }
  return materialized;
}

function validateEventDates(startsAt: number, endsAt: number | undefined): void {
  // Convex accepts NaN/Infinity in v.number(); an unorderable bound silently
  // passes the comparison below, so it must never be stored.
  if (!isFiniteNumber(startsAt)) return invalidInput('eventStartInvalid', 'Event start must be a finite timestamp');
  if (endsAt !== undefined && !isFiniteNumber(endsAt)) return invalidInput('eventEndInvalid', 'Event end must be a finite timestamp');
  if (endsAt !== undefined && endsAt < startsAt) return invalidInput('eventDateRangeInvalid', 'Event end must not precede its start');
}

/**
 * The project-lifecycle half of the write gate, shared by every mutating door.
 *
 * Policy (the other half lives on `archiveProject` in projects/model.ts):
 * archiving a project is allowed no matter how many events it holds, and an
 * archived project is read-only for all of them. Events are never hard-deleted,
 * so archival is a freeze, not a cascade — the events stay readable, listable,
 * and interpretable under their own recipe versions forever.
 *
 * Exported because the freeze is a policy about the Event, not about this
 * module: relationships/model.ts gates its link writes on the same two helpers
 * so there is exactly one definition of "writable event" in the codebase.
 */
export function assertProjectAcceptsEventWrites(project: Doc<'projects'>): void {
  if (project.status === 'archived') return invalidInput('eventProjectReadOnly', 'Archived projects are read-only for their events');
}

/**
 * Creation is refused for a *completed* project too, not only an archived one:
 * a completed project is a finished piece of work, and adding operational data
 * to it is a mistake rather than a lifecycle step. Editing what is already there
 * stays permitted (only archival freezes that), so a completed project can still
 * be corrected without being reopened.
 */
function assertProjectAcceptsNewEvents(project: Doc<'projects'>): void {
  if (project.status === 'archived' || project.status === 'completed') {
    return invalidInput('eventProjectUnavailable', 'Only draft and active projects can receive new events');
  }
}

/** The full write gate: the container's lifecycle first, then the event's own. */
export function assertEventWritable(event: Doc<'events'>, project: Doc<'projects'>): void {
  assertProjectAcceptsEventWrites(project);
  if (event.status === 'completed' || event.status === 'cancelled') {
    return invalidInput('eventReadOnly', 'Completed and cancelled events are read-only');
  }
}

function assertEventTransition(current: EventStatus, next: EventStatus): void {
  if (current === 'completed' || current === 'cancelled') return invalidInput('eventTerminal', 'Completed and cancelled events are terminal');
  // Cancellation is reachable from every non-terminal state; the forward path is
  // strictly one step at a time, so skipping and reversing are both refused —
  // and so is re-declaring the current status, since no state succeeds itself.
  if (next === 'cancelled') return;
  const nextStatus: Partial<Record<EventStatus, EventStatus>> = {
    draft: 'planned',
    planned: 'confirmed',
    confirmed: 'active',
    active: 'completed',
  };
  if (nextStatus[current] !== next) return invalidInput('eventStatusTransitionInvalid', 'Event status transition is not permitted');
}
