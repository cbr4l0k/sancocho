import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { relationshipTypeValidator } from '../validators';
import { createRelationship as createRelationshipModel, removeRelationship as removeRelationshipModel } from './model';

export const createRelationship = mutation({
  args: {
    sourceServiceId: v.id('services'),
    targetServiceId: v.id('services'),
    type: relationshipTypeValidator,
  },
  returns: v.id('serviceRelationships'),
  handler: (ctx, args) => createRelationshipModel(ctx, args),
});

export const removeRelationship = mutation({
  args: { relationshipId: v.id('serviceRelationships') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await removeRelationshipModel(ctx, args.relationshipId);
    return null;
  },
});
