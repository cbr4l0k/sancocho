import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { eventFieldValueValidator, eventStatusValidator } from '../validators';
import {
  changeEventStatus as changeEventStatusModel,
  createEventFromRecipe as createEventFromRecipeModel,
  updateEventCoreFields as updateEventCoreFieldsModel,
  updateEventFields as updateEventFieldsModel,
} from './model';

/**
 * The typed value unions are structurally loose on purpose (see
 * `eventFieldValueValidator`): every one of these mutations routes its values
 * through the single validation gate in ./model, which is what enforces the
 * recipe snapshot's rules. Creation cannot submit `null` — there is nothing to
 * clear yet — so only the update shape admits it.
 */
const createValue = v.object({ fieldDefinitionId: v.id('fieldDefinitions'), value: eventFieldValueValidator });
const updateValue = v.object({
  fieldDefinitionId: v.id('fieldDefinitions'),
  value: v.union(eventFieldValueValidator, v.null()),
});

/**
 * `recipeId` and `organizationId` are deliberately absent: both are derived from
 * the resolved recipe version and project server-side (I4).
 */
export const createEventFromRecipe = mutation({
  args: {
    projectId: v.id('projects'),
    recipeVersionId: v.id('recipeVersions'),
    name: v.string(),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    values: v.array(createValue),
  },
  returns: v.id('events'),
  handler: (ctx, args) => createEventFromRecipeModel(ctx, args),
});

/** Pass `endsAt: null` to explicitly clear an event's end; omit it to leave it alone. */
export const updateEventCoreFields = mutation({
  args: {
    eventId: v.id('events'),
    name: v.optional(v.string()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, { eventId, ...patch }) => {
    await updateEventCoreFieldsModel(ctx, { eventId, ...patch });
    return null;
  },
});

/** Pass `value: null` to explicitly clear a stored optional value. */
export const updateEventFields = mutation({
  args: { eventId: v.id('events'), values: v.array(updateValue) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateEventFieldsModel(ctx, args);
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
