import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { rateModalityValidator } from '../validators';
import {
  acceptAssignmentRevision as acceptAssignmentRevisionModel,
  createAssignment as createAssignmentModel,
  createAssignmentRevision as createAssignmentRevisionModel,
  declineAssignmentRevision as declineAssignmentRevisionModel,
  removeAssignment as removeAssignmentModel,
} from './model';

/** Organization and Project are derived from the stored Service (I4). */
export const createAssignment = mutation({
  args: {
    serviceId: v.id('services'),
    providerId: v.id('providers'),
    position: v.number(),
    notes: v.optional(v.string()),
  },
  returns: v.id('assignments'),
  handler: (ctx, args) => createAssignmentModel(ctx, args),
});

/** Revision number, price, currency, total and status are all server assigned. */
export const createAssignmentRevision = mutation({
  args: {
    assignmentId: v.id('assignments'),
    vehicleClassId: v.id('vehicleClasses'),
    modality: rateModalityValidator,
    quantity: v.number(),
    rateCardVersionId: v.id('rateCardVersions'),
    rateLineId: v.id('rateLines'),
  },
  returns: v.id('assignmentRevisions'),
  handler: (ctx, args) => createAssignmentRevisionModel(ctx, args),
});

export const acceptAssignmentRevision = mutation({
  args: { revisionId: v.id('assignmentRevisions') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await acceptAssignmentRevisionModel(ctx, args.revisionId);
    return null;
  },
});

export const declineAssignmentRevision = mutation({
  args: { revisionId: v.id('assignmentRevisions'), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await declineAssignmentRevisionModel(ctx, args);
    return null;
  },
});

export const removeAssignment = mutation({
  args: { assignmentId: v.id('assignments') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await removeAssignmentModel(ctx, args.assignmentId);
    return null;
  },
});
