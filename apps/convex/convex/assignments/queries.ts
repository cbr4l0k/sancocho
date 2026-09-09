import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import {
  assignmentDocValidator,
  assignmentRevisionDocValidator,
  paginatedResult,
} from '../validators';
import {
  getAssignment as getAssignmentModel,
  getAssignmentRevision as getAssignmentRevisionModel,
  listAssignmentRevisions as listAssignmentRevisionsModel,
  listProjectAssignments as listProjectAssignmentsModel,
  listServiceAssignments as listServiceAssignmentsModel,
} from './model';

export const getAssignment = query({
  args: { assignmentId: v.id('assignments') },
  returns: assignmentDocValidator,
  handler: (ctx, args) => getAssignmentModel(ctx, args.assignmentId),
});

export const getAssignmentRevision = query({
  args: { revisionId: v.id('assignmentRevisions') },
  returns: assignmentRevisionDocValidator,
  handler: (ctx, args) => getAssignmentRevisionModel(ctx, args.revisionId),
});

export const listAssignmentRevisions = query({
  args: { assignmentId: v.id('assignments'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(assignmentRevisionDocValidator),
  handler: (ctx, args) => listAssignmentRevisionsModel(ctx, args),
});

export const listServiceAssignments = query({
  args: { serviceId: v.id('services') },
  returns: v.array(assignmentDocValidator),
  handler: (ctx, args) => listServiceAssignmentsModel(ctx, args.serviceId),
});

export const listProjectAssignments = query({
  args: { projectId: v.id('projects'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(assignmentDocValidator),
  handler: (ctx, args) => listProjectAssignmentsModel(ctx, args),
});
