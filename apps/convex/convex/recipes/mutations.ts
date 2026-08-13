import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { archiveRecipe as archiveRecipeModel, clonePublishedVersionToDraft as clonePublishedVersionToDraftModel, createInitialDraftVersion as createInitialDraftVersionModel, createRecipe as createRecipeModel, publishRecipeVersion as publishRecipeVersionModel, updateRecipeMetadata as updateRecipeMetadataModel } from './model';

export const createRecipe = mutation({ args: { organizationId: v.id('organizations'), key: v.string(), name: v.string(), description: v.optional(v.string()) }, returns: v.id('eventRecipes'), handler: (ctx, args) => createRecipeModel(ctx, args) });
export const updateRecipeMetadata = mutation({ args: { recipeId: v.id('eventRecipes'), name: v.optional(v.string()), description: v.optional(v.string()) }, returns: v.null(), handler: async (ctx, { recipeId, ...patch }) => { await updateRecipeMetadataModel(ctx, recipeId, patch); return null; } });
export const archiveRecipe = mutation({ args: { recipeId: v.id('eventRecipes') }, returns: v.null(), handler: async (ctx, args) => { await archiveRecipeModel(ctx, args.recipeId); return null; } });
export const createInitialDraftVersion = mutation({ args: { recipeId: v.id('eventRecipes') }, returns: v.id('recipeVersions'), handler: (ctx, args) => createInitialDraftVersionModel(ctx, args.recipeId) });
export const clonePublishedVersionToDraft = mutation({ args: { recipeId: v.id('eventRecipes') }, returns: v.id('recipeVersions'), handler: (ctx, args) => clonePublishedVersionToDraftModel(ctx, args.recipeId) });
export const publishRecipeVersion = mutation({ args: { recipeVersionId: v.id('recipeVersions') }, returns: v.null(), handler: async (ctx, args) => { await publishRecipeVersionModel(ctx, args.recipeVersionId); return null; } });
