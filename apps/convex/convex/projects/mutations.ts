import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { projectStatusValidator } from '../validators';
import {
  archiveProject as archiveProjectModel,
  createProject as createProjectModel,
  updateProject as updateProjectModel,
} from './model';

export const createProject = mutation({
  args: {
    organizationId: v.id('organizations'),
    name: v.string(),
    description: v.optional(v.string()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
  },
  returns: v.id('projects'),
  handler: (ctx, args) => createProjectModel(ctx, args),
});

export const updateProject = mutation({
  args: {
    projectId: v.id('projects'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    status: v.optional(projectStatusValidator),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, ...patch }) => {
    await updateProjectModel(ctx, projectId, patch);
    return null;
  },
});

export const archiveProject = mutation({
  args: { projectId: v.id('projects') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await archiveProjectModel(ctx, args.projectId);
    return null;
  },
});
