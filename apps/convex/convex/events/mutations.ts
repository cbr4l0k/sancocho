import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { currencyValidator, eventStatusValidator } from '../validators';
import {
  archiveEvent as archiveEventModel,
  changeEventStatus as changeEventStatusModel,
  createEvent as createEventModel,
  deleteEvent as deleteEventModel,
  updateEvent as updateEventModel,
} from './model';

export const createEvent = mutation({
  args: {
    projectId: v.id('projects'),
    name: v.string(),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    venueLocationId: v.optional(v.id('locations')),
    clientCostCentreId: v.optional(v.id('costCentres')),
    budgetAmount: v.optional(v.number()),
    budgetCurrency: v.optional(currencyValidator),
    accountableUserId: v.optional(v.id('users')),
  },
  returns: v.id('events'),
  handler: (ctx, args) => createEventModel(ctx, args),
});

export const updateEvent = mutation({
  args: {
    eventId: v.id('events'),
    name: v.optional(v.string()),
    startsAt: v.optional(v.number()),
    // Every optional column takes the same three-state argument as `endsAt`:
    // absent leaves it, `null` clears it, a value replaces it.
    endsAt: v.optional(v.union(v.number(), v.null())),
    venueLocationId: v.optional(v.union(v.id('locations'), v.null())),
    clientCostCentreId: v.optional(v.union(v.id('costCentres'), v.null())),
    budgetAmount: v.optional(v.union(v.number(), v.null())),
    budgetCurrency: v.optional(v.union(currencyValidator, v.null())),
    accountableUserId: v.optional(v.union(v.id('users'), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, { eventId, ...patch }) => {
    await updateEventModel(ctx, eventId, patch);
    return null;
  },
});

export const changeEventStatus = mutation({
  args: { eventId: v.id('events'), status: eventStatusValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await changeEventStatusModel(ctx, args);
    return null;
  },
});

export const archiveEvent = mutation({
  args: { eventId: v.id('events') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await archiveEventModel(ctx, args.eventId);
    return null;
  },
});

export const deleteEvent = mutation({
  args: { eventId: v.id('events') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteEventModel(ctx, args.eventId);
    return null;
  },
});
