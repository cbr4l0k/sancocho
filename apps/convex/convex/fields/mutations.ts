import { v } from 'convex/values';

import { internalMutation, mutation } from '../_generated/server';
import { assertSeedingEnabled } from '../lib/seedGuard';
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

/**
 * Guarded by the same deployment opt-in as the seed mutations, and for the same
 * reason: creating a built-in permanently squats its key in EVERY tenant's
 * namespace (see the shadow probe in `fields/model.ts:assertKeyAvailable`) and
 * there is no way to unsquat it. Being `internalMutation` is not the guard —
 * anyone who can run `convex run --prod` reaches an internal function.
 */
export const createBuiltinFieldDefinition = internalMutation({
  args: fieldInputArgs,
  returns: v.id('fieldDefinitions'),
  handler: (ctx, args) => {
    assertSeedingEnabled();
    return createBuiltinFieldDefinitionModel(ctx, args);
  },
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
