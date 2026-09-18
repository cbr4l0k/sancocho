import { v } from 'convex/values';

import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { assertSeedingEnabled } from '../lib/seedGuard';

/**
 * Wipes a deployment's operational and configuration data so a developer can
 * re-seed from a clean slate.
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
 * and configuration data listed below is rebuilt. Membership invitations stay
 * too; Provider-claim invitations are swept because they point at Provider
 * rows this reset deletes. Events are operational data and are swept after
 * their Services. Audit rows are removed for exactly the entity types being
 * deleted, so the log does not keep pointing at ids that no longer resolve,
 * while organization, membership and project history stays intact.
 *
 * Deletion order is child-before-parent throughout, so no row is ever left
 * referencing a deleted one, even though Convex would not stop us.
 */

/** Audit rows for these entity types are removed alongside their entities. */
const clearedEntityTypes: ReadonlySet<Doc<'auditEvents'>['entityType']> = new Set([
  'assignmentCheckpoint',
  'assignmentRevision',
  'assignment',
  'providerAccessGrant',
  'providerClaimInvitation',
  'rateCard',
  'rateCardVersion',
  'vehicleClass',
  'fleetVehicle',
  'costCentre',
  'provider',
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
    | 'assignmentCheckpoints'
    | 'assignmentRevisions'
    | 'assignments'
    | 'providerAccessGrants'
    | 'rateLines'
    | 'rateCardVersions'
    | 'rateCards'
    | 'fleetVehicles'
    | 'vehicleClasses'
    | 'costCentres'
    | 'providers'
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

async function deleteProviderClaimInvitations(ctx: MutationCtx): Promise<number> {
  const rows = await ctx.db.query('organizationInvitations').collect();
  let deleted = 0;
  for (const row of rows) {
    if (row.kind !== 'providerClaim') continue;
    await ctx.db.delete(row._id);
    deleted += 1;
  }
  return deleted;
}

export const resetTenantOperations = internalMutation({
  args: {},
  returns: v.object({
    assignmentCheckpoints: v.number(),
    assignmentRevisions: v.number(),
    assignments: v.number(),
    providerAccessGrants: v.number(),
    rateLines: v.number(),
    rateCardVersions: v.number(),
    rateCards: v.number(),
    fleetVehicles: v.number(),
    vehicleClasses: v.number(),
    costCentres: v.number(),
    providers: v.number(),
    providerClaimInvitations: v.number(),
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

    // Child-before-parent from the stored references:
    //   assignmentCheckpoints → assignments
    //   assignmentRevisions → assignments, rateLines, rateCardVersions, vehicleClasses
    //   assignments → services, providers, costCentres, fleetVehicles
    //   providerAccessGrants → providers
    //   rateLines → rateCardVersions, vehicleClasses
    //   rateCardVersions → rateCards
    //   rateCards → providers
    //   fleetVehicles → providers, vehicleClasses
    //   events.clientCostCentreId → costCentres (so cost centres wait until after events)
    //   providerClaim invitations → providers
    const assignmentCheckpoints = await deleteAll(ctx, 'assignmentCheckpoints');
    const assignmentRevisions = await deleteAll(ctx, 'assignmentRevisions');
    const assignments = await deleteAll(ctx, 'assignments');
    const providerAccessGrants = await deleteAll(ctx, 'providerAccessGrants');
    const rateLines = await deleteAll(ctx, 'rateLines');
    const rateCardVersions = await deleteAll(ctx, 'rateCardVersions');
    const rateCards = await deleteAll(ctx, 'rateCards');
    const fleetVehicles = await deleteAll(ctx, 'fleetVehicles');
    // Sweeping Vehicle Classes is only safe because the Cordillera seed now
    // calls `provisionStarterVehicleClasses` itself. Starter classes used to
    // be provisioned only at organization creation, which a reset never
    // re-runs — deleting them then would have left the tenant permanently
    // without a catalogue. Reset-then-reseed restores them.
    const vehicleClasses = await deleteAll(ctx, 'vehicleClasses');

    const serviceFieldValues = await deleteAll(ctx, 'serviceFieldValues');
    const serviceRelationships = await deleteAll(ctx, 'serviceRelationships');
    const services = await deleteAll(ctx, 'services');
    const events = await deleteAll(ctx, 'events');
    const costCentres = await deleteAll(ctx, 'costCentres');
    const providerClaimInvitations = await deleteProviderClaimInvitations(ctx);
    const providers = await deleteAll(ctx, 'providers');
    const serviceKindFields = await deleteAll(ctx, 'serviceKindFields');
    const serviceKindVersions = await deleteAll(ctx, 'serviceKindVersions');
    const serviceKinds = await deleteAll(ctx, 'serviceKinds');
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
      assignmentCheckpoints,
      assignmentRevisions,
      assignments,
      providerAccessGrants,
      rateLines,
      rateCardVersions,
      rateCards,
      fleetVehicles,
      vehicleClasses,
      costCentres,
      providers,
      providerClaimInvitations,
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
