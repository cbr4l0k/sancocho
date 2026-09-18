import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { exportSheetValidator } from '../validators';
import { recordExportRequest as recordExportRequestModel } from './model';

export const recordExportRequest = mutation({
  args: {
    organizationId: v.id('organizations'),
    projectId: v.optional(v.id('projects')),
    sheets: v.array(exportSheetValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordExportRequestModel(ctx, args);
    return null;
  },
});
