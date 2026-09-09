import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { archivalStatusValidator, fleetVehicleDocValidator, paginatedResult, vehicleClassDocValidator } from '../validators';
import { getVehicleClass as getVehicleClassModel, listVehicleClasses as listVehicleClassesModel } from './classes';
import { getFleetVehicle as getFleetVehicleModel, listFleetVehicles as listFleetVehiclesModel } from './fleet';

export const getVehicleClass = query({
  args: { vehicleClassId: v.id('vehicleClasses') },
  returns: vehicleClassDocValidator,
  handler: (ctx, args) => getVehicleClassModel(ctx, args.vehicleClassId),
});

export const listVehicleClasses = query({
  args: {
    organizationId: v.id('organizations'),
    paginationOpts: paginationOptsValidator,
    status: v.optional(archivalStatusValidator),
    search: v.optional(v.string()),
  },
  returns: paginatedResult(vehicleClassDocValidator),
  handler: (ctx, args) => listVehicleClassesModel(ctx, args.organizationId, args.paginationOpts, {
    ...(args.status === undefined ? {} : { status: args.status }),
    ...(args.search === undefined ? {} : { search: args.search }),
  }),
});

export const getFleetVehicle = query({
  args: { fleetVehicleId: v.id('fleetVehicles') },
  returns: fleetVehicleDocValidator,
  handler: (ctx, args) => getFleetVehicleModel(ctx, args.fleetVehicleId),
});

/**
 * The Provider and Class filters are declared here and served by an index in the
 * model, never by filtering a fetched page (I6). They are deliberately NOT
 * validated as belonging to the caller's organization before the read: a foreign
 * id simply selects an empty index range behind a membership gate that has
 * already refused the caller, so answering "no vehicles" costs nothing and
 * discloses nothing (I9).
 */
export const listFleetVehicles = query({
  args: {
    organizationId: v.id('organizations'),
    paginationOpts: paginationOptsValidator,
    providerId: v.optional(v.id('providers')),
    vehicleClassId: v.optional(v.id('vehicleClasses')),
    status: v.optional(archivalStatusValidator),
    search: v.optional(v.string()),
  },
  returns: paginatedResult(fleetVehicleDocValidator),
  handler: (ctx, args) => listFleetVehiclesModel(ctx, args.organizationId, args.paginationOpts, {
    ...(args.providerId === undefined ? {} : { providerId: args.providerId }),
    ...(args.vehicleClassId === undefined ? {} : { vehicleClassId: args.vehicleClassId }),
    ...(args.status === undefined ? {} : { status: args.status }),
    ...(args.search === undefined ? {} : { search: args.search }),
  }),
});
