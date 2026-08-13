import { v } from 'convex/values';

import { internalMutation, mutation } from '../_generated/server';
import { fieldConfigValidator, semanticTypeValidator } from '../validators';
import {
  archiveFieldDefinition as archiveFieldDefinitionModel,
  createBuiltinFieldDefinition as createBuiltinFieldDefinitionModel,
  createFieldDefinition as createFieldDefinitionModel,
  deleteFieldDefinition as deleteFieldDefinitionModel,
  updateFieldDefinition as updateFieldDefinitionModel,
} from './model';

const fieldInputArgs = {
  key: v.string(),
  label: v.string(),
  description: v.optional(v.string()),
  semanticType: v.optional(semanticTypeValidator),
  config: fieldConfigValidator,
};

export const createBuiltinFieldDefinition = internalMutation({
  args: fieldInputArgs,
  returns: v.id('fieldDefinitions'),
  handler: (ctx, args) => createBuiltinFieldDefinitionModel(ctx, args),
});

export const createFieldDefinition = mutation({
  args: { organizationId: v.id('organizations'), ...fieldInputArgs },
  returns: v.id('fieldDefinitions'),
  handler: (ctx, args) => createFieldDefinitionModel(ctx, args),
});

export const updateFieldDefinition = mutation({
  args: {
    fieldDefinitionId: v.id('fieldDefinitions'),
    label: v.optional(v.string()),
    description: v.optional(v.string()),
    key: v.optional(v.string()),
    semanticType: v.optional(semanticTypeValidator),
    config: v.optional(fieldConfigValidator),
  },
  returns: v.null(),
  handler: async (ctx, { fieldDefinitionId, ...patch }) => {
    await updateFieldDefinitionModel(ctx, fieldDefinitionId, patch);
    return null;
  },
});

export const archiveFieldDefinition = mutation({
  args: { fieldDefinitionId: v.id('fieldDefinitions') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await archiveFieldDefinitionModel(ctx, args.fieldDefinitionId);
    return null;
  },
});

export const deleteFieldDefinition = mutation({
  args: { fieldDefinitionId: v.id('fieldDefinitions') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteFieldDefinitionModel(ctx, args.fieldDefinitionId);
    return null;
  },
});
