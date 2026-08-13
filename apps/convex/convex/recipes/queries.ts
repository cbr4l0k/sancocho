import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { eventFieldValueValidator, fieldConfigValidator, recipeStatusValidator, recipeVersionStatusValidator } from '../validators';
import { getRecipe as getRecipeModel, getRecipeVersion as getRecipeVersionModel, listRecipes as listRecipesModel } from './model';

const recipeDoc = v.object({ _id: v.id('eventRecipes'), _creationTime: v.number(), organizationId: v.id('organizations'), key: v.string(), name: v.string(), description: v.optional(v.string()), status: recipeStatusValidator });
const versionDoc = v.object({ _id: v.id('recipeVersions'), _creationTime: v.number(), organizationId: v.id('organizations'), recipeId: v.id('eventRecipes'), versionNumber: v.number(), status: recipeVersionStatusValidator });
const recipeFieldDoc = v.object({ _id: v.id('recipeFields'), _creationTime: v.number(), organizationId: v.id('organizations'), recipeVersionId: v.id('recipeVersions'), fieldDefinitionId: v.id('fieldDefinitions'), position: v.number(), required: v.boolean(), visible: v.boolean(), defaultValue: v.optional(eventFieldValueValidator), config: fieldConfigValidator });
const paginatedRecipes = v.object({ page: v.array(recipeDoc), isDone: v.boolean(), continueCursor: v.string(), splitCursor: v.optional(v.union(v.string(), v.null())), pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())) });

export const getRecipe = query({ args: { recipeId: v.id('eventRecipes') }, returns: v.object({ recipe: recipeDoc, versions: v.array(versionDoc) }), handler: (ctx, args) => getRecipeModel(ctx, args.recipeId) });
export const listRecipes = query({ args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator }, returns: paginatedRecipes, handler: (ctx, args) => listRecipesModel(ctx, args.organizationId, args.paginationOpts) });
export const getRecipeVersion = query({ args: { recipeVersionId: v.id('recipeVersions') }, returns: v.object({ version: versionDoc, recipeFields: v.array(recipeFieldDoc) }), handler: (ctx, args) => getRecipeVersionModel(ctx, args.recipeVersionId) });
