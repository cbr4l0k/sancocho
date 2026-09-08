import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import {
  archiveProvider as archiveProviderModel,
  createProvider as createProviderModel,
  deleteProvider as deleteProviderModel,
  updateProvider as updateProviderModel,
} from './model';

export const createProvider = mutation({
  args: {
    organizationId: v.id('organizations'),
    name: v.string(),
    legalName: v.optional(v.string()),
    taxId: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.id('providers'),
  handler: (ctx, args) => createProviderModel(ctx, args),
});

/**
 * The GENERIC Provider update. `linkedOrganizationId` is deliberately absent
 * from these args and cannot be added here: a claim is #86's verified,
 * separately-audited transition, not an editable column. Convex rejects
 * arguments this validator does not declare, so a client that sends the field
 * is refused outright rather than having it quietly ignored — see the
 * three-gate note on `ProviderPatch` in `model.ts`.
 */
export const updateProvider = mutation({
  args: {
    providerId: v.id('providers'),
    name: v.optional(v.string()),
    legalName: v.optional(v.string()),
    taxId: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { providerId, ...patch }) => {
    await updateProviderModel(ctx, providerId, patch);
    return null;
  },
});

export const archiveProvider = mutation({
  args: { providerId: v.id('providers') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await archiveProviderModel(ctx, args.providerId);
    return null;
  },
});

export const deleteProvider = mutation({
  args: { providerId: v.id('providers') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteProviderModel(ctx, args.providerId);
    return null;
  },
});
