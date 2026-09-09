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
import { validateEntityName } from '../lib/names';
import { organizationConfigurationRole, type Role } from '../lib/roles';
import { assertSearchTermLength, normalizeSearchTerm, normalizeSearchText } from '../lib/search';
import type { archivalStatusValidator } from '../validators';
import { vehicleClassHasAssignmentRevisions, vehicleClassHasFleetVehicles } from './references';
import { vehicleClassHasRateLines } from '../rateCards/references';

type ArchivalStatus = typeof archivalStatusValidator.type;
type VehicleClassPatch = {
  name?: string;
  description?: string;
  passengerCapacity?: number;
  cargoCapacityNote?: string;
};
type VehicleClassListFilters = { status?: ArchivalStatus; search?: string };

/** The same key rule Cost Centres and Field Definitions use; stated once per domain. */
const vehicleClassKeyPattern = /^[a-z][a-zA-Z0-9]*$/;
const maxVehicleClassDescriptionLength = 2000;
/** A cargo capacity is a short human phrase ("1.5 t / 12 m³"), not a paragraph. */
const maxCargoCapacityNoteLength = 200;
/**
 * A passenger capacity is a whole number of seats. The upper bound is not a
 * product rule about buses; it is the ordinary "this is a count, not a typo or
 * an overflow" guard every numeric input in the codebase carries (I5).
 */
const maxPassengerCapacity = 1000;

export async function createVehicleClass(
  ctx: MutationCtx,
  args: {
    organizationId: Id<'organizations'>;
    key: string;
    name: string;
    description?: string;
    passengerCapacity?: number;
    cargoCapacityNote?: string;
  },
): Promise<Id<'vehicleClasses'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, organizationConfigurationRole);
  validateVehicleClassKey(args.key);
  // The validator returns the trimmed name, and the trimmed name is what is stored.
  const name = validateEntityName(args.name, 'vehicle class');
  validateDescription(args.description);
  validatePassengerCapacity(args.passengerCapacity);
  const cargoCapacityNote = validatedCargoCapacityNote(args.cargoCapacityNote);
  // Same-transaction indexed read-before-write: Convex OCC makes concurrent
  // creators retry against the winning row instead of admitting duplicates.
  const existing = await ctx.db
    .query('vehicleClasses')
    .withIndex('by_org_key', (q) => q.eq('organizationId', args.organizationId).eq('key', args.key))
    .unique();
  if (existing !== null) return conflict();
  const vehicleClassId = await ctx.db.insert('vehicleClasses', {
    organizationId: args.organizationId,
    key: args.key,
    name,
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.passengerCapacity === undefined ? {} : { passengerCapacity: args.passengerCapacity }),
    ...(cargoCapacityNote === undefined ? {} : { cargoCapacityNote }),
    // Key AND name, because operators look a class up by either (I4: derived here,
    // never accepted from the client).
    searchText: normalizeSearchText(args.key, name),
    status: 'active',
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'vehicleClass.created',
    entityType: 'vehicleClass',
    entityId: vehicleClassId,
    metadata: { key: args.key, name },
  });
  return vehicleClassId;
}

export async function getVehicleClass(ctx: QueryCtx, vehicleClassId: Id<'vehicleClasses'>): Promise<Doc<'vehicleClasses'>> {
  const { vehicleClass } = await requireVehicleClassAccess(ctx, vehicleClassId);
  return vehicleClass;
}

export async function listVehicleClasses(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
  filters: VehicleClassListFilters,
): Promise<PaginationResult<Doc<'vehicleClasses'>>> {
  // The MEMBER arm only. A Provider Principal must never enumerate a
  // coordinator's catalogue (docs/provider-access.md "What a Provider MAY NOT
  // see" §4), and the way that refusal is guaranteed is that this gate resolves
  // memberships and nothing else — a granted firm's user is not a member of the
  // coordinator's organization, so it leaves through the generic error (I9).
  await requireOrganizationMembership(ctx, organizationId);
  assertSearchTermLength(filters.search);
  const term = normalizeSearchTerm(filters.search ?? '');
  // Every branch narrows through a declared index BEFORE `.paginate`, never by
  // filtering an already-fetched page: a post-page filter would silently return
  // short pages and turn `numItems` into a lie.
  if (term !== '') {
    const status = filters.status;
    return ctx.db.query('vehicleClasses').withSearchIndex('search_text', (q) => {
      let search = q.search('searchText', term).eq('organizationId', organizationId);
      if (status !== undefined) search = search.eq('status', status);
      return search;
    }).paginate(paginationOpts);
  }
  if (filters.status !== undefined) {
    const status = filters.status;
    return ctx.db
      .query('vehicleClasses')
      .withIndex('by_org_status', (q) => q.eq('organizationId', organizationId).eq('status', status))
      .paginate(paginationOpts);
  }
  // Paginated because a tenant's class catalogue is unbounded (I6).
  return ctx.db
    .query('vehicleClasses')
    .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
    .paginate(paginationOpts);
}

