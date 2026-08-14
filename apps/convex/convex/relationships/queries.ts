import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { eventStatusValidator, paginatedResult, relationshipTypeValidator } from '../validators';
import { listIncomingRelationships as listIncomingRelationshipsModel, listOutgoingRelationships as listOutgoingRelationshipsModel } from './model';

const relationshipWithCounterpart = v.object({
  _id: v.id('eventRelationships'),
  _creationTime: v.number(),
  organizationId: v.id('organizations'),
  sourceEventId: v.id('events'),
  targetEventId: v.id('events'),
  type: relationshipTypeValidator,
  counterpartEvent: v.object({ _id: v.id('events'), name: v.string(), status: eventStatusValidator }),
});

/** See model.ts: separate directional pages preserve index-backed pagination. */
export const listOutgoingRelationships = query({
  args: { eventId: v.id('events'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(relationshipWithCounterpart),
  handler: (ctx, args) => listOutgoingRelationshipsModel(ctx, args),
});

export const listIncomingRelationships = query({
  args: { eventId: v.id('events'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(relationshipWithCounterpart),
  handler: (ctx, args) => listIncomingRelationshipsModel(ctx, args),
});
