import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import {
  eventDocValidator,
  eventFieldValueValidator,
  eventStatusValidator,
  fieldConfigValidator,
  paginatedResult,
  projectStatusValidator,
} from '../validators';
import {
  getEvent as getEventModel,
  listOrganizationEvents as listOrganizationEventsModel,
  listProjectEvents as listProjectEventsModel,
} from './model';

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
  /** Joined for `location` values only — see ./model `locationNameOf`. */
  locationName: v.optional(v.string()),
});

/**
 * A table row's version of the same join. It carries the recipe field's
 * immutable `config` snapshot alongside the value, and includes fields that
 * have NO value, because the console renders one column per field the version
 * composes and edits values in place — both need the field to exist in the row
 * even when the event has nothing stored for it.
 */
const eventRowField = v.object({
  fieldDefinitionId: v.id('fieldDefinitions'),
  key: v.string(),
  label: v.string(),
  required: v.boolean(),
  position: v.number(),
  config: fieldConfigValidator,
  value: v.optional(eventFieldValueValidator),
  /** Joined for `location` values only — see ./model `locationNameOf`. */
  locationName: v.optional(v.string()),
});

const eventRow = v.object({
  event: eventDocValidator,
  projectName: v.string(),
  projectStatus: projectStatusValidator,
  /** The project's own window — an affordance for the row editor. See ./model. */
  projectStartsAt: v.optional(v.number()),
  projectEndsAt: v.optional(v.number()),
  fields: v.array(eventRowField),
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

/**
 * The Services screen's list: every project's events in one ordered page.
 *
 * `projectId` and `status` are optional NARROWINGS of that list, not required
 * steps — the console used to make choosing a project a precondition for seeing
 * any service at all, which meant the one screen that should answer "what is
 * happening, in order" could only ever answer it one project at a time.
 */
export const listOrganizationEvents = query({
  args: {
    organizationId: v.id('organizations'),
    projectId: v.optional(v.id('projects')),
    status: v.optional(eventStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedResult(eventRow),
  handler: (ctx, args) => listOrganizationEventsModel(ctx, args),
});
