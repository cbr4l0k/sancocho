import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import { assertEventAcceptsNewServices, requireEventAccess } from '../events/model';
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
import { getVersionFields } from '../serviceKinds/model';
import { isFiniteNumber, type serviceFieldValueValidator, type serviceStatusValidator } from '../validators';

type ServiceFieldValue = typeof serviceFieldValueValidator.type;
type ServiceStatus = typeof serviceStatusValidator.type;
type SubmittedValue = { fieldDefinitionId: Id<'fieldDefinitions'>; value: ServiceFieldValue | null };

/**
 * A submitted value paired with the serviceKind field row that governs it. The
 * validation gate produces these, and the write loops consume them, so a row is
 * resolved exactly once per request and the "unknown field" error has exactly
 * one site (it used to be re-derived per insert, with an unreachable duplicate
 * of the error behind it).
 */
type ResolvedValue<Value extends ServiceFieldValue | null> = {
  serviceKindField: Doc<'serviceKindFields'>;
  value: Value;
};
type ResolvedValues<Value extends ServiceFieldValue | null> = Map<Id<'fieldDefinitions'>, ResolvedValue<Value>>;

/**
 * Role floors for this domain, named rather than repeated as bare strings so the
 * policy is one decision instead of four call sites (rank comparison itself
 * lives in lib/roles.ts).
 *
 * Authoring an Service — creating it, editing its core fields, editing its typed
 * values — is planner-and-above, matching projects, serviceKinds, and locations.
 * Advancing an Service's status is deliberately one step lower: operators exist to
 * *run* services (mark them active, complete them, cancel them on the ground)
 * without being able to change what the service says it is. Viewers are excluded
 * from both; reading stays open to any member.
 */
const authoringRole: Role = 'planner';
const operatingRole: Role = 'operator';

/**
 * Creates an Service from a published ServiceKind Version snapshot.
 *
 * ServiceKind field defaults are materialized here and nowhere else: any row the
 * client omitted that carries a `defaultValue` is added to the submitted set
 * BEFORE the required-field check, so a required field with a configured default
 * succeeds when omitted. Materialized defaults go through the same validation
 * gate as client-supplied values — a default whose location has since been
 * archived fails creation exactly as an explicitly submitted one would, rather
 * than being written unchecked. Defaults are a creation-time concept only:
 * `updateServiceFields` never re-applies them, because after creation the absence
 * of a value is a deliberate state, not an unfilled blank.
 *
 * Services are operational records: they are never hard-deleted; cancellation is
 * their terminal removal path.
 */
export async function createServiceFromServiceKind(
  ctx: MutationCtx,
  args: {
    eventId: Id<'events'>;
    serviceKindVersionId: Id<'serviceKindVersions'>;
    name: string;
    startsAt: number;
    endsAt?: number;
    values: { fieldDefinitionId: Id<'fieldDefinitions'>; value: ServiceFieldValue }[];
  },
): Promise<Id<'services'>> {
  const { event, project, access } = await requireEventAccess(ctx, args.eventId, authoringRole);
  assertProjectAcceptsNewServices(project);
  assertEventAcceptsNewServices(event);
  const { version, serviceKind } = await loadVersion(ctx, args.serviceKindVersionId);
  // The project and the version must be the same tenant's; knowing one id from
  // each grants nothing (I1).
  if (project.organizationId !== version.organizationId) return notFoundOrInaccessible();
  // A serviceKind has at most one published version at a time — `publishServiceKindVersion`
  // and `archiveServiceKind` both go through `retireCurrentPublishedVersion` in
  // serviceKinds/model.ts — which is what makes "this version is published" equivalent
  // to "this is the serviceKind's *current* version". Services therefore cannot be
  // created from a superseded (retired) or unfinished (draft) rule set, while
  // existing services keep validating against whichever version they were born from.
  if (version.status !== 'published' || serviceKind.status === 'archived') {
    return invalidInput('serviceKindUnavailable', 'Services require a published version of an active serviceKind');
  }
  const name = validateEntityName(args.name, 'service');
  validateServiceDates(args.startsAt, args.endsAt);
  validateServiceWithinProjectWindow(project, args.startsAt, args.endsAt);
  const fields = await getVersionFields(ctx, version._id);
  const resolved = await validateServiceAgainstServiceKind(ctx, version, fields, withServiceKindDefaults(fields, args.values), true);

  const serviceId = await ctx.db.insert('services', {
    organizationId: project.organizationId,
    eventId: event._id,
    projectId: project._id,
    // Both serviceKind links are derived from the resolved version, never from client
    // args, and the service is permanently bound to this exact snapshot (I3/I4).
    serviceKindId: version.serviceKindId,
    serviceKindVersionId: version._id,
    name,
    status: 'draft',
    startsAt: args.startsAt,
    ...(args.endsAt === undefined ? {} : { endsAt: args.endsAt }),
  });
  for (const [fieldDefinitionId, { serviceKindField, value }] of resolved) {
    // The location mirror is derived from the value beside it and never
    // client-supplied (I4); see the contract on `locationIdFromValue`. Omitting
    // the key entirely (rather than writing `undefined`) is what keeps the
    // column absent for non-location values.
    const locationId = locationIdFromValue(value);
    await ctx.db.insert('serviceFieldValues', {
      organizationId: version.organizationId,
      serviceId,
      serviceKindFieldId: serviceKindField._id,
      fieldDefinitionId,
      value,
      ...(locationId === undefined ? {} : { locationId }),
    });
  }
  await recordAuditEvent(ctx, {
    organizationId: version.organizationId,
    actorUserId: access.user._id,
    action: 'service.created',
    entityType: 'service',
    entityId: serviceId,
    metadata: { serviceKindVersionId: version._id },
  });
  return serviceId;
}

