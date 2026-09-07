import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { eventDocValidator, paginatedResult } from '../validators';
import { getEvent as getEventModel, listProjectEvents as listProjectEventsModel } from './model';

export const getEvent = query({
  args: { eventId: v.id('events') },
  returns: eventDocValidator,
  handler: (ctx, args) => getEventModel(ctx, args.eventId),
});

export const listProjectEvents = query({
  args: { projectId: v.id('projects'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(eventDocValidator),
  handler: (ctx, args) => listProjectEventsModel(ctx, args),
});
