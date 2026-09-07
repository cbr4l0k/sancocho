import { v } from 'convex/values';

import { query } from '../../_generated/server';
import { serviceFieldValueValidator, fieldConfigValidator } from '../../validators';
import { listServiceKindFields as listServiceKindFieldsModel } from './model';

const serviceKindFieldDoc = v.object({ _id: v.id('serviceKindFields'), _creationTime: v.number(), organizationId: v.id('organizations'), serviceKindVersionId: v.id('serviceKindVersions'), fieldDefinitionId: v.id('fieldDefinitions'), position: v.number(), required: v.boolean(), visible: v.boolean(), defaultValue: v.optional(serviceFieldValueValidator), defaultLocationId: v.optional(v.id('locations')), config: fieldConfigValidator });

export const listServiceKindFields = query({
  args: { serviceKindVersionId: v.id('serviceKindVersions') },
  returns: v.array(serviceKindFieldDoc),
  handler: (ctx, args) => listServiceKindFieldsModel(ctx, args.serviceKindVersionId),
});
