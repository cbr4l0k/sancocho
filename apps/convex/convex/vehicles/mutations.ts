import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import {
  archiveVehicleClass as archiveVehicleClassModel,
  createVehicleClass as createVehicleClassModel,
  deleteVehicleClass as deleteVehicleClassModel,
  updateVehicleClass as updateVehicleClassModel,
} from './classes';
import {
  archiveFleetVehicle as archiveFleetVehicleModel,
  createFleetVehicle as createFleetVehicleModel,
  deleteFleetVehicle as deleteFleetVehicleModel,
  updateFleetVehicle as updateFleetVehicleModel,
} from './fleet';

export const createVehicleClass = mutation({
  args: {
    organizationId: v.id('organizations'),
    key: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    passengerCapacity: v.optional(v.number()),
    cargoCapacityNote: v.optional(v.string()),
  },
  returns: v.id('vehicleClasses'),
  handler: (ctx, args) => createVehicleClassModel(ctx, args),
});

/**
 * `key` is deliberately absent from these args and cannot be added: it is the
 * stable identifier the starter catalogue skips on, so a rename would silently
 * re-provision a class the tenant already has. The display `name` is what a
 * coordinator edits.
 */
export const updateVehicleClass = mutation({
  args: {
    vehicleClassId: v.id('vehicleClasses'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    passengerCapacity: v.optional(v.number()),
    cargoCapacityNote: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { vehicleClassId, ...patch }) => {
    await updateVehicleClassModel(ctx, vehicleClassId, patch);
    return null;
  },
});

export const archiveVehicleClass = mutation({
  args: { vehicleClassId: v.id('vehicleClasses') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await archiveVehicleClassModel(ctx, args.vehicleClassId);
    return null;
  },
});

export const deleteVehicleClass = mutation({
  args: { vehicleClassId: v.id('vehicleClasses') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteVehicleClassModel(ctx, args.vehicleClassId);
    return null;
  },
});

/**
 * `organizationId` is the tenant the caller proves a configuration role in;
 * `providerId` and `vehicleClassId` are then proven to belong to THAT
 * organization server-side (I1/I4). There is deliberately no `status` argument
 * anywhere in this file — archival is its own audited transition.
 */
export const createFleetVehicle = mutation({
  args: {
    organizationId: v.id('organizations'),
    providerId: v.id('providers'),
    vehicleClassId: v.id('vehicleClasses'),
    plate: v.string(),
    label: v.optional(v.string()),
    year: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  returns: v.id('fleetVehicles'),
  handler: (ctx, args) => createFleetVehicleModel(ctx, args),
});

export const updateFleetVehicle = mutation({
  args: {
    fleetVehicleId: v.id('fleetVehicles'),
    providerId: v.optional(v.id('providers')),
    vehicleClassId: v.optional(v.id('vehicleClasses')),
    plate: v.optional(v.string()),
    label: v.optional(v.string()),
    year: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { fleetVehicleId, ...patch }) => {
    await updateFleetVehicleModel(ctx, fleetVehicleId, patch);
    return null;
  },
});

export const archiveFleetVehicle = mutation({
  args: { fleetVehicleId: v.id('fleetVehicles') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await archiveFleetVehicleModel(ctx, args.fleetVehicleId);
    return null;
  },
});

export const deleteFleetVehicle = mutation({
  args: { fleetVehicleId: v.id('fleetVehicles') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteFleetVehicleModel(ctx, args.fleetVehicleId);
    return null;
  },
});