/**
 * The sole typed-value gate, and the only place a submitted field definition is
 * resolved to the serviceKind field row that governs it.
 *
 * Every rule is read from `serviceKindField.config` — the immutable publish-time
 * snapshot — and never from the live `fieldDefinition`, which is what makes an
 * Service stay interpretable under exactly the rules it was written against, even
 * after its version is retired or the definition is edited for other serviceKinds
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
 * `storedValues` — supplied by the update path only — is what the service already
 * holds, keyed by field definition. A submitted value identical to the stored one
 * skips the RULE checks below (bounds, option identity, and the location's
 * usability): it already passed this exact immutable snapshot when it was
 * written, so re-checking it re-litigates history against the world as it is now.
 * That is what made a read-modify-write client — load the service, edit one field,
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
 * the field was visible in an earlier version), and `getService` returns it. Making
 * it a write rule would mean a published version could silently orphan values it
 * still owns, and making it a read rule would hide data the audit trail says
 * exists. Enforcement is the client's concern until a per-field permission model
 * (deliberately out of scope here) gives it a server-side meaning.
 */
export async function validateServiceAgainstServiceKind<Value extends ServiceFieldValue | null>(
  ctx: MutationCtx,
  version: Doc<'serviceKindVersions'>,
  serviceKindFieldRows: Doc<'serviceKindFields'>[],
  values: { fieldDefinitionId: Id<'fieldDefinitions'>; value: Value }[],
  requireAll: boolean,
  storedValues?: ReadonlyMap<Id<'fieldDefinitions'>, ServiceFieldValue>,
): Promise<ResolvedValues<Value>> {
  const byDefinition = new Map(serviceKindFieldRows.map((field) => [field.fieldDefinitionId, field]));
  const resolved: ResolvedValues<Value> = new Map();
  for (const item of values) {
    const serviceKindField = byDefinition.get(item.fieldDefinitionId);
    // A definition this version does not compose — including one belonging to
    // another tenant — is refused here, once, for every write path.
    if (serviceKindField === undefined) return invalidInput('serviceFieldUnknown', 'Service value references an unknown serviceKind field');
    if (resolved.has(item.fieldDefinitionId)) return invalidInput('serviceFieldDuplicate', 'Service values must not repeat field definitions');
    resolved.set(item.fieldDefinitionId, { serviceKindField, value: item.value });

    const value: ServiceFieldValue | null = item.value;
    if (value === null) {
      // Clearing is the only meaning of null, and a required field cannot be empty.
      if (serviceKindField.required) return invalidInput('serviceFieldRequired', 'Required service fields cannot be cleared');
      continue;
    }
    // An unchanged value is not a write, so it is not re-judged (see above).
    if (sameFieldValue(value, storedValues?.get(item.fieldDefinitionId))) continue;
    validateFieldValueAgainstConfig(serviceKindField.config, value);
    // The half the pure helper cannot do: the reference must resolve inside this
    // tenant and still be usable, and must fail generically (I1/I9).
    if (value.kind === 'location') await assertUsableLocation(ctx, value.locationId, version.organizationId);
  }
  if (requireAll && serviceKindFieldRows.some((field) => field.required && !resolved.has(field.fieldDefinitionId))) {
    return invalidInput('serviceFieldRequired', 'Required service fields must have a value');
  }
  return resolved;
}

