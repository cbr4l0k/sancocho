import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { createVehicleClass } from './classes';

type StarterVehicleClass = {
  key: string;
  name: string;
  description: string;
  passengerCapacity?: number;
  cargoCapacityNote?: string;
};

/**
 * A small STARTER catalogue, not a code-owned enum: every row here is an
 * ordinary tenant-owned Vehicle Class that the organization may rename, edit,
 * archive or delete, exactly like one it authored itself. Nothing in the
 * codebase resolves a class by these keys.
 *
 * Its job is to make a new tenant usable on day one — the Cordillera workbook
 * alone uses nine classes, and an operator in another city will use different
 * ones — while staying on the right side of the Field-Definition argument: the
 * vocabulary is the tenant's, we merely seed a plausible starting point.
 *
 * Passenger capacities are the common configurations these words name in the
 * Colombian ground-transport market. Cargo capacity is a free-form note because
 * that is how operators state it; there is deliberately no volume or mass column
 * to convert between (I8).
 */
export const starterVehicleClasses = [
  { key: 'sedan', name: 'Sedan', description: 'Standard four-door car for individual and pair transfers.', passengerCapacity: 4 },
  { key: 'suv', name: 'SUV', description: 'Sport utility vehicle for transfers needing extra luggage room.', passengerCapacity: 6 },
  { key: 'van', name: 'Van', description: 'Passenger van for small groups.', passengerCapacity: 12 },
  { key: 'minibus', name: 'Minibus', description: 'Mid-size bus for group transfers and shuttles.', passengerCapacity: 20 },
  { key: 'coach', name: 'Coach', description: 'Full-size coach for large group movements.', passengerCapacity: 45 },
  { key: 'cargoVan', name: 'Cargo Van', description: 'Enclosed van for equipment and freight.', cargoCapacityNote: 'Enclosed load bay; palletised freight' },
  { key: 'cargoTruck', name: 'Cargo Truck', description: 'Truck for staging, production and heavy freight.', cargoCapacityNote: 'Truck bed; heavy or oversized freight' },
] as const satisfies readonly StarterVehicleClass[];

/**
 * Creates each starter Vehicle Class only when its key is absent, mirroring
 * `provisionStarterServiceKinds`.
 *
 * IDEMPOTENCE IS THE INDEXED KEY LOOKUP, not a "have we run before?" flag: the
 * skip is decided per key, so a tenant that deleted `coach` and kept the rest
 * gets `coach` back on a re-run and no duplicates of anything else. It runs
 * inside the caller's transaction, so an organization can never commit without
 * its starter catalogue.
 *
 * Writes go through the ordinary `createVehicleClass`, so provisioning proves a
 * real member's configuration role and records ordinary audit rows rather than
 * receiving a bootstrap exception — the same rule starter Service Kinds follow.
 */
export async function provisionStarterVehicleClasses(
  ctx: MutationCtx,
  organizationId: Id<'organizations'>,
): Promise<void> {
  for (const starter of starterVehicleClasses) {
    const existing = await ctx.db
      .query('vehicleClasses')
      .withIndex('by_org_key', (q) => q.eq('organizationId', organizationId).eq('key', starter.key))
      .unique();
    if (existing !== null) continue;
    await createVehicleClass(ctx, {
      organizationId,
      key: starter.key,
      name: starter.name,
      description: starter.description,
      ...('passengerCapacity' in starter ? { passengerCapacity: starter.passengerCapacity } : {}),
      ...('cargoCapacityNote' in starter ? { cargoCapacityNote: starter.cargoCapacityNote } : {}),
    });
  }
}
