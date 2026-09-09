import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/**
 * The reverse-reference reads over `fleetVehicles`, kept in their own module for
 * one structural reason: `providers/model.ts` needs the Provider-side read for
 * its delete guard, while `vehicles/fleet.ts` needs `assertUsableProvider` from
 * `providers/model.ts`. Splitting the two reads out here keeps that dependency a
 * straight line instead of a cycle — the same shape `providers/grants.ts`
 * already uses for the grant-side reads.
 *
 * Both are FIRST-HIT indexed reads (`.first()`, never `.collect()`): the guard
 * asks "does at least one referencing row exist?", so its cost must not grow
 * with how large a tenant's fleet is.
 *
 * Neither function authorizes anything. Both are reached only after the caller
 * has already proven ownership of the row being deleted, and each takes the
 * `organizationId` off that proven row rather than from caller input — which is
 * also what lets both share the existing composite indexes instead of adding two
 * more single-column ones (write amplification for no new query).
 */

/** True when at least one Fleet Vehicle still points at this Vehicle Class. */
export async function vehicleClassHasFleetVehicles(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  organizationId: Id<'organizations'>,
  vehicleClassId: Id<'vehicleClasses'>,
): Promise<boolean> {
  const reference = await ctx.db
    .query('fleetVehicles')
    .withIndex('by_org_class_status', (q) => q.eq('organizationId', organizationId).eq('vehicleClassId', vehicleClassId))
    .first();
  return reference !== null;
}

/**
 * True when at least one Fleet Vehicle still belongs to this Provider.
 *
 * Archived vehicles count. A Fleet Vehicle is the record of a plate the
 * coordinator dispatched, and deleting the Provider out from under an archived
 * one would leave a dangling id in an operational row — archival is the
 * coordinator's off switch, deletion is not.
 */
export async function providerHasFleetVehicles(
  ctx: Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>,
  organizationId: Id<'organizations'>,
  providerId: Id<'providers'>,
): Promise<boolean> {
  const reference = await ctx.db
    .query('fleetVehicles')
    .withIndex('by_org_provider_status', (q) => q.eq('organizationId', organizationId).eq('providerId', providerId))
    .first();
  return reference !== null;
}