/**
 * Edits an Service's own columns. Cancelled and completed services, and every service
 * of an archived project, are read-only; the serviceKind links are immutable because
 * no API accepts them.
 */
export async function updateServiceCoreFields(
  ctx: MutationCtx,
  args: { serviceId: Id<'services'>; name?: string; startsAt?: number; endsAt?: number | null },
): Promise<void> {
  const { service, project, access } = await requireServiceAccess(ctx, args.serviceId, authoringRole);
  assertServiceWritable(service, project);
  // Validated (and therefore trimmed) before the diff, so what is compared
  // against the stored name is exactly what would be stored.
  const name = args.name === undefined ? undefined : validateEntityName(args.name, 'service');
  // Ordering is checked on the MERGED pair, not on the arguments: patching only
  // `startsAt` past the stored `endsAt` must be refused just as an inverted pair
  // would be.
  const startsAt = args.startsAt ?? service.startsAt;
  // `null` explicitly clears the optional end, mirroring how a null field value
  // clears a stored value; omitting the argument leaves the stored end alone.
  const endsAt = args.endsAt === undefined ? service.endsAt : (args.endsAt ?? undefined);
  validateServiceDates(startsAt, endsAt);
  // Checked on the merged pair for the same reason the ordering rule is: moving
  // only one end out of the project's window is as much a violation as writing
  // both outside it.
  validateServiceWithinProjectWindow(project, startsAt, endsAt);

  // Built column by column rather than spreading client args, so only known
  // columns are written and the audit row names what actually changed.
  const patch: { name?: string; startsAt?: number; endsAt?: number | undefined } = {};
  const changedFields: string[] = [];
  if (name !== undefined && name !== service.name) {
    patch.name = name;
    changedFields.push('name');
  }
  if (args.startsAt !== undefined && args.startsAt !== service.startsAt) {
    patch.startsAt = args.startsAt;
    changedFields.push('startsAt');
  }
  if (endsAt !== service.endsAt) {
    // Assigning `undefined` is what removes the column on an explicit clear.
    patch.endsAt = endsAt;
    changedFields.push('endsAt');
  }
  // A no-op update writes neither a patch nor an empty audit row.
  if (changedFields.length === 0) return;

  await ctx.db.patch(service._id, patch);
  await recordAuditEvent(ctx, {
    organizationId: service.organizationId,
    actorUserId: access.user._id,
    action: 'service.updated',
    entityType: 'service',
    entityId: service._id,
    metadata: { changedFields: changedFields.join(',') },
  });
}

/**
 * Edits an Service's typed values. Planner+ may edit every field the version
 * composes; per-field permission granularity is future work. `null` explicitly
 * clears an optional value.
 *
 * The rule set is the service's OWN `serviceKindVersionId` rows, loaded with no status
 * filter: a retired version is still the rule set its services were written
 * against, and reading anything else — the serviceKind's currently published version,
 * or the live field definitions — would silently reinterpret history (I3).
 */
export async function updateServiceFields(
  ctx: MutationCtx,
  args: { serviceId: Id<'services'>; values: SubmittedValue[] },
): Promise<void> {
  const { service, project, access } = await requireServiceAccess(ctx, args.serviceId, authoringRole);
  assertServiceWritable(service, project);
  const { version } = await loadVersion(ctx, service.serviceKindVersionId);
  if (version.organizationId !== service.organizationId || version.serviceKindId !== service.serviceKindId) {
    return notFoundOrInaccessible();
  }
  const fields = await getVersionFields(ctx, version._id);
  // The service's stored values are read BEFORE the gate, not per field after it,
  // so the gate can tell a real edit from a resubmitted one and skip re-judging
  // the latter (see `validateServiceAgainstServiceKind`). One read of a bounded child
  // set — at most `maxFieldsPerVersion` rows, exactly like `getService` (I6) —
  // replaces one indexed read per submitted field.
  const storedRows = await ctx.db
    .query('serviceFieldValues')
    .withIndex('by_service_field', (q) => q.eq('serviceId', service._id))
    .collect();
  const stored = new Map(storedRows.map((row) => [row.fieldDefinitionId, row]));
  const resolved = await validateServiceAgainstServiceKind(
    ctx,
    version,
    fields,
    args.values,
    false,
    new Map(storedRows.map((row) => [row.fieldDefinitionId, row.value])),
  );

  // The audit row names the field definitions that actually changed, matching the
  // `changedFields` convention used by projects, serviceKinds, and locations — a bare
  // count said an edit happened without saying to what, and a resubmitted value
  // recorded an edit that never happened at all. The ACTION is its own literal
  // (`service.fieldsUpdated`), not `service.updated`: those ids are a different
  // vocabulary from the column names `updateServiceCoreFields` writes under the
  // same metadata key, and one action for both left a log consumer sniffing the
  // value to tell which it was reading.
  const changedFields: Id<'fieldDefinitions'>[] = [];
  for (const [fieldDefinitionId, { serviceKindField, value }] of resolved) {
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
      await ctx.db.insert('serviceFieldValues', {
        organizationId: service.organizationId,
        serviceId: service._id,
        serviceKindFieldId: serviceKindField._id,
        fieldDefinitionId,
        value,
        // Key omitted entirely for non-location values, so the column is absent
        // rather than present-and-undefined.
        ...(locationId === undefined ? {} : { locationId }),
      });
      continue;
    }
    await ctx.db.patch(existing._id, {
      organizationId: service.organizationId,
      serviceId: service._id,
      serviceKindFieldId: serviceKindField._id,
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
    organizationId: service.organizationId,
    actorUserId: access.user._id,
    action: 'service.fieldsUpdated',
    entityType: 'service',
    entityId: service._id,
    metadata: { changedFields: changedFields.join(',') },
  });
}

