import { v } from 'convex/values';

import { query } from '../../_generated/server';
import { eventFieldValueValidator, fieldConfigValidator } from '../../validators';
import { listRecipeFields as listRecipeFieldsModel } from './model';

const recipeFieldDoc = v.object({ _id: v.id('recipeFields'), _creationTime: v.number(), organizationId: v.id('organizations'), recipeVersionId: v.id('recipeVersions'), fieldDefinitionId: v.id('fieldDefinitions'), position: v.number(), required: v.boolean(), visible: v.boolean(), defaultValue: v.optional(eventFieldValueValidator), config: fieldConfigValidator });

export const listRecipeFields = query({
  args: { recipeVersionId: v.id('recipeVersions') },
  returns: v.array(recipeFieldDoc),
  handler: (ctx, args) => listRecipeFieldsModel(ctx, args.recipeVersionId),
});
