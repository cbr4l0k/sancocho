import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import {
  archiveCostCentre as archiveCostCentreModel,
  createCostCentre as createCostCentreModel,
  deleteCostCentre as deleteCostCentreModel,
  updateCostCentre as updateCostCentreModel,
} from './model';

export const createCostCentre = mutation({
  args: {
    organizationId: v.id('organizations'),
    key: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    externalReference: v.optional(v.string()),
  },
  returns: v.id('costCentres'),
  handler: (ctx, args) => createCostCentreModel(ctx, args),
});

export const updateCostCentre = mutation({
  args: {
    costCentreId: v.id('costCentres'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    externalReference: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { costCentreId, ...patch }) => {
    await updateCostCentreModel(ctx, costCentreId, patch);
    return null;
  },
});

export const archiveCostCentre = mutation({
  args: { costCentreId: v.id('costCentres') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await archiveCostCentreModel(ctx, args.costCentreId);
    return null;
  },
});

export const deleteCostCentre = mutation({
  args: { costCentreId: v.id('costCentres') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteCostCentreModel(ctx, args.costCentreId);
    return null;
  },
});
