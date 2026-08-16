import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import {
  requireAuthenticatedUser,
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { validateEntityName } from '../lib/names';
import { organizationConfigurationRole, type Role } from '../lib/roles';
import { isFiniteNumber, type locationTypeValidator } from '../validators';

type LocationType = typeof locationTypeValidator.type;
type LocationCoordinates = { latitude?: number; longitude?: number };
type LocationPatch = LocationCoordinates & { name?: string; type?: LocationType; address?: string };

/**
 * Location field values reference the live Location entity. Later Location edits
 * are therefore visible from historical Events. Audit-grade location snapshots
 * would require a future revision system and are deliberately not built here.
 *
 * Accepted consequence of that same choice: archiving a location degrades every
 * already-published (immutable) recipe version that defaults to it, because a
 * default pointing at an archived location fails `validateRecipeFieldDefaultValue`
 * — and there is no unarchive. Deletion is guarded (see `deleteLocation`) so the
 * reference can never dangle; archival is allowed to make it unusable.
 *
 * Whether an archived location should keep working for *pre-existing* published
 * defaults while being refused for *new* selections is a revision-system
 * question (per-version location snapshots, or a "referenced by a published
 * version" archival guard). It is deliberately left to that future revision,
 * not decided here: either answer would be guesswork before Events exist (#10).
 */

/**
 * Addresses are free-form postal text copied into no snapshot, but they are read
 * on every location document, so they stay bounded like field descriptions
 * (`maxFieldDescriptionLength`). 500 characters holds any real postal address
 * plus delivery notes — well past the longest international format — while
 * keeping the document cheap to read.
 */
const maxAddressLength = 500;

export async function createLocation(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; name: string; type: LocationType; address?: string } & LocationCoordinates,
): Promise<Id<'locations'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, organizationConfigurationRole);
  // The validator returns the trimmed name, and the trimmed name is what is stored.
  const name = validateEntityName(args.name, 'location');
  validateAddress(args.address);
  validateCoordinates(args);
  const locationId = await ctx.db.insert('locations', {
    organizationId: args.organizationId,
    name,
    type: args.type,
    ...(args.address === undefined ? {} : { address: args.address }),
    ...(args.latitude === undefined ? {} : { latitude: args.latitude }),
    ...(args.longitude === undefined ? {} : { longitude: args.longitude }),
    status: 'active',
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'location.created',
    entityType: 'location',
    entityId: locationId,
    metadata: { name, type: args.type },
  });
  return locationId;
}

export async function getLocation(ctx: QueryCtx, locationId: Id<'locations'>): Promise<Doc<'locations'>> {
  const { location } = await requireLocationAccess(ctx, locationId);
  return location;
}

export async function listLocations(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<Doc<'locations'>>> {
  await requireOrganizationMembership(ctx, organizationId);
  // Paginated because a tenant's planning-location catalogue is unbounded (I6).
  return ctx.db.query('locations').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).paginate(paginationOpts);
}

export async function updateLocation(ctx: MutationCtx, locationId: Id<'locations'>, patch: LocationPatch): Promise<void> {
  const { location, access } = await requireLocationAccess(ctx, locationId, organizationConfigurationRole);
  if (location.status === 'archived') return invalidInput('locationArchived', 'Archived locations cannot be updated');
  // Validated (and therefore trimmed) before the diff, so what is compared
  // against the stored name is exactly what would be stored.
  const name = patch.name === undefined ? undefined : validateEntityName(patch.name, 'location');
  validateAddress(patch.address);

  // Coordinates cannot be cleared by this API: clients either omit both values
  // or provide ordinary numeric replacements. Validate the final stored pair.
  const latitude = patch.latitude === undefined ? location.latitude : patch.latitude;
  const longitude = patch.longitude === undefined ? location.longitude : patch.longitude;
  validateCoordinates({ ...(latitude === undefined ? {} : { latitude }), ...(longitude === undefined ? {} : { longitude }) });

  const update: LocationPatch = {};
  const changedFields: string[] = [];
  if (name !== undefined && name !== location.name) {
    update.name = name;
    changedFields.push('name');
  }
  if (patch.type !== undefined && patch.type !== location.type) {
    update.type = patch.type;
    changedFields.push('type');
  }
  if (patch.address !== undefined && patch.address !== location.address) {
    update.address = patch.address;
    changedFields.push('address');
  }
  if (patch.latitude !== undefined && patch.latitude !== location.latitude) {
    update.latitude = patch.latitude;
    changedFields.push('latitude');
  }
  if (patch.longitude !== undefined && patch.longitude !== location.longitude) {
    update.longitude = patch.longitude;
    changedFields.push('longitude');
  }
  if (changedFields.length === 0) return;

  await ctx.db.patch(locationId, update);
  await recordAuditEvent(ctx, {
    organizationId: location.organizationId,
    actorUserId: access.user._id,
    action: 'location.updated',
    entityType: 'location',
    entityId: locationId,
    metadata: { changedFields: changedFields.join(',') },
  });
}