export async function updateVehicleClass(
  ctx: MutationCtx,
  vehicleClassId: Id<'vehicleClasses'>,
  patch: VehicleClassPatch,
): Promise<void> {
  const { vehicleClass, access } = await requireVehicleClassAccess(ctx, vehicleClassId, organizationConfigurationRole);
  if (vehicleClass.status === 'archived') {
    return invalidInput('vehicleClassArchived', 'Archived Vehicle Classes cannot be updated');
  }
  // The `key` is deliberately absent from the patch type and from the mutation's
  // args: it is the stable identifier the starter catalogue skips on and a
  // future import addresses by, so renaming it would silently orphan both.
  const name = patch.name === undefined ? undefined : validateEntityName(patch.name, 'vehicle class');
  validateDescription(patch.description);
  validatePassengerCapacity(patch.passengerCapacity);
  const cargoCapacityNote = validatedCargoCapacityNote(patch.cargoCapacityNote);

  const update: VehicleClassPatch & { searchText?: string } = {};
  const changedFields: string[] = [];
  if (name !== undefined && name !== vehicleClass.name) {
    update.name = name;
    // Re-derived from the STORED key and the new name, so search follows a rename.
    update.searchText = normalizeSearchText(vehicleClass.key, name);
    changedFields.push('name');
  }
  if (patch.description !== undefined && patch.description !== vehicleClass.description) {
    update.description = patch.description;
    changedFields.push('description');
  }
  if (patch.passengerCapacity !== undefined && patch.passengerCapacity !== vehicleClass.passengerCapacity) {
    update.passengerCapacity = patch.passengerCapacity;
    changedFields.push('passengerCapacity');
  }
  if (cargoCapacityNote !== undefined && cargoCapacityNote !== vehicleClass.cargoCapacityNote) {
    update.cargoCapacityNote = cargoCapacityNote;
    changedFields.push('cargoCapacityNote');
  }
  if (changedFields.length === 0) return;
  await ctx.db.patch(vehicleClassId, update);
  await recordAuditEvent(ctx, {
    organizationId: vehicleClass.organizationId,
    actorUserId: access.user._id,
    action: 'vehicleClass.updated',
    entityType: 'vehicleClass',
    entityId: vehicleClassId,
    metadata: { changedFields: changedFields.join(',') },
  });
}

export async function archiveVehicleClass(ctx: MutationCtx, vehicleClassId: Id<'vehicleClasses'>): Promise<void> {
  const { vehicleClass, access } = await requireVehicleClassAccess(ctx, vehicleClassId, organizationConfigurationRole);
  if (vehicleClass.status === 'archived') return;
  await ctx.db.patch(vehicleClassId, { status: 'archived' });
  await recordAuditEvent(ctx, {
    organizationId: vehicleClass.organizationId,
    actorUserId: access.user._id,
    action: 'vehicleClass.archived',
    entityType: 'vehicleClass',
    entityId: vehicleClassId,
    metadata: { previousStatus: vehicleClass.status },
  });
}

