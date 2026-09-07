import { v } from 'convex/values';

import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { assertSeedingEnabled } from '../lib/seedGuard';

/**
 * Wipes a deployment's Services, ServiceKinds, Field Definitions and Locations so a
 * developer can re-seed from a clean slate.
 *
 * This is a **development reset**, and it is the one operation in the codebase
 * that deliberately ignores the deletion policy the domain models enforce
 * (archive rather than delete; never remove a published version or a referenced
 * field). Those rules protect an operating tenant's history; they are exactly
 * what makes a dev deployment impossible to re-seed. So this bypasses them
 * knowingly, in one place, behind the same `PRIAMO_ENABLE_SEED` opt-in as the
 * rest of `seed/`, rather than weakening any model.
 *
 * What it does NOT touch: users, organizations, memberships, and projects. A
 * developer's sign-in and their tenant survive the reset; only the operational
 * and configuration data listed above is rebuilt. Events are operational data
 * and are swept after their Services. Audit rows are removed for
 * exactly the entity types being deleted, so the log does not keep pointing at
 * ids that no longer resolve, while organization, membership and project
 * history stays intact.
 *
 * Deletion order is child-before-parent throughout, so no row is ever left
 * referencing a deleted one, even though Convex would not stop us.
 */

/** Audit rows for these entity types are removed alongside their entities. */
const clearedEntityTypes: ReadonlySet<Doc<'auditEvents'>['entityType']> = new Set([
  'service',
  'event',
  'serviceRelationship',
  'serviceKind',
  'serviceKindVersion',
  'serviceKindField',
  'fieldDefinition',
  'location',
]);

async function deleteAll<
  T extends
    | 'services'
    | 'events'
    | 'serviceFieldValues'
    | 'serviceRelationships'
    | 'serviceKindFields'
    | 'serviceKindVersions'
    | 'serviceKinds'
    | 'fieldDefinitions'
    | 'locations',
>(
  ctx: MutationCtx,
  table: T,
): Promise<number> {
  // A deployment-wide administrative sweep, not a tenant-facing read: a full
  // scan is the correct shape here and nowhere else (I6 governs public reads).
  const rows = await ctx.db.query(table).collect();
  for (const row of rows) await ctx.db.delete(row._id as Id<T>);
  return rows.length;
}

export const resetTenantOperations = internalMutation({
  args: {},
  returns: v.object({
    services: v.number(),
    events: v.number(),
    serviceFieldValues: v.number(),
    serviceRelationships: v.number(),
    serviceKindFields: v.number(),
    serviceKindVersions: v.number(),
    serviceKinds: v.number(),
    fieldDefinitions: v.number(),
    locations: v.number(),
    auditEvents: v.number(),
  }),
  handler: async (ctx) => {
    assertSeedingEnabled();

    // Children first: values and relationships reference services, serviceKind fields
    // reference versions, versions reference serviceKinds.
    const serviceFieldValues = await deleteAll(ctx, 'serviceFieldValues');
    const serviceRelationships = await deleteAll(ctx, 'serviceRelationships');
    const services = await deleteAll(ctx, 'services');
    const events = await deleteAll(ctx, 'events');
    const serviceKindFields = await deleteAll(ctx, 'serviceKindFields');
    const serviceKindVersions = await deleteAll(ctx, 'serviceKindVersions');
    const serviceKinds = await deleteAll(ctx, 'serviceKinds');
    // Field definitions and locations last: serviceKind fields and service values were
    // the things pointing at them.
    const fieldDefinitions = await deleteAll(ctx, 'fieldDefinitions');
    const locations = await deleteAll(ctx, 'locations');

    const audits = await ctx.db.query('auditEvents').collect();
    let auditEvents = 0;
    for (const audit of audits) {
      if (!clearedEntityTypes.has(audit.entityType)) continue;
      await ctx.db.delete(audit._id);
      auditEvents += 1;
    }

    return {
      services,
      events,
      serviceFieldValues,
      serviceRelationships,
      serviceKindFields,
      serviceKindVersions,
      serviceKinds,
      fieldDefinitions,
      locations,
      auditEvents,
    };
  },
});
