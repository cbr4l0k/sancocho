import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { fieldDefinitionFields } from '../validators';
import { listBuiltinFieldDefinitions as listBuiltinFieldDefinitionsModel, listFieldDefinitions as listFieldDefinitionsModel } from './model';

// Built from the same field definition the table is built from, so the
// documented API contract cannot drift from the stored document.
const fieldDefinitionDocValidator = v.object({
  _id: v.id('fieldDefinitions'),
  _creationTime: v.number(),
  ...fieldDefinitionFields,
});

const paginatedFieldsValidator = v.object({
  page: v.array(fieldDefinitionDocValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())),
});

export const listFieldDefinitions = query({
  args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator },
  returns: paginatedFieldsValidator,
  handler: (ctx, args) => listFieldDefinitionsModel(ctx, args.organizationId, args.paginationOpts),
});

export const listBuiltinFieldDefinitions = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginatedFieldsValidator,
  handler: (ctx, args) => listBuiltinFieldDefinitionsModel(ctx, args.paginationOpts),
});
