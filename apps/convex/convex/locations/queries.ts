import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { locationDocValidator, paginatedResult } from '../validators';
import { getLocation as getLocationModel, listLocations as listLocationsModel } from './model';

export const getLocation = query({
  args: { locationId: v.id('locations') },
  returns: locationDocValidator,
  handler: (ctx, args) => getLocationModel(ctx, args.locationId),
});

export const listLocations = query({
  args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(locationDocValidator),
  handler: (ctx, args) => listLocationsModel(ctx, args.organizationId, args.paginationOpts),
});