export async function archiveLocation(ctx: MutationCtx, locationId: Id<'locations'>): Promise<void> {
  const { location, access } = await requireLocationAccess(ctx, locationId, organizationConfigurationRole);
  if (location.status === 'archived') return;
  // Event writes reject archived locations through the shared location-default check (#10).
  await ctx.db.patch(locationId, { status: 'archived' });
  await recordAuditEvent(ctx, {
    organizationId: location.organizationId,
    actorUserId: access.user._id,
    action: 'location.archived',
    entityType: 'location',
    entityId: locationId,
    metadata: { previousStatus: location.status },
  });
}

export async function deleteLocation(ctx: MutationCtx, locationId: Id<'locations'>): Promise<void> {
  const { location, access } = await requireLocationAccess(ctx, locationId, organizationConfigurationRole);
  if (location.status !== 'archived') return invalidInput('locationArchiveRequired', 'Locations must be archived before deletion');
  // Both tables that can reference a location are checked first-hit through
  // their indexes, mirroring `deleteFieldDefinition`. `eventFieldValues` covers
  // operational data; `recipeFields.defaultLocationId` covers configuration
  // defaults, and it is the structural half of the guarantee: a published
  // recipe version is immutable (I2), so a default it carries can never be
  // repaired. Deleting the location out from under one would leave a dangling
  // reference that fails every later event creation and clone-then-publish,
  // permanently disabling that version (I3). Archival, not deletion, is the
  // lifecycle path for a location that is still referenced anywhere.
  const eventReference = await ctx.db.query('eventFieldValues').withIndex('by_location', (q) => q.eq('locationId', locationId)).first();
  if (eventReference !== null) return invalidInput('locationDeleteBlocked', 'Referenced locations cannot be deleted; retain the archived location instead');
  const defaultReference = await ctx.db.query('recipeFields').withIndex('by_defaultLocation', (q) => q.eq('defaultLocationId', locationId)).first();
  if (defaultReference !== null) return invalidInput('locationDeleteBlocked', 'Referenced locations cannot be deleted; retain the archived location instead');
  await recordAuditEvent(ctx, {
    organizationId: location.organizationId,
    actorUserId: access.user._id,
    action: 'location.deleted',
    entityType: 'location',
    entityId: locationId,
    // Recorded before the delete, matching `deleteFieldDefinition`: the row is
    // gone afterwards, so the audit trail is the only remaining description of
    // what was removed. Both writes are in the same transaction either way.
    metadata: { name: location.name, type: location.type },
  });
  await ctx.db.delete(locationId);
}

/**
 * The single statement of "may this organization store a reference to this
 * location?": it must exist, belong to that organization, and still be active.
 *
 * Both writers of a location reference use it — `recipeFields.defaultValue`
 * (configuration defaults, at publish and composition) and
 * `eventFieldValues.value` (operational data, through the event validation
 * gate) — so a default and a stored value can never be held to different
 * reference rules. The pure `validateFieldValueAgainstConfig` deliberately
 * stops at the discriminator; this is the half that needs a database read.
 *
 * Failure is always the generic error, never a specific one: the location id
 * arrives from the caller, so a foreign, archived, or fabricated id must be
 * indistinguishable or publishing and event creation become tenant probes
 * (I1/I9).
 *
 * It lives here rather than beside the pure value helpers because it is a
 * statement about the location lifecycle, and because the import direction only
 * works this way: `recipes/` and `events/` already depend on `locations/`, and
 * nothing under `locations/` depends on either.
 */
export async function assertUsableLocation(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  locationId: Id<'locations'>,
  organizationId: Id<'organizations'>,
): Promise<void> {
  const location = await ctx.db.get(locationId);
  if (location === null || location.organizationId !== organizationId || location.status === 'archived') {
    return notFoundOrInaccessible();
  }
}

/** Authenticates before lookup so foreign and fabricated ids stay indistinguishable (I9). */
export async function requireLocationAccess(
  ctx: QueryCtx | MutationCtx,
  locationId: Id<'locations'>,
  minimumRole?: Role,
): Promise<{ location: Doc<'locations'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const location = await ctx.db.get(locationId);
  if (location === null) return notFoundOrInaccessible();
  const access = minimumRole === undefined
    ? await requireOrganizationMembership(ctx, location.organizationId, authenticated)
    : await requireOrganizationRole(ctx, location.organizationId, minimumRole, authenticated);
  return { location, access };
}

function validateAddress(address: string | undefined): void {
  if (address !== undefined && address.length > maxAddressLength) {
    return invalidInput('locationAddressTooLong', `Location address must not exceed ${maxAddressLength} characters`);
  }
}

function validateCoordinates({ latitude, longitude }: LocationCoordinates): void {
  if ((latitude === undefined) !== (longitude === undefined)) return invalidInput('locationCoordinatesIncomplete', 'Latitude and longitude must be provided together');
  if (latitude !== undefined && !isFiniteNumber(latitude)) return invalidInput('locationCoordinatesInvalid', 'Latitude must be finite');
  if (longitude !== undefined && !isFiniteNumber(longitude)) return invalidInput('locationCoordinatesInvalid', 'Longitude must be finite');
  if (latitude !== undefined && (latitude < -90 || latitude > 90)) return invalidInput('locationCoordinatesInvalid', 'Latitude must be between -90 and 90');
  if (longitude !== undefined && (longitude < -180 || longitude > 180)) return invalidInput('locationCoordinatesInvalid', 'Longitude must be between -180 and 180');
}
