import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { auditEntityTypeValidator, auditEventDocValidator, paginatedResult } from '../validators';
import {
  listEntityAuditEvents as listEntityAuditEventsModel,
  listOrganizationAuditEvents as listOrganizationAuditEventsModel,
} from './model';

/**
 * Append-only audit log reads are administrative: owner and admin only;
 * planners, operators, and viewers cannot read this log.
 */
export const listOrganizationAuditEvents = query({
  args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(auditEventDocValidator),
  handler: (ctx, args) => listOrganizationAuditEventsModel(ctx, args.organizationId, args.paginationOpts),
});

export const listEntityAuditEvents = query({
  args: {
    organizationId: v.id('organizations'),
    entityType: auditEntityTypeValidator,
    entityId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedResult(auditEventDocValidator),
  handler: (ctx, args) => listEntityAuditEventsModel(ctx, args),
});
