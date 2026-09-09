import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { currencyValidator, rateModalityValidator } from '../validators';
import {
  addRateLine as addRateLineModel,
  archiveRateCard as archiveRateCardModel,
  clonePublishedVersionToDraft as clonePublishedVersionToDraftModel,
  createInitialDraftVersion as createInitialDraftVersionModel,
  createRateCard as createRateCardModel,
  publishRateCardVersion as publishRateCardVersionModel,
  removeRateLine as removeRateLineModel,
  retireRateCardVersion as retireRateCardVersionModel,
  updateRateCardMetadata as updateRateCardMetadataModel,
  updateRateCardVersion as updateRateCardVersionModel,
  updateRateLine as updateRateLineModel,
} from './model';

export const createRateCard = mutation({
  args: { organizationId: v.id('organizations'), providerId: v.id('providers'), name: v.string() },
  returns: v.id('rateCards'),
  handler: (ctx, args) => createRateCardModel(ctx, args),
});

export const updateRateCardMetadata = mutation({
  args: { rateCardId: v.id('rateCards'), name: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { rateCardId, ...patch }) => {
    await updateRateCardMetadataModel(ctx, rateCardId, patch);
    return null;
  },
});

export const archiveRateCard = mutation({
  args: { rateCardId: v.id('rateCards') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await archiveRateCardModel(ctx, args.rateCardId);
    return null;
  },
});

export const createInitialDraftVersion = mutation({
  args: { rateCardId: v.id('rateCards'), currency: currencyValidator },
  returns: v.id('rateCardVersions'),
  handler: (ctx, args) => createInitialDraftVersionModel(ctx, args.rateCardId, args.currency),
});

export const clonePublishedVersionToDraft = mutation({
  args: { rateCardId: v.id('rateCards') },
  returns: v.id('rateCardVersions'),
  handler: (ctx, args) => clonePublishedVersionToDraftModel(ctx, args.rateCardId),
});

export const updateRateCardVersion = mutation({
  args: { rateCardVersionId: v.id('rateCardVersions'), currency: currencyValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateRateCardVersionModel(ctx, args.rateCardVersionId, args.currency);
    return null;
  },
});

export const addRateLine = mutation({
  args: {
    rateCardVersionId: v.id('rateCardVersions'),
    vehicleClassId: v.id('vehicleClasses'),
    modality: rateModalityValidator,
    unitAmount: v.number(),
  },
  returns: v.id('rateLines'),
  handler: (ctx, args) => addRateLineModel(ctx, args),
});

export const updateRateLine = mutation({
  args: {
    rateLineId: v.id('rateLines'),
    vehicleClassId: v.optional(v.id('vehicleClasses')),
    modality: v.optional(rateModalityValidator),
    unitAmount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateRateLineModel(ctx, args);
    return null;
  },
});

export const removeRateLine = mutation({
  args: { rateLineId: v.id('rateLines') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await removeRateLineModel(ctx, args.rateLineId);
    return null;
  },
});

export const publishRateCardVersion = mutation({
  args: { rateCardVersionId: v.id('rateCardVersions') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await publishRateCardVersionModel(ctx, args.rateCardVersionId);
    return null;
  },
});

export const retireRateCardVersion = mutation({
  args: { rateCardVersionId: v.id('rateCardVersions') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await retireRateCardVersionModel(ctx, args.rateCardVersionId);
    return null;
  },
});
