import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { relationshipTypeValidator } from '../validators';
import { createRelationship as createRelationshipModel, removeRelationship as removeRelationshipModel } from './model';

export const createRelationship = mutation({
  args: {
    sourceEventId: v.id('events'),
    targetEventId: v.id('events'),
    type: relationshipTypeValidator,
  },
  returns: v.id('eventRelationships'),
  handler: (ctx, args) => createRelationshipModel(ctx, args),
});

export const removeRelationship = mutation({
  args: { relationshipId: v.id('eventRelationships') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await removeRelationshipModel(ctx, args.relationshipId);
    return null;
  },
});
