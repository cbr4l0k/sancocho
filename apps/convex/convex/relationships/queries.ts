import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { serviceStatusValidator, paginatedResult, relationshipTypeValidator } from '../validators';
import { listIncomingRelationships as listIncomingRelationshipsModel, listOutgoingRelationships as listOutgoingRelationshipsModel } from './model';

const relationshipWithCounterpart = v.object({
  _id: v.id('serviceRelationships'),
  _creationTime: v.number(),
  organizationId: v.id('organizations'),
  sourceServiceId: v.id('services'),
  targetServiceId: v.id('services'),
  type: relationshipTypeValidator,
  counterpartService: v.object({ _id: v.id('services'), name: v.string(), status: serviceStatusValidator }),
});

/** See model.ts: separate directional pages preserve index-backed pagination. */
export const listOutgoingRelationships = query({
  args: { serviceId: v.id('services'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(relationshipWithCounterpart),
  handler: (ctx, args) => listOutgoingRelationshipsModel(ctx, args),
});

export const listIncomingRelationships = query({
  args: { serviceId: v.id('services'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(relationshipWithCounterpart),
  handler: (ctx, args) => listIncomingRelationshipsModel(ctx, args),
});
