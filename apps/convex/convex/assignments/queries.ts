import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import {
  anyArmAssignmentDocValidator,
  anyArmAssignmentCheckpointDocValidator,
  assignmentDocValidator,
  assignmentRevisionDocValidator,
  providerAssignmentRevisionDocValidator,
  executionStatusValidator,
  paginatedResult,
} from '../validators';
import { providerServiceProjectionEntryValidator } from '../lib/providerProjection';
import {
  getAssignment as getAssignmentModel,
  getAssignmentDetail as getAssignmentDetailModel,
  getAssignmentRevision as getAssignmentRevisionModel,
  listAssignmentRevisions as listAssignmentRevisionsModel,
  listAssignmentCheckpoints as listAssignmentCheckpointsModel,
  listProjectAssignments as listProjectAssignmentsModel,
  listServiceAssignments as listServiceAssignmentsModel,
  assignmentsAwaitingDispatch as assignmentsAwaitingDispatchModel,
} from './model';

export const getAssignment = query({
  args: { assignmentId: v.id('assignments') },
  returns: anyArmAssignmentDocValidator,
  handler: (ctx, args) => getAssignmentModel(ctx, args.assignmentId),
});

export const getAssignmentRevision = query({
  args: { revisionId: v.id('assignmentRevisions') },
  returns: v.union(assignmentRevisionDocValidator, providerAssignmentRevisionDocValidator),
  handler: (ctx, args) => getAssignmentRevisionModel(ctx, args.revisionId),
});

export const listAssignmentRevisions = query({
  args: { assignmentId: v.id('assignments'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(v.union(assignmentRevisionDocValidator, providerAssignmentRevisionDocValidator)),
  handler: (ctx, args) => listAssignmentRevisionsModel(ctx, args),
});

export const listAssignmentCheckpoints = query({
  args: { assignmentId: v.id('assignments'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(anyArmAssignmentCheckpointDocValidator),
  handler: (ctx, args) => listAssignmentCheckpointsModel(ctx, args),
});

export const getAssignmentDetail = query({
  args: { assignmentId: v.id('assignments') },
  returns: v.object({
    assignment: anyArmAssignmentDocValidator,
    // The entry validator is owned by `lib/providerProjection.ts` alongside the
    // closed list itself, so the published contract narrows to the eleven and
    // an excluded semantic is refused on the way out even if the selection
    // inside the projection is ever weakened.
    serviceProjection: v.array(providerServiceProjectionEntryValidator),
  }),
  handler: (ctx, args) => getAssignmentDetailModel(ctx, args.assignmentId),
});

export const listServiceAssignments = query({
  args: { serviceId: v.id('services') },
  returns: v.array(anyArmAssignmentDocValidator),
  handler: (ctx, args) => listServiceAssignmentsModel(ctx, args.serviceId),
});

export const listProjectAssignments = query({
  args: { projectId: v.id('projects'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(anyArmAssignmentDocValidator),
  handler: (ctx, args) => listProjectAssignmentsModel(ctx, args),
});

export const assignmentsAwaitingDispatch = query({
  args: {
    projectId: v.id('projects'),
    statuses: v.array(executionStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedResult(anyArmAssignmentDocValidator),
  handler: (ctx, args) => assignmentsAwaitingDispatchModel(ctx, args),
});