export async function deleteVehicleClass(ctx: MutationCtx, vehicleClassId: Id<'vehicleClasses'>): Promise<void> {
  const { vehicleClass, access } = await requireVehicleClassAccess(ctx, vehicleClassId, organizationConfigurationRole);
  if (vehicleClass.status !== 'archived') {
    return invalidInput('vehicleClassArchiveRequired', 'Vehicle Classes must be archived before deletion');
  }
  // Reference guard, mirroring `deleteLocation` and `deleteCostCentre`: each
  // referencing table is checked first-hit through an index before the delete,
  // and the refusal is always the same code so the caller learns "still
  // referenced", never which table holds the reference.
  //
  // Fleet Vehicles, Rate Lines and immutable Assignment Revisions are the
  // referencers. Every Revision status counts because history is retained.
  if (
    (await vehicleClassHasFleetVehicles(ctx, vehicleClass.organizationId, vehicleClassId)) ||
    (await vehicleClassHasRateLines(ctx, vehicleClass.organizationId, vehicleClassId)) ||
    (await vehicleClassHasAssignmentRevisions(ctx, vehicleClass.organizationId, vehicleClassId))
  ) {
    return invalidInput('vehicleClassDeleteBlocked', 'Referenced Vehicle Classes cannot be deleted; retain the archived class instead');
  }
  // Recorded BEFORE the delete so the row's key and name are still readable,
  // matching `deleteLocation`, `deleteCostCentre` and `deleteProvider`.
  await recordAuditEvent(ctx, {
    organizationId: vehicleClass.organizationId,
    actorUserId: access.user._id,
    action: 'vehicleClass.deleted',
    entityType: 'vehicleClass',
    entityId: vehicleClassId,
    metadata: { key: vehicleClass.key, name: vehicleClass.name },
  });
  await ctx.db.delete(vehicleClassId);
}

/**
 * The single statement of "may this organization store a reference to this
 * Vehicle Class?", mirroring `assertUsableCostCentre` and `assertUsableLocation`:
 * it must exist, belong to that organization, and still be active.
 *
 * Failure is always the generic error. The id arrives from the caller, so a
 * foreign, archived, or fabricated class must be indistinguishable, or every
 * writer of a class reference becomes a tenant probe (I1/I9) — a caller must
 * never learn that some other tenant's class exists but is archived.
 */
export async function assertUsableVehicleClass(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  vehicleClassId: Id<'vehicleClasses'>,
  organizationId: Id<'organizations'>,
): Promise<Doc<'vehicleClasses'>> {
  const vehicleClass = await ctx.db.get(vehicleClassId);
  if (vehicleClass === null || vehicleClass.organizationId !== organizationId || vehicleClass.status === 'archived') {
    return notFoundOrInaccessible();
  }
  return vehicleClass;
}

/** Authenticates before lookup so foreign and fabricated ids stay opaque (I9). */
export async function requireVehicleClassAccess(
  ctx: QueryCtx | MutationCtx,
  vehicleClassId: Id<'vehicleClasses'>,
  minimumRole?: Role,
): Promise<{ vehicleClass: Doc<'vehicleClasses'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const vehicleClass = await ctx.db.get(vehicleClassId);
  if (vehicleClass === null) return notFoundOrInaccessible();
  const access = minimumRole === undefined
    ? await requireOrganizationMembership(ctx, vehicleClass.organizationId, authenticated)
    : await requireOrganizationRole(ctx, vehicleClass.organizationId, minimumRole, authenticated);
  return { vehicleClass, access };
}

function validateVehicleClassKey(key: string): void {
  if (!vehicleClassKeyPattern.test(key) || key.length < 2 || key.length > 64) {
    return invalidInput('vehicleClassKeyInvalid', 'Vehicle Class key must be 2–64 lowerCamelCase characters');
  }
}

function validateDescription(description: string | undefined): void {
  if (description !== undefined && description.length > maxVehicleClassDescriptionLength) {
    return invalidInput('vehicleClassDescriptionTooLong', `Vehicle Class description must not exceed ${maxVehicleClassDescriptionLength} characters`);
  }
}

function validatePassengerCapacity(passengerCapacity: number | undefined): void {
  if (passengerCapacity === undefined) return;
  if (!Number.isInteger(passengerCapacity) || passengerCapacity < 0 || passengerCapacity > maxPassengerCapacity) {
    return invalidInput('vehicleClassCapacityInvalid', `Passenger capacity must be a whole number between 0 and ${maxPassengerCapacity}`);
  }
}

/** Trims, then bounds, and returns what the caller must store — the `validateEntityName` rule. */
function validatedCargoCapacityNote(cargoCapacityNote: string | undefined): string | undefined {
  if (cargoCapacityNote === undefined) return undefined;
  const trimmed = cargoCapacityNote.trim();
  if (trimmed.length > maxCargoCapacityNoteLength) {
    return invalidInput('vehicleClassCargoNoteTooLong', `Cargo capacity note must not exceed ${maxCargoCapacityNoteLength} characters`);
  }
  return trimmed;
}
