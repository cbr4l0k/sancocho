import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { eventStatusValidator } from '../validators';
import {
  archiveEvent as archiveEventModel,
  changeEventStatus as changeEventStatusModel,
  createEvent as createEventModel,
  deleteEvent as deleteEventModel,
  updateEvent as updateEventModel,
} from './model';

export const createEvent = mutation({
  args: { projectId: v.id('projects'), name: v.string(), startsAt: v.number(), endsAt: v.optional(v.number()) },
  returns: v.id('events'),
  handler: (ctx, args) => createEventModel(ctx, args),
});

export const updateEvent = mutation({
  args: {
    eventId: v.id('events'),
    name: v.optional(v.string()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.union(v.number(), v.null())),
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
