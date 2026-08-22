import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { paginatedResult, projectDocValidator, projectStatusValidator } from '../validators';
import { getProject as getProjectModel, listProjects as listProjectsModel } from './model';

export const getProject = query({
  args: { projectId: v.id('projects') },
  returns: projectDocValidator,
  handler: (ctx, args) => getProjectModel(ctx, args.projectId),
});

export const listProjects = query({
  args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator, status: v.optional(projectStatusValidator) },
  returns: paginatedResult(projectDocValidator),
  handler: (ctx, args) => listProjectsModel(ctx, args.organizationId, args.paginationOpts, args.status === undefined ? {} : { status: args.status }),
});
