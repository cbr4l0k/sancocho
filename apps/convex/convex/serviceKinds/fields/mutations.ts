import { v } from 'convex/values';

import { mutation } from '../../_generated/server';
import { serviceFieldValueValidator, fieldConfigValidator } from '../../validators';
import { addServiceKindField as addServiceKindFieldModel, removeServiceKindField as removeServiceKindFieldModel, reorderServiceKindFields as reorderServiceKindFieldsModel, updateServiceKindField as updateServiceKindFieldModel } from './model';

export const addServiceKindField = mutation({
  args: { serviceKindVersionId: v.id('serviceKindVersions'), fieldDefinitionId: v.id('fieldDefinitions'), required: v.boolean(), visible: v.boolean(), position: v.optional(v.number()), config: v.optional(fieldConfigValidator), defaultValue: v.optional(serviceFieldValueValidator) },
  returns: v.id('serviceKindFields'),
  handler: (ctx, args) => addServiceKindFieldModel(ctx, args),
});

/** Pass `defaultValue: null` to explicitly clear a serviceKind field's default. */
export const updateServiceKindField = mutation({
  args: { serviceKindFieldId: v.id('serviceKindFields'), required: v.optional(v.boolean()), visible: v.optional(v.boolean()), config: v.optional(fieldConfigValidator), defaultValue: v.optional(v.union(serviceFieldValueValidator, v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => { await updateServiceKindFieldModel(ctx, args); return null; },
});

export const reorderServiceKindFields = mutation({
  args: { serviceKindVersionId: v.id('serviceKindVersions'), orderedServiceKindFieldIds: v.array(v.id('serviceKindFields')) },
  returns: v.null(),
  handler: async (ctx, args) => { await reorderServiceKindFieldsModel(ctx, args.serviceKindVersionId, args.orderedServiceKindFieldIds); return null; },
});

export const removeServiceKindField = mutation({
  args: { serviceKindFieldId: v.id('serviceKindFields') },
  returns: v.null(),
  handler: async (ctx, args) => { await removeServiceKindFieldModel(ctx, args.serviceKindFieldId); return null; },
});
