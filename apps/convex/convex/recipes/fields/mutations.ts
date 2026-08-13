import { v } from 'convex/values';

import { mutation } from '../../_generated/server';
import { eventFieldValueValidator, fieldConfigValidator } from '../../validators';
import { addRecipeField as addRecipeFieldModel, removeRecipeField as removeRecipeFieldModel, reorderRecipeFields as reorderRecipeFieldsModel, updateRecipeField as updateRecipeFieldModel } from './model';

export const addRecipeField = mutation({
  args: { recipeVersionId: v.id('recipeVersions'), fieldDefinitionId: v.id('fieldDefinitions'), required: v.boolean(), visible: v.boolean(), position: v.optional(v.number()), config: v.optional(fieldConfigValidator), defaultValue: v.optional(eventFieldValueValidator) },
  returns: v.id('recipeFields'),
  handler: (ctx, args) => addRecipeFieldModel(ctx, args),
});

/** Pass `defaultValue: null` to explicitly clear a recipe field's default. */
export const updateRecipeField = mutation({
  args: { recipeFieldId: v.id('recipeFields'), required: v.optional(v.boolean()), visible: v.optional(v.boolean()), config: v.optional(fieldConfigValidator), defaultValue: v.optional(v.union(eventFieldValueValidator, v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => { await updateRecipeFieldModel(ctx, args); return null; },
});

export const reorderRecipeFields = mutation({
  args: { recipeVersionId: v.id('recipeVersions'), orderedRecipeFieldIds: v.array(v.id('recipeFields')) },
  returns: v.null(),
  handler: async (ctx, args) => { await reorderRecipeFieldsModel(ctx, args.recipeVersionId, args.orderedRecipeFieldIds); return null; },
});

export const removeRecipeField = mutation({
  args: { recipeFieldId: v.id('recipeFields') },
  returns: v.null(),
  handler: async (ctx, args) => { await removeRecipeFieldModel(ctx, args.recipeFieldId); return null; },
});