/**
 * Lifecycle matrix: draft→planned→confirmed→active→completed; any non-completed
 * state→cancelled. Completed and cancelled are terminal.
 *
 * Open to operators (see `operatingRole`), because running an service is exactly
 * what a status transition is. Still refused for an archived project: an archived
 * project freezes its services entirely, cancellation included.
 */
export async function changeServiceStatus(
  ctx: MutationCtx,
  args: { serviceId: Id<'services'>; status: ServiceStatus },
): Promise<void> {
  const { service, project, access } = await requireServiceAccess(ctx, args.serviceId, operatingRole);
  assertProjectAcceptsServiceWrites(project);
  // Same-status is refused by the transition matrix itself (no state is its own
  // successor, and terminal states are refused before that), so there is no
  // no-op branch here to skip the write.
  assertServiceTransition(service.status, args.status);
  await ctx.db.patch(service._id, { status: args.status });
  await recordAuditEvent(ctx, {
    organizationId: service.organizationId,
    actorUserId: access.user._id,
    // Cancellation gets its own action so the terminal removal path is greppable
    // in the audit trail rather than hidden among ordinary advances.
    action: args.status === 'cancelled' ? 'service.cancelled' : 'service.statusChanged',
    entityType: 'service',
    entityId: service._id,
    metadata: { previousStatus: service.status },
  });
}

export async function getService(
  ctx: QueryCtx,
  serviceId: Id<'services'>,
): Promise<{
  service: Doc<'services'>;
  values: {
    fieldDefinitionId: Id<'fieldDefinitions'>;
    key: string;
    label: string;
    value: ServiceFieldValue;
    locationName?: string;
  }[];
}> {
  const { service } = await requireServiceAccess(ctx, serviceId);
  const locations = new Map<Id<'locations'>, Doc<'locations'> | null>();
  const storedValues = await ctx.db
    .query('serviceFieldValues')
    .withIndex('by_service_field', (q) => q.eq('serviceId', service._id))
    .collect();
  // One bounded read of the service's own version rows, indexed by definition,
  // replaces a per-value `db.get` of the serviceKind field.
  const byDefinition = new Map(
    (await getVersionFields(ctx, service.serviceKindVersionId)).map((field) => [field.fieldDefinitionId, field]),
  );

  const values: {
    fieldDefinitionId: Id<'fieldDefinitions'>;
    key: string;
    label: string;
    value: ServiceFieldValue;
    locationName?: string;
  }[] = [];
  for (const stored of storedValues) {
    const serviceKindField = byDefinition.get(stored.fieldDefinitionId);
    // The stored row must be one this version actually composes, and must point
    // at that exact row: a value whose `serviceKindFieldId` belongs to another version
    // is corruption, not a reinterpretation to paper over.
    if (serviceKindField === undefined || serviceKindField._id !== stored.serviceKindFieldId) return notFoundOrInaccessible();
    const definition = await ctx.db.get(serviceKindField.fieldDefinitionId);
    if (definition === null) return notFoundOrInaccessible();
    // CROSS-MODULE COUPLING — read with fields/model.ts `isReferencedByPublishedVersion`.
    // Value SEMANTICS come from `serviceKindField.config` (the immutable snapshot);
    // `key` and `label` are joined live from the current definition. That join is
    // only safe for `key` because `isReferencedByPublishedVersion` counts RETIRED
    // versions as well as published ones, which freezes the key of any definition
    // an service could ever reference, for that service's whole lifetime. `label` is
    // deliberately mutable — it is a display string with no identity meaning — so
    // renaming a field is visible here immediately and by design.
    // If that helper is ever narrowed to published-only, a retired version's
    // definition becomes re-keyable and every historical service silently changes
    // the key it reports: I3 breaks with no test failing here.
    values.push({
      fieldDefinitionId: stored.fieldDefinitionId,
      key: definition.key,
      label: definition.label,
      value: stored.value,
      // A location value is a reference; the console needs its name to render
      // anything better than a raw id. See `locationNameOf`.
      ...(await locationNameOf(ctx, locations, service.organizationId, stored.value)),
    });
  }
  return { service, values };
}

