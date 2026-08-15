import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { fieldDefinitionFields, paginatedResult } from '../validators';
import {
  getFieldDefinitionsByIds as getFieldDefinitionsByIdsModel,
  listBuiltinFieldDefinitions as listBuiltinFieldDefinitionsModel,
  listFieldDefinitions as listFieldDefinitionsModel,
} from './model';

// Built from the same field definition the table is built from, so the
// documented API contract cannot drift from the stored document.
const fieldDefinitionDocValidator = v.object({
  _id: v.id('fieldDefinitions'),
  _creationTime: v.number(),
  ...fieldDefinitionFields,
});

const paginatedFieldsValidator = paginatedResult(fieldDefinitionDocValidator);

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

export const getFieldDefinitionsByIds = query({
  args: {
    organizationId: v.id('organizations'),
    fieldDefinitionIds: v.array(v.id('fieldDefinitions')),
  },
  returns: v.array(fieldDefinitionDocValidator),
  handler: (ctx, args) => getFieldDefinitionsByIdsModel(ctx, args.organizationId, args.fieldDefinitionIds),
});
