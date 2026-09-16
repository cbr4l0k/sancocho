import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import {
  anyArmAssignmentDocValidator,
  anyArmAssignmentCheckpointDocValidator,
  assignmentDocValidator,
  providerAssignmentDocValidator,
  assignmentRevisionDocValidator,
  archivalStatusValidator,
  rateModalityValidator,
  providerAssignmentRevisionDocValidator,
  executionStatusValidator,
  serviceStatusValidator,
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
  listServiceAssignmentRows as listServiceAssignmentRowsModel,
  assignmentsAwaitingDispatch as assignmentsAwaitingDispatchModel,
  listDispatchDay as listDispatchDayModel,
  listProviderDispatchDay as listProviderDispatchDayModel,
  dispatchDayReadiness as dispatchDayReadinessModel,
} from './model';
import {
  assignmentRateLookupResultValidator,
  resolveAssignmentRate as resolveAssignmentRateModel,
} from './rateLookup';

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

export const resolveAssignmentRate = query({
  args: {
    serviceId: v.id('services'),
    providerId: v.id('providers'),
    vehicleClassId: v.id('vehicleClasses'),
    modality: rateModalityValidator,
  },
  returns: assignmentRateLookupResultValidator,
  handler: (ctx, args) => resolveAssignmentRateModel(ctx, args),
});

export const listServiceAssignmentRows = query({
  args: { serviceId: v.id('services') },
  returns: v.array(v.object({
    assignment: assignmentDocValidator,
    currentRevision: v.union(assignmentRevisionDocValidator, v.null()),
    latestRevision: v.union(assignmentRevisionDocValidator, v.null()),
    provider: v.union(v.object({
      _id: v.id('providers'),
      name: v.string(),
      status: archivalStatusValidator,
    }), v.null()),
    vehicleClass: v.union(v.object({
      _id: v.id('vehicleClasses'),
      name: v.string(),
      status: archivalStatusValidator,
    }), v.null()),
    costCentre: v.union(v.object({
      _id: v.id('costCentres'),
      key: v.string(),
      name: v.string(),
      status: archivalStatusValidator,
    }), v.null()),
  })),
  handler: (ctx, args) => listServiceAssignmentRowsModel(ctx, args.serviceId),
});

const serviceAssignmentRowValidator = v.object({
  assignment: assignmentDocValidator,
  currentRevision: v.union(assignmentRevisionDocValidator, v.null()),
  latestRevision: v.union(assignmentRevisionDocValidator, v.null()),
  provider: v.union(v.object({
    _id: v.id('providers'),
    name: v.string(),
    status: archivalStatusValidator,
  }), v.null()),
  vehicleClass: v.union(v.object({
    _id: v.id('vehicleClasses'),
    name: v.string(),
    status: archivalStatusValidator,
  }), v.null()),
  costCentre: v.union(v.object({
    _id: v.id('costCentres'),
    key: v.string(),
    name: v.string(),
    status: archivalStatusValidator,
  }), v.null()),
});

export const listDispatchDay = query({
  args: {
    projectId: v.id('projects'),
    from: v.number(),
    to: v.number(),
    eventId: v.optional(v.id('events')),
    status: v.optional(executionStatusValidator),
    providerId: v.optional(v.id('providers')),
    costCentreId: v.optional(v.id('costCentres')),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedResult(v.object({
    service: v.object({
      _id: v.id('services'),
      name: v.string(),
      startsAt: v.number(),
      endsAt: v.optional(v.number()),
      status: serviceStatusValidator,
      eventId: v.id('events'),
    }),
    rows: v.array(serviceAssignmentRowValidator),
  })),
  handler: (ctx, args) => listDispatchDayModel(ctx, args),
});

export const listProviderDispatchDay = query({
  args: {
    projectId: v.id('projects'),
    from: v.number(),
    to: v.number(),
    status: v.optional(executionStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedResult(v.object({
    assignment: providerAssignmentDocValidator,
    service: v.object({ _id: v.id('services'), startsAt: v.number() }),
    serviceProjection: v.array(providerServiceProjectionEntryValidator),
  })),
  handler: (ctx, args) => listProviderDispatchDayModel(ctx, args),
});

export const dispatchDayReadiness = query({
  args: {
    projectId: v.id('projects'),
    from: v.number(),
    to: v.number(),
    eventId: v.optional(v.id('events')),
  },
  returns: v.object({
    unassigned: v.number(),
    total: v.number(),
    complete: v.boolean(),
  }),
  handler: (ctx, args) => dispatchDayReadinessModel(ctx, args),
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