export async function listProjectServices(
  ctx: QueryCtx,
  args: { projectId: Id<'projects'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'services'>>> {
  const { project } = await requireProjectAccess(ctx, args.projectId);
  // Paginated and ordered by start time: a project's service list is unbounded (I6).
  return ctx.db
    .query('services')
    .withIndex('by_project_startsAt', (q) => q.eq('projectId', project._id))
    .paginate(args.paginationOpts);
}

export async function listEventServices(
  ctx: QueryCtx,
  args: { eventId: Id<'events'>; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'services'>>> {
  const { event } = await requireEventAccess(ctx, args.eventId);
  // Paginated and ordered by start time: an Event's Service set is unbounded (I6).
  return ctx.db
    .query('services')
    .withIndex('by_event_startsAt', (q) => q.eq('eventId', event._id))
    .paginate(args.paginationOpts);
}

/**
 * One row of the Services table: the service, the project it belongs to, and the
 * values of every field its own ServiceKind Version composes.
 *
 * The console's Services screen is organization-wide and column-configurable,
 * so it needs more per row than the service document — the project name (services
 * from every project are interleaved in one list) and the typed values (a
 * serviceKind with fifteen fields should be able to show fifteen columns). Fetching
 * each row's values separately would be one query per visible row; the join is
 * done here instead, once per page.
 */
export type ServiceRow = {
  service: Doc<'services'>;
  projectName: string;
  projectStatus: Doc<'projects'>['status'];
  /**
   * The owning project's window, carried on the row so an editor in the table
   * can bound its pickers and name a violation before a round trip. It is an
   * affordance: `validateServiceWithinProjectWindow` remains the only thing that
   * decides. Both ends are optional because a project's dates are.
   */
  projectStartsAt?: number;
  projectEndsAt?: number;
  fields: {
    fieldDefinitionId: Id<'fieldDefinitions'>;
    key: string;
    label: string;
    required: boolean;
    position: number;
    config: Doc<'serviceKindFields'>['config'];
    value?: ServiceFieldValue;
    /**
     * Present only for a stored `location` value. A location value is a
     * reference, and a table cell showing the raw id is not information — the
     * name is joined here, from the same tenant's location catalogue, so the
     * console never has to fetch the whole catalogue to render a column.
     */
    locationName?: string;
  }[];
};

/**
 * The organization's services across every project, ordered by start time.
 *
 * Filters pick the index rather than post-filtering a page, so a status- or
 * project-restricted list never reads rows it will discard (I6 — the same
 * reasoning that put those composite indexes in schema.ts).
 * `projectId` is proven through `requireProjectAccess`, so a project id from
 * another tenant is indistinguishable from one that does not exist (I9).
 */
export async function listOrganizationServices(
  ctx: QueryCtx,
  args: {
    organizationId: Id<'organizations'>;
    projectId?: Id<'projects'>;
    status?: ServiceStatus;
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<ServiceRow>> {
  const authenticated = await requireAuthenticatedUser(ctx);
  await requireOrganizationMembership(ctx, args.organizationId, authenticated);
  if (args.projectId !== undefined) {
    const { project } = await requireProjectAccess(ctx, args.projectId);
    // The membership above proves the caller belongs to `organizationId`; this
    // proves the project does, so neither id can be used to reach the other's
    // tenant (I1).
    if (project.organizationId !== args.organizationId) return notFoundOrInaccessible();
  }

  const page = await paginateServices(ctx, args);
  return { ...page, page: await decorateServices(ctx, page.page) };
}

function paginateServices(
  ctx: QueryCtx,
  args: {
    organizationId: Id<'organizations'>;
    projectId?: Id<'projects'>;
    status?: ServiceStatus;
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<Doc<'services'>>> {
  const { organizationId, projectId, status, paginationOpts } = args;
  const services = ctx.db.query('services');
  if (projectId !== undefined) {
    return status === undefined
      ? services.withIndex('by_project_startsAt', (q) => q.eq('projectId', projectId)).paginate(paginationOpts)
      : services
          .withIndex('by_project_status_startsAt', (q) => q.eq('projectId', projectId).eq('status', status))
          .paginate(paginationOpts);
  }
  return status === undefined
    ? services.withIndex('by_org_startsAt', (q) => q.eq('organizationId', organizationId)).paginate(paginationOpts)
    : services
        .withIndex('by_org_status_startsAt', (q) => q.eq('organizationId', organizationId).eq('status', status))
        .paginate(paginationOpts);
}

/**
 * Joins one page of services to their project and to their own version's fields.
 *
 * Every lookup that repeats across a page is memoized: a page of one project's
 * services shares a project document and usually a single serviceKind version, so
 * the naive version would re-read the same version's field rows and the same
 * field definitions once per row. Field values are read through
 * `by_service_field`, a bounded child set per service (I6 does not apply — a
 * version cannot compose more than `maxFieldsPerVersion` fields).
 *
 * Only `visible` fields are returned: an invisible field is not part of what
 * the serviceKind presents, and the table must not become the one surface that
 * leaks it.
 */
async function decorateServices(ctx: QueryCtx, services: Doc<'services'>[]): Promise<ServiceRow[]> {
  const projects = new Map<Id<'projects'>, Doc<'projects'> | null>();
  const versionFields = new Map<Id<'serviceKindVersions'>, Doc<'serviceKindFields'>[]>();
  const definitions = new Map<Id<'fieldDefinitions'>, Doc<'fieldDefinitions'> | null>();
  const locations = new Map<Id<'locations'>, Doc<'locations'> | null>();

  const rows: ServiceRow[] = [];
  for (const service of services) {
    let project = projects.get(service.projectId);
    if (project === undefined) {
      project = await ctx.db.get(service.projectId);
      projects.set(service.projectId, project);
    }
    // The stored ownership graph is cross-checked rather than assumed, exactly
    // as `requireServiceAccess` does for the single-service doors (I4).
    if (project === null || project.organizationId !== service.organizationId) return notFoundOrInaccessible();

    let serviceKindFields = versionFields.get(service.serviceKindVersionId);
    if (serviceKindFields === undefined) {
      serviceKindFields = await getVersionFields(ctx, service.serviceKindVersionId);
      versionFields.set(service.serviceKindVersionId, serviceKindFields);
    }
    const stored = new Map(
      (
        await ctx.db
          .query('serviceFieldValues')
          .withIndex('by_service_field', (q) => q.eq('serviceId', service._id))
          .collect()
      ).map((value) => [value.fieldDefinitionId, value]),
    );

    const fields: ServiceRow['fields'] = [];
    for (const serviceKindField of serviceKindFields) {
      if (!serviceKindField.visible) continue;
      let definition = definitions.get(serviceKindField.fieldDefinitionId);
      if (definition === undefined) {
        definition = await ctx.db.get(serviceKindField.fieldDefinitionId);
        definitions.set(serviceKindField.fieldDefinitionId, definition);
      }
      if (definition === null) return notFoundOrInaccessible();
      const value = stored.get(serviceKindField.fieldDefinitionId);
      // A stored value must point at this exact version's row; one carrying
      // another version's `serviceKindFieldId` is corruption. `getService` above makes
      // the same check for the same reason.
      if (value !== undefined && value.serviceKindFieldId !== serviceKindField._id) return notFoundOrInaccessible();
      fields.push({
        fieldDefinitionId: serviceKindField.fieldDefinitionId,
        // `key` is stable for this service's lifetime and `label` is deliberately
        // live — the coupling note on `getService` is the full contract.
        key: definition.key,
        label: definition.label,
        required: serviceKindField.required,
        position: serviceKindField.position,
        // Semantics come from the immutable snapshot, never the live
        // definition, so an inline editor validates against the rules this
        // service was created under (I3).
        config: serviceKindField.config,
        ...(value === undefined ? {} : { value: value.value }),
        ...(await locationNameOf(ctx, locations, service.organizationId, value?.value)),
      });
    }
    rows.push({
      service,
      projectName: project.name,
      projectStatus: project.status,
      ...(project.startsAt === undefined ? {} : { projectStartsAt: project.startsAt }),
      ...(project.endsAt === undefined ? {} : { projectEndsAt: project.endsAt }),
      fields,
    });
  }
  return rows;
}

/**
 * The display name of a `location` value, memoized across the page.
 *
 * Returns a spreadable fragment rather than a bare string so a non-location
 * value (or a location the tenant can no longer see) leaves the key absent
 * instead of writing `undefined` into the row. The organization is re-checked
 * on the way out: a stored reference is not a licence to read across tenants,
 * even though every write path already enforces it (I1).
 */
async function locationNameOf(
  ctx: QueryCtx,
  cache: Map<Id<'locations'>, Doc<'locations'> | null>,
  organizationId: Id<'organizations'>,
  value: ServiceFieldValue | undefined,
): Promise<{ locationName?: string }> {
  if (value === undefined || value.kind !== 'location') return {};
  let location = cache.get(value.locationId);
  if (location === undefined) {
    location = await ctx.db.get(value.locationId);
    cache.set(value.locationId, location);
  }
  return location === null || location.organizationId !== organizationId ? {} : { locationName: location.name };
}

/**
 * Resolves a Service, its owning Event and Project, and proves the caller's access.
 *
 * Authenticates before resolving the id so nonexistent and foreign services are
 * indistinguishable (I9). The project is resolved here rather than at each call
 * site so that every service operation sees its container's lifecycle — an service
 * whose project is archived must not be writable through any door (F2) — and so
 * the stored project→service ownership is cross-checked rather than assumed.
 * `minimumRole` omitted means any member (viewer and above).
 */
export async function requireServiceAccess(
  ctx: QueryCtx | MutationCtx,
  serviceId: Id<'services'>,
  minimumRole?: Role,
  preResolvedUser?: AuthenticatedUser,
): Promise<{ service: Doc<'services'>; event: Doc<'events'>; project: Doc<'projects'>; access: OrganizationMembershipAccess }> {
  const authenticated = preResolvedUser ?? (await requireAuthenticatedUser(ctx));
  const service = await ctx.db.get(serviceId);
  if (service === null) return notFoundOrInaccessible();
  const event = await ctx.db.get(service.eventId);
  if (
    event === null ||
    event.organizationId !== service.organizationId ||
    event.projectId !== service.projectId
  ) return notFoundOrInaccessible();
  const project = await ctx.db.get(event.projectId);
  if (project === null || project.organizationId !== event.organizationId) return notFoundOrInaccessible();
  const access =
    minimumRole === undefined
      ? await requireOrganizationMembership(ctx, service.organizationId, authenticated)
      : await requireOrganizationRole(ctx, service.organizationId, minimumRole, authenticated);
  return { service, event, project, access };
}

async function loadVersion(
  ctx: MutationCtx,
  versionId: Id<'serviceKindVersions'>,
): Promise<{ version: Doc<'serviceKindVersions'>; serviceKind: Doc<'serviceKinds'> }> {
  const version = await ctx.db.get(versionId);
  if (version === null) return notFoundOrInaccessible();
  // Authorization follows the stored serviceKind graph rather than trusting the
  // version's own organizationId (I4).
  const serviceKind = await ctx.db.get(version.serviceKindId);
  if (serviceKind === null || serviceKind.organizationId !== version.organizationId) return notFoundOrInaccessible();
  return { version, serviceKind };
}

/**
 * Materializes configured defaults for the rows a client omitted, so the caller
 * can validate one complete set. Submitted values always win, and a duplicate in
 * the submission is still caught by the gate because the client's entries come
 * first. Rows with no `defaultValue` stay absent and remain the required-field
 * check's business.
 */
function withServiceKindDefaults(
  serviceKindFieldRows: Doc<'serviceKindFields'>[],
  submitted: { fieldDefinitionId: Id<'fieldDefinitions'>; value: ServiceFieldValue }[],
): { fieldDefinitionId: Id<'fieldDefinitions'>; value: ServiceFieldValue }[] {
  const provided = new Set(submitted.map((item) => item.fieldDefinitionId));
  const materialized = [...submitted];
  for (const serviceKindField of serviceKindFieldRows) {
    if (serviceKindField.defaultValue === undefined || provided.has(serviceKindField.fieldDefinitionId)) continue;
    materialized.push({ fieldDefinitionId: serviceKindField.fieldDefinitionId, value: serviceKindField.defaultValue });
  }
  return materialized;
}

function validateServiceDates(startsAt: number, endsAt: number | undefined): void {
  // Convex accepts NaN/Infinity in v.number(); an unorderable bound silently
  // passes the comparison below, so it must never be stored.
  if (!isFiniteNumber(startsAt)) return invalidInput('serviceStartInvalid', 'Service start must be a finite timestamp');
  if (endsAt !== undefined && !isFiniteNumber(endsAt)) return invalidInput('serviceEndInvalid', 'Service end must be a finite timestamp');
  if (endsAt !== undefined && endsAt < startsAt) return invalidInput('serviceDateRangeInvalid', 'Service end must not precede its start');
}

/**
 * A Project's own window is the operational envelope its Services live inside.
 *
 * A festival that runs the 15th to the 19th has no service on the 22nd, and a
 * service that finishes before the festival's established start is data entry
 * gone wrong rather than a plan — both used to be accepted, because the only
 * date rule was the service's own internal ordering (`validateServiceDates`) and
 * nothing ever compared an service to its container.
 *
 * Each bound is enforced only when the project actually declares it: the
 * project window is optional on both ends, and a project with no dates
 * constrains nothing. Comparing the service's LAST instant (`endsAt ?? startsAt`)
 * against the project's end covers the open-ended case without a second rule.
 *
 * This is a WRITE-TIME rule on services, deliberately not retroactive: narrowing
 * a project's window later cannot be made to reject already-stored services
 * without scanning every service in the project (I6), so `updateProject` leaves
 * historical rows alone and this gate governs everything written from here on.
 */
function validateServiceWithinProjectWindow(project: Doc<'projects'>, startsAt: number, endsAt: number | undefined): void {
  if (project.startsAt !== undefined && startsAt < project.startsAt) {
    return invalidInput('serviceBeforeProjectWindow', 'Service starts before its project window');
  }
  if (project.endsAt !== undefined && (endsAt ?? startsAt) > project.endsAt) {
    return invalidInput('serviceAfterProjectWindow', 'Service ends after its project window');
  }
}

/**
 * The project-lifecycle half of the write gate, shared by every mutating door.
 *
 * Policy (the other half lives on `archiveProject` in projects/model.ts):
 * archiving a project is allowed no matter how many services it holds, and an
 * archived project is read-only for all of them. Services are never hard-deleted,
 * so archival is a freeze, not a cascade — the services stay readable, listable,
 * and interpretable under their own serviceKind versions forever.
 *
 * Exported because the freeze is a policy about the Service, not about this
 * module: relationships/model.ts gates its link writes on the same two helpers
 * so there is exactly one definition of "writable service" in the codebase.
 */
export function assertProjectAcceptsServiceWrites(project: Doc<'projects'>): void {
  if (project.status === 'archived') return invalidInput('serviceProjectReadOnly', 'Archived projects are read-only for their services');
}

/**
 * Creation is refused for a *completed* project too, not only an archived one:
 * a completed project is a finished piece of work, and adding operational data
 * to it is a mistake rather than a lifecycle step. Editing what is already there
 * stays permitted (only archival freezes that), so a completed project can still
 * be corrected without being reopened.
 */
function assertProjectAcceptsNewServices(project: Doc<'projects'>): void {
  if (project.status === 'archived' || project.status === 'completed') {
    return invalidInput('serviceProjectUnavailable', 'Only draft and active projects can receive new services');
  }
}

/** The full write gate: the container's lifecycle first, then the service's own. */
export function assertServiceWritable(service: Doc<'services'>, project: Doc<'projects'>): void {
  assertProjectAcceptsServiceWrites(project);
  if (service.status === 'completed' || service.status === 'cancelled') {
    return invalidInput('serviceReadOnly', 'Completed and cancelled services are read-only');
  }
}

function assertServiceTransition(current: ServiceStatus, next: ServiceStatus): void {
  if (current === 'completed' || current === 'cancelled') return invalidInput('serviceTerminal', 'Completed and cancelled services are terminal');
  // Cancellation is reachable from every non-terminal state; the forward path is
  // strictly one step at a time, so skipping and reversing are both refused —
  // and so is re-declaring the current status, since no state succeeds itself.
  if (next === 'cancelled') return;
  const nextStatus: Partial<Record<ServiceStatus, ServiceStatus>> = {
    draft: 'planned',
    planned: 'confirmed',
    confirmed: 'active',
    active: 'completed',
  };
  if (nextStatus[current] !== next) return invalidInput('serviceStatusTransitionInvalid', 'Service status transition is not permitted');
}
