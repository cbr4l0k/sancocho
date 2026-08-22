import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { eventFieldValueValidator, fieldConfigValidator, paginatedResult, recipeDocValidator, recipeVersionStatusValidator } from '../validators';
import { getRecipe as getRecipeModel, getRecipeVersion as getRecipeVersionModel, listPublishedRecipes as listPublishedRecipesModel, listRecipes as listRecipesModel } from './model';

const recipeDoc = recipeDocValidator;
const versionDoc = v.object({ _id: v.id('recipeVersions'), _creationTime: v.number(), organizationId: v.id('organizations'), recipeId: v.id('eventRecipes'), versionNumber: v.number(), status: recipeVersionStatusValidator, publishedAt: v.optional(v.number()) });
const recipeFieldDoc = v.object({ _id: v.id('recipeFields'), _creationTime: v.number(), organizationId: v.id('organizations'), recipeVersionId: v.id('recipeVersions'), fieldDefinitionId: v.id('fieldDefinitions'), position: v.number(), required: v.boolean(), visible: v.boolean(), defaultValue: v.optional(eventFieldValueValidator), defaultLocationId: v.optional(v.id('locations')), config: fieldConfigValidator });
const paginatedRecipes = paginatedResult(recipeDoc);
const publishedRecipePickerRow = v.object({
  recipe: recipeDoc,
  publishedVersion: v.object({ _id: v.id('recipeVersions'), versionNumber: v.number(), publishedAt: v.optional(v.number()) }),
});
const paginatedPublishedRecipes = paginatedResult(publishedRecipePickerRow);

export const getRecipe = query({ args: { recipeId: v.id('eventRecipes') }, returns: v.object({ recipe: recipeDoc, versions: v.array(versionDoc) }), handler: (ctx, args) => getRecipeModel(ctx, args.recipeId) });
export const listRecipes = query({ args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator }, returns: paginatedRecipes, handler: (ctx, args) => listRecipesModel(ctx, args.organizationId, args.paginationOpts) });
export const listPublishedRecipes = query({ args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator }, returns: paginatedPublishedRecipes, handler: (ctx, args) => listPublishedRecipesModel(ctx, args.organizationId, args.paginationOpts) });
export const getRecipeVersion = query({ args: { recipeVersionId: v.id('recipeVersions') }, returns: v.object({ version: versionDoc, recipeFields: v.array(recipeFieldDoc) }), handler: (ctx, args) => getRecipeVersionModel(ctx, args.recipeVersionId) });
