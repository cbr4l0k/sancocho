import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import {
  displayUserValidator,
  eventDocValidator,
  eventStatusValidator,
  locationTypeValidator,
  paginatedResult,
  projectStatusValidator,
  archivalStatusValidator,
} from '../validators';
import {
  getEvent as getEventModel,
  getEventDetail as getEventDetailModel,
  listOrganizationEvents as listOrganizationEventsModel,
  listProjectEvents as listProjectEventsModel,
} from './model';

export const getEvent = query({
  args: { eventId: v.id('events') },
  returns: eventDocValidator,
  handler: (ctx, args) => getEventModel(ctx, args.eventId),
});

export const getEventDetail = query({
  args: { eventId: v.id('events') },
  returns: v.object({
    event: eventDocValidator,
    project: v.object({ _id: v.id('projects'), name: v.string(), status: projectStatusValidator }),
    venue: v.union(v.null(), v.object({ _id: v.id('locations'), name: v.string(), type: locationTypeValidator })),
    clientCostCentre: v.union(v.null(), v.object({
      _id: v.id('costCentres'),
      key: v.string(),
      name: v.string(),
      status: archivalStatusValidator,
    })),
    accountable: v.union(v.null(), displayUserValidator),
  }),
  handler: (ctx, args) => getEventDetailModel(ctx, args.eventId),
});

export const listProjectEvents = query({
  args: { projectId: v.id('projects'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(eventDocValidator),
  handler: (ctx, args) => listProjectEventsModel(ctx, args),
});

export const listOrganizationEvents = query({
  args: {
    organizationId: v.id('organizations'),
    projectId: v.optional(v.id('projects')),
    status: v.optional(eventStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedResult(eventDocValidator),
  handler: (ctx, args) => listOrganizationEventsModel(ctx, args),
});
