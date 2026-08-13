import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { eventDocValidator, eventFieldValueValidator, paginatedResult } from '../validators';
import { getEvent as getEventModel, listProjectEvents as listProjectEventsModel } from './model';

/**
 * `key` and `label` are joined from the live field definition; the value itself
 * is interpreted under the event's immutable recipe snapshot. See the coupling
 * note in ./model `getEvent` for why the key half of that join is stable.
 */
const eventValue = v.object({
  fieldDefinitionId: v.id('fieldDefinitions'),
  key: v.string(),
  label: v.string(),
  value: eventFieldValueValidator,
});

export const getEvent = query({
  args: { eventId: v.id('events') },
  returns: v.object({ event: eventDocValidator, values: v.array(eventValue) }),
  handler: (ctx, args) => getEventModel(ctx, args.eventId),
});

export const listProjectEvents = query({
  args: { projectId: v.id('projects'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(eventDocValidator),
  handler: (ctx, args) => listProjectEventsModel(ctx, args),
});
