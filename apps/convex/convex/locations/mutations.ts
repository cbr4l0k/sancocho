import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { locationTypeValidator } from '../validators';
import {
  archiveLocation as archiveLocationModel,
  createLocation as createLocationModel,
  deleteLocation as deleteLocationModel,
  updateLocation as updateLocationModel,
} from './model';

export const createLocation = mutation({
  args: { organizationId: v.id('organizations'), name: v.string(), type: locationTypeValidator, address: v.optional(v.string()), latitude: v.optional(v.number()), longitude: v.optional(v.number()) },
  returns: v.id('locations'),
  handler: (ctx, args) => createLocationModel(ctx, args),
});

export const updateLocation = mutation({
  args: { locationId: v.id('locations'), name: v.optional(v.string()), type: v.optional(locationTypeValidator), address: v.optional(v.string()), latitude: v.optional(v.number()), longitude: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { locationId, ...patch }) => { await updateLocationModel(ctx, locationId, patch); return null; },
});

export const archiveLocation = mutation({
  args: { locationId: v.id('locations') },
  returns: v.null(),
  handler: async (ctx, args) => { await archiveLocationModel(ctx, args.locationId); return null; },
});

export const deleteLocation = mutation({
  args: { locationId: v.id('locations') },
  returns: v.null(),
  handler: async (ctx, args) => { await deleteLocationModel(ctx, args.locationId); return null; },
});
