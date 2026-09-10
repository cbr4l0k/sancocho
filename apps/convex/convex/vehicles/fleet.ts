import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { recordAuditEvent } from '../audit/model';
import {
  requireAuthenticatedUser,
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { conflict, invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { maxEntityNameLength } from '../lib/names';
import { organizationConfigurationRole, type Role } from '../lib/roles';
import { assertSearchTermLength, normalizeSearchTerm, normalizeSearchText } from '../lib/search';
import { assertUsableProvider } from '../providers/model';
import type { archivalStatusValidator } from '../validators';
import { assertUsableVehicleClass } from './classes';

type ArchivalStatus = typeof archivalStatusValidator.type;
type FleetVehiclePatch = {
  providerId?: Id<'providers'>;
  vehicleClassId?: Id<'vehicleClasses'>;
  plate?: string;
  label?: string;
  year?: number;
  notes?: string;
};
type FleetVehicleListFilters = {
  status?: ArchivalStatus;
  providerId?: Id<'providers'>;
  vehicleClassId?: Id<'vehicleClasses'>;
  search?: string;
};

/**
 * Plates are short by every jurisdiction's rules; this bound is the ordinary
 * "bound every free-form caller string" guard (I5), applied to the trimmed value.
 */
const maxPlateLength = 32;
const maxFleetVehicleNotesLength = 2000;
/**
 * A model year, bounded as a plausible year rather than as a product rule. The
 * point is that `20255` and `0` are typos, not that a 1901 bus is disallowed.
 */
const minVehicleYear = 1900;
const maxVehicleYear = 2200;

/**
 * THE PLATE UNIQUENESS RULE, stated exactly once.
 *
 * Diacritics folded, case folded, and every non-alphanumeric character REMOVED
 * — not replaced by a space, which is what separates this from
 * `normalizeSearchText`. That difference is the whole point: `normalizeSearchText`
 * turns `ABC-123` into `abc 123` and `abc123` into `abc123`, so it would treat
 * two spellings of one plate as two vehicles. Here `ABC 123`, `abc-123`,
 * `ABC.123` and `  abc123  ` all fold to `ABC123`.
 *
 * The result is stored beside the plate rather than replacing it: the display
 * value is what a dispatcher reads off a windscreen, and the key is what the
 * database enforces. Exported so tests can pin the folding directly.
 */
export function normalizePlate(plate: string): string {
  return plate
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export async function createFleetVehicle(
  ctx: MutationCtx,
  args: {
    organizationId: Id<'organizations'>;
    providerId: Id<'providers'>;
    vehicleClassId: Id<'vehicleClasses'>;
    plate: string;
    label?: string;
    year?: number;
    notes?: string;
  },
): Promise<Id<'fleetVehicles'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, organizationConfigurationRole);
  // BOTH referenced ids are proven to belong to THIS organization before a row
  // that names them can exist (I1/I4). The organizationId is the one the caller
  // just proved a role in, never a column copied off the referenced row, so a
  // foreign Provider cannot drag its own tenant in behind it.
  await assertUsableProvider(ctx, args.providerId, args.organizationId);
  await assertUsableVehicleClass(ctx, args.vehicleClassId, args.organizationId);
  const plate = validatedPlate(args.plate);
  const plateKey = normalizePlate(plate);
  const label = validatedLabel(args.label);
  validateYear(args.year);
  const notes = validatedNotes(args.notes);
  // Same-transaction indexed read-before-write on the NORMALISED key. Convex OCC
  // makes concurrent creators retry against the winning row instead of admitting
  // duplicates; this is never a scan.
  await assertPlateAvailable(ctx, args.organizationId, plateKey);
  const fleetVehicleId = await ctx.db.insert('fleetVehicles', {
    organizationId: args.organizationId,
    providerId: args.providerId,
    vehicleClassId: args.vehicleClassId,
    plate,
    plateKey,
    ...(label === undefined ? {} : { label }),
    ...(args.year === undefined ? {} : { year: args.year }),
    ...(notes === undefined ? {} : { notes }),
    searchText: fleetVehicleSearchText(plate, plateKey, label),
    status: 'active',
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'fleetVehicle.created',
    entityType: 'fleetVehicle',
    entityId: fleetVehicleId,
    metadata: { plate, providerId: args.providerId },
  });
  return fleetVehicleId;
}

export async function getFleetVehicle(ctx: QueryCtx, fleetVehicleId: Id<'fleetVehicles'>): Promise<Doc<'fleetVehicles'>> {
  const { fleetVehicle } = await requireFleetVehicleAccess(ctx, fleetVehicleId);
  return fleetVehicle;
}

export async function listFleetVehicles(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
  filters: FleetVehicleListFilters,
): Promise<PaginationResult<Doc<'fleetVehicles'>>> {
  // The MEMBER arm only — see the identical note on `listVehicleClasses`. A
  // Provider Principal enumerating a coordinator's fleet would learn which other
  // firms the coordinator uses, which is exactly what the grant does not confer.
  await requireOrganizationMembership(ctx, organizationId);
  assertSearchTermLength(filters.search);
  const term = normalizeSearchTerm(filters.search ?? '');
  const { providerId, vehicleClassId, status } = filters;
  // EVERY branch narrows through a declared index BEFORE `.paginate`. Filtering
  // an already-fetched page would return short pages and make `numItems` a lie,
  // and would read every vehicle in the tenant to answer a one-provider question (I6).
  if (term !== '') {
    return ctx.db.query('fleetVehicles').withSearchIndex('search_text', (q) => {
      let search = q.search('searchText', term).eq('organizationId', organizationId);
      if (providerId !== undefined) search = search.eq('providerId', providerId);
      if (vehicleClassId !== undefined) search = search.eq('vehicleClassId', vehicleClassId);
      if (status !== undefined) search = search.eq('status', status);
      return search;
    }).paginate(paginationOpts);
  }
  if (providerId !== undefined && vehicleClassId !== undefined) {
    if (status !== undefined) {
      return ctx.db
        .query('fleetVehicles')
        .withIndex('by_org_provider_class_status', (q) =>
          q.eq('organizationId', organizationId).eq('providerId', providerId).eq('vehicleClassId', vehicleClassId).eq('status', status),
        )
        .paginate(paginationOpts);
    }
    return ctx.db
      .query('fleetVehicles')
      .withIndex('by_org_provider_class_status', (q) =>
        q.eq('organizationId', organizationId).eq('providerId', providerId).eq('vehicleClassId', vehicleClassId),
      )
      .paginate(paginationOpts);
  }
  if (providerId !== undefined) {
    if (status !== undefined) {
      return ctx.db
        .query('fleetVehicles')
        .withIndex('by_org_provider_status', (q) => q.eq('organizationId', organizationId).eq('providerId', providerId).eq('status', status))
        .paginate(paginationOpts);
    }
    return ctx.db
      .query('fleetVehicles')
      .withIndex('by_org_provider_status', (q) => q.eq('organizationId', organizationId).eq('providerId', providerId))
      .paginate(paginationOpts);
  }
  if (vehicleClassId !== undefined) {
    if (status !== undefined) {
      return ctx.db
        .query('fleetVehicles')
        .withIndex('by_org_class_status', (q) => q.eq('organizationId', organizationId).eq('vehicleClassId', vehicleClassId).eq('status', status))
        .paginate(paginationOpts);
    }
    return ctx.db
      .query('fleetVehicles')
      .withIndex('by_org_class_status', (q) => q.eq('organizationId', organizationId).eq('vehicleClassId', vehicleClassId))
      .paginate(paginationOpts);
  }
  if (status !== undefined) {
    return ctx.db
      .query('fleetVehicles')
      .withIndex('by_org_status', (q) => q.eq('organizationId', organizationId).eq('status', status))
      .paginate(paginationOpts);
  }
  // Paginated because a tenant's fleet is unbounded (I6).
  return ctx.db
    .query('fleetVehicles')
    .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
    .paginate(paginationOpts);
}

export async function updateFleetVehicle(
  ctx: MutationCtx,
  fleetVehicleId: Id<'fleetVehicles'>,
  patch: FleetVehiclePatch,
): Promise<void> {
  const { fleetVehicle, access } = await requireFleetVehicleAccess(ctx, fleetVehicleId, organizationConfigurationRole);
  // Re-proven on EVERY update, not only at insert: a same-org constraint that
  // holds until somebody edits their way past it is not a constraint. Deliberately
  // BEFORE the archived-lifecycle guard below, so a caller can never use this
  // mutation to learn anything about a Provider or Class it does not own — every
  // failure here is the generic error (I1/I9).
  if (patch.providerId !== undefined) {
    await assertUsableProvider(ctx, patch.providerId, fleetVehicle.organizationId);
  }
  if (patch.vehicleClassId !== undefined) {
    await assertUsableVehicleClass(ctx, patch.vehicleClassId, fleetVehicle.organizationId);
  }
  if (fleetVehicle.status === 'archived') {
    return invalidInput('fleetVehicleArchived', 'Archived Fleet Vehicles cannot be updated');
  }
  // Validated (and therefore trimmed) before the diff, so what is compared
  // against the stored value is exactly what would be stored.
  const plate = patch.plate === undefined ? undefined : validatedPlate(patch.plate);
  const label = validatedLabel(patch.label);
  validateYear(patch.year);
  const notes = validatedNotes(patch.notes);

  const update: Omit<FleetVehiclePatch, 'plate'> & { plate?: string; plateKey?: string; searchText?: string } = {};
  const changedFields: string[] = [];
  if (patch.providerId !== undefined && patch.providerId !== fleetVehicle.providerId) {
    update.providerId = patch.providerId;
    changedFields.push('providerId');
  }
  if (patch.vehicleClassId !== undefined && patch.vehicleClassId !== fleetVehicle.vehicleClassId) {
    update.vehicleClassId = patch.vehicleClassId;
    changedFields.push('vehicleClassId');
  }
  if (plate !== undefined && plate !== fleetVehicle.plate) {
    const plateKey = normalizePlate(plate);
    // A re-plate is subject to the same normalised uniqueness rule as a create,
    // through the same index. Skipped when the key is unchanged, so correcting
    // `ABC 123` to `ABC-123` does not collide with the row's own key.
    if (plateKey !== fleetVehicle.plateKey) {
      await assertPlateAvailable(ctx, fleetVehicle.organizationId, plateKey);
      update.plateKey = plateKey;
    }
    update.plate = plate;
    changedFields.push('plate');
  }
  if (label !== undefined && label !== fleetVehicle.label) {
    update.label = label;
    changedFields.push('label');
  }
  if (patch.year !== undefined && patch.year !== fleetVehicle.year) {
    update.year = patch.year;
    changedFields.push('year');
  }
  if (notes !== undefined && notes !== fleetVehicle.notes) {
    update.notes = notes;
    changedFields.push('notes');
  }
  if (changedFields.length === 0) return;
  // Re-derived from the values that will actually be stored, so search follows a
  // re-plate or a relabel (I4).
  if (update.plate !== undefined || update.label !== undefined) {
    const nextPlate = update.plate ?? fleetVehicle.plate;
    update.searchText = fleetVehicleSearchText(nextPlate, update.plateKey ?? fleetVehicle.plateKey, update.label ?? fleetVehicle.label);
  }
  await ctx.db.patch(fleetVehicleId, update);
  await recordAuditEvent(ctx, {
    organizationId: fleetVehicle.organizationId,
    actorUserId: access.user._id,
    action: 'fleetVehicle.updated',
    entityType: 'fleetVehicle',
    entityId: fleetVehicleId,
    metadata: { changedFields: changedFields.join(',') },
  });
}

export async function archiveFleetVehicle(ctx: MutationCtx, fleetVehicleId: Id<'fleetVehicles'>): Promise<void> {
  const { fleetVehicle, access } = await requireFleetVehicleAccess(ctx, fleetVehicleId, organizationConfigurationRole);
  if (fleetVehicle.status === 'archived') return;
  await ctx.db.patch(fleetVehicleId, { status: 'archived' });
  await recordAuditEvent(ctx, {
    organizationId: fleetVehicle.organizationId,
    actorUserId: access.user._id,
    action: 'fleetVehicle.archived',
    entityType: 'fleetVehicle',
    entityId: fleetVehicleId,
    metadata: { previousStatus: fleetVehicle.status },
  });
}

export async function deleteFleetVehicle(ctx: MutationCtx, fleetVehicleId: Id<'fleetVehicles'>): Promise<void> {
  const { fleetVehicle, access } = await requireFleetVehicleAccess(ctx, fleetVehicleId, organizationConfigurationRole);
  if (fleetVehicle.status !== 'archived') {
    return invalidInput('fleetVehicleArchiveRequired', 'Fleet Vehicles must be archived before deletion');
  }
  const assignment = await ctx.db
    .query('assignments')
    .withIndex('by_fleetVehicle', (q) => q.eq('fleetVehicleId', fleetVehicle._id))
    .first();
  if (assignment !== null) {
    return invalidInput('fleetVehicleDeleteBlocked', 'Fleet Vehicles referenced by Assignments cannot be deleted');
  }
  //
  // Recorded BEFORE the delete so the plate is still readable, matching
  // `deleteLocation`, `deleteCostCentre` and `deleteProvider`.
  await recordAuditEvent(ctx, {
    organizationId: fleetVehicle.organizationId,
    actorUserId: access.user._id,
    action: 'fleetVehicle.deleted',
    entityType: 'fleetVehicle',
    entityId: fleetVehicleId,
    metadata: { plate: fleetVehicle.plate, providerId: fleetVehicle.providerId },
  });
  await ctx.db.delete(fleetVehicleId);
}

/**
 * Resolves the caller-supplied execution reference without granting catalogue
 * access. Every mismatch is deliberately the same opaque failure (I9).
 */
export async function assertAssignableFleetVehicle(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  fleetVehicleId: Id<'fleetVehicles'>,
  organizationId: Id<'organizations'>,
  providerId: Id<'providers'>,
): Promise<Doc<'fleetVehicles'>> {
  const fleetVehicle = await ctx.db.get(fleetVehicleId);
  if (
    fleetVehicle === null ||
    fleetVehicle.organizationId !== organizationId ||
    fleetVehicle.providerId !== providerId ||
    fleetVehicle.status === 'archived'
  ) return notFoundOrInaccessible();
  return fleetVehicle;
}

/** Authenticates before lookup so foreign and fabricated ids stay opaque (I9). */
export async function requireFleetVehicleAccess(
  ctx: QueryCtx | MutationCtx,
  fleetVehicleId: Id<'fleetVehicles'>,
  minimumRole?: Role,
): Promise<{ fleetVehicle: Doc<'fleetVehicles'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const fleetVehicle = await ctx.db.get(fleetVehicleId);
  if (fleetVehicle === null) return notFoundOrInaccessible();
  const access = minimumRole === undefined
    ? await requireOrganizationMembership(ctx, fleetVehicle.organizationId, authenticated)
    : await requireOrganizationRole(ctx, fleetVehicle.organizationId, minimumRole, authenticated);
  return { fleetVehicle, access };
}

/**
 * The indexed read-before-write behind `organizationId + plateKey`. `.first()`,
 * not `.unique()`: the constraint is enforced by THIS read, not by the index, so
 * if a future change to `normalizePlate` ever folds two existing rows onto one
 * key the next write must still fail as a stable `conflict` code rather than as
 * `unique()`'s untyped throw, which no error catalogue can present.
 */
async function assertPlateAvailable(
  ctx: MutationCtx,
  organizationId: Id<'organizations'>,
  plateKey: string,
): Promise<void> {
  const existing = await ctx.db
    .query('fleetVehicles')
    .withIndex('by_org_plateKey', (q) => q.eq('organizationId', organizationId).eq('plateKey', plateKey))
    .first();
  if (existing !== null) return conflict();
}

/**
 * Both spellings are indexed: the display plate (which `normalizeSearchText`
 * splits at punctuation, so `ABC-123` becomes the tokens `abc` and `123`) and
 * the normalised key (the single token `abc123`). Searching either way finds it.
 */
function fleetVehicleSearchText(plate: string, plateKey: string, label: string | undefined): string {
  return normalizeSearchText(plate, plateKey, label);
}

/** Trims, then bounds, and returns what the caller must store. */
function validatedPlate(plate: string): string {
  const trimmed = plate.trim();
  if (trimmed.length === 0 || trimmed.length > maxPlateLength || normalizePlate(trimmed) === '') {
    return invalidInput('fleetVehiclePlateInvalid', `A plate must be 1–${maxPlateLength} characters and contain at least one letter or digit`);
  }
  return trimmed;
}

/** Same trim-then-bound rule, at the display-name bound. */
function validatedLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const trimmed = label.trim();
  if (trimmed.length > maxEntityNameLength) {
    return invalidInput('fleetVehicleLabelInvalid', `A Fleet Vehicle label must not exceed ${maxEntityNameLength} characters`);
  }
  return trimmed;
}

function validateYear(year: number | undefined): void {
  if (year === undefined) return;
  if (!Number.isInteger(year) || year < minVehicleYear || year > maxVehicleYear) {
    return invalidInput('fleetVehicleYearInvalid', `A model year must be a whole number between ${minVehicleYear} and ${maxVehicleYear}`);
  }
}

/** Same trim-then-bound rule as `validatedLabel`, at the notes column's own bound. */
function validatedNotes(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined;
  const trimmed = notes.trim();
  if (trimmed.length > maxFleetVehicleNotesLength) {
    return invalidInput('fleetVehicleNotesTooLong', `Fleet Vehicle notes must not exceed ${maxFleetVehicleNotesLength} characters`);
  }
  return trimmed;
}
