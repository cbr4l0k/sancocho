import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { serviceFieldValueValidator, serviceStatusValidator } from '../validators';
import {
  changeServiceStatus as changeServiceStatusModel,
  createServiceFromServiceKind as createServiceFromServiceKindModel,
  updateServiceCoreFields as updateServiceCoreFieldsModel,
  updateServiceFields as updateServiceFieldsModel,
} from './model';

/**
 * The typed value unions are structurally loose on purpose (see
 * `serviceFieldValueValidator`): every one of these mutations routes its values
 * through the single validation gate in ./model, which is what enforces the
 * serviceKind snapshot's rules. Creation cannot submit `null` — there is nothing to
 * clear yet — so only the update shape admits it.
 */
const createValue = v.object({ fieldDefinitionId: v.id('fieldDefinitions'), value: serviceFieldValueValidator });
const updateValue = v.object({
  fieldDefinitionId: v.id('fieldDefinitions'),
  value: v.union(serviceFieldValueValidator, v.null()),
});

/**
 * `serviceKindId` and `organizationId` are deliberately absent: both are derived from
 * the resolved serviceKind version and project server-side (I4).
 */
export const createServiceFromServiceKind = mutation({
  args: {
    projectId: v.id('projects'),
    serviceKindVersionId: v.id('serviceKindVersions'),
    name: v.string(),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    values: v.array(createValue),
  },
  returns: v.id('services'),
  handler: (ctx, args) => createServiceFromServiceKindModel(ctx, args),
});

/** Pass `endsAt: null` to explicitly clear an service's end; omit it to leave it alone. */
export const updateServiceCoreFields = mutation({
  args: {
    serviceId: v.id('services'),
    name: v.optional(v.string()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, { serviceId, ...patch }) => {
    await updateServiceCoreFieldsModel(ctx, { serviceId, ...patch });
    return null;
  },
});

/** Pass `value: null` to explicitly clear a stored optional value. */
export const updateServiceFields = mutation({
  args: { serviceId: v.id('services'), values: v.array(updateValue) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateServiceFieldsModel(ctx, args);
    return null;
  },
});

export const changeServiceStatus = mutation({
  args: { serviceId: v.id('services'), status: serviceStatusValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await changeServiceStatusModel(ctx, args);
    return null;
  },
});
