import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { projectDocValidator } from '../validators';
import { getProject as getProjectModel, listProjects as listProjectsModel } from './model';

export const getProject = query({
  args: { projectId: v.id('projects') },
  returns: projectDocValidator,
  handler: (ctx, args) => getProjectModel(ctx, args.projectId),
});

export const listProjects = query({
  args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(projectDocValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())),
  }),
  handler: (ctx, args) => listProjectsModel(ctx, args.organizationId, args.paginationOpts),
});
