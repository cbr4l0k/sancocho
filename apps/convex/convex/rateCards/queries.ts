import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import {
  paginatedResult,
  rateCardDocValidator,
  rateCardVersionDocValidator,
  rateLineDocValidator,
  rateModalityValidator,
  currencyValidator,
} from '../validators';
import {
  getRateCard as getRateCardModel,
  getRateCardDetail as getRateCardDetailModel,
  getRateCardVersion as getRateCardVersionModel,
  listRateCardVersions as listRateCardVersionsModel,
  listRateCards as listRateCardsModel,
  resolveRate as resolveRateModel,
} from './model';

export const getRateCard = query({
  args: { rateCardId: v.id('rateCards') },
  returns: rateCardDocValidator,
  handler: (ctx, args) => getRateCardModel(ctx, args.rateCardId),
});

export const getRateCardDetail = query({
  args: { rateCardId: v.id('rateCards') },
  returns: v.object({
    rateCard: rateCardDocValidator,
    draftVersion: v.union(rateCardVersionDocValidator, v.null()),
    publishedVersion: v.union(rateCardVersionDocValidator, v.null()),
  }),
  handler: (ctx, args) => getRateCardDetailModel(ctx, args.rateCardId),
});

export const listRateCards = query({
  args: {
    organizationId: v.id('organizations'),
    paginationOpts: paginationOptsValidator,
    providerId: v.optional(v.id('providers')),
  },
  returns: paginatedResult(rateCardDocValidator),
  handler: (ctx, args) =>
    listRateCardsModel(ctx, args.organizationId, args.paginationOpts, {
      ...(args.providerId === undefined ? {} : { providerId: args.providerId }),
    }),
});

export const listRateCardVersions = query({
  args: { rateCardId: v.id('rateCards'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(rateCardVersionDocValidator),
  handler: (ctx, args) => listRateCardVersionsModel(ctx, args.rateCardId, args.paginationOpts),
});

export const getRateCardVersion = query({
  args: { rateCardVersionId: v.id('rateCardVersions') },
  returns: v.object({ version: rateCardVersionDocValidator, rateLines: v.array(rateLineDocValidator) }),
  handler: (ctx, args) => getRateCardVersionModel(ctx, args.rateCardVersionId),
});

export const resolveRate = query({
  args: {
    rateCardVersionId: v.id('rateCardVersions'),
    providerId: v.id('providers'),
    vehicleClassId: v.id('vehicleClasses'),
    modality: rateModalityValidator,
  },
  returns: v.object({ rateLineId: v.id('rateLines'), unitAmount: v.number(), currency: currencyValidator }),
  handler: (ctx, args) => resolveRateModel(ctx, args),
});
