import type { UserIdentity } from 'convex/server';
import { v } from 'convex/values';

import { ensureAuthenticatedUser } from '../auth/model';
import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { createEventFromRecipe } from '../events/model';
import { ensureBuiltinFieldDefinitions, type BuiltinFieldKey } from '../fields/builtins';
import { conflict, invalidInput } from '../lib/errors';
import { normalizeSearchText } from '../lib/search';
import { assertSeedingEnabled } from '../lib/seedGuard';
import { createLocation } from '../locations/model';
import { addMember, createOrganization } from '../organizations/model';
import { createProject } from '../projects/model';
import { provisionStarterRecipes } from '../recipes/builtins';

/**
 * Identity accepted by both seed entry points, in provider terms rather than
 * Clerk terms: `issuer` is the token issuer the deployment verifies (see
 * auth.config.ts) and `subject` the provider's stable user id. Passing a real
 * developer's pair is what makes the demonstration organization usable by a
 * human who can actually sign in.
 *
 * A supplied `email` is stored as verified: these entry points are internal and
 * run by whoever administers the deployment, so the assertion is theirs, not a
 * caller-claimed address arriving through a public door.
 */
const seedOwnerValidator = v.object({
  issuer: v.string(),
  subject: v.string(),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
});

type SeedOwner = typeof seedOwnerValidator.type;

/**
 * The fallback owner: a synthetic identity nobody can sign in as.
 *
 * It exists for the pure-test path (tests/seed.test.ts drives the seed with no
 * caller), and it is deliberately NOT the recommended way to seed a real
 * deployment — an organization owned by it has no human member, and
 * `addMember` needs an existing admin, so it can never gain one. Real
 * deployments pass `owner`, or repair an already-seeded organization with
 * `grantDemoMembership` below.
 */
const defaultSeedOwner: SeedOwner = {
  issuer: 'https://seed.sancocho.internal',
  subject: 'demonstration-owner',
  name: 'Demonstration Owner',
  email: 'demo-owner@sancocho.invalid',
};

/**
 * The deployment opt-in every entry point below asserts lives in
 * `lib/seedGuard.ts`, because `fields/mutations.ts:createBuiltinFieldDefinition`
 * is a fourth door onto the same irreversible effect and asserts the same switch.
 */

const demonstrationOrganization = { name: 'Sancocho Demonstration', slug: 'sancocho-demo' };
const demonstrationRecipe = { key: 'airportArrivalTransfer', name: 'Airport Arrival Transfer' };
const demonstrationProjectName = 'Airport Arrival Transfers';
const demonstrationEventName = 'LH441 arrival transfer';

/**
 * 2026-06-15T15:40:00Z — the 18:40 local arrival of the demonstration flight at
 * Istanbul Airport (UTC+3), stated as a complete absolute timestamp.
 *
 * Deliberately not midnight and deliberately not a bare wall-clock time: the
 * demonstration exists partly to show the rule that an Event's `startsAt` is an
 * absolute instant, and a wall-clock `18:40` alone could not express it. Written
 * as a literal (not `Date.now()`-relative) so every seeded deployment and every
 * test run agree on the value.
 */
const demonstrationStartsAt = Date.UTC(2026, 5, 15, 15, 40);

/**
 * Internal functions carry no caller token. This adapter supplies a chosen seed
 * identity to the existing domain models, which then apply their normal
 * authentication, authorization, uniqueness and validation rules — the seed adds
 * no parallel write path.
 *
 * The override is constructed member by member rather than spread from `ctx`:
 * a shallow spread copies only own enumerable properties, so anything the real
 * runtime exposes through a prototype or accessor would be silently dropped.
 * Listing the members makes the compiler fail if `MutationCtx` ever grows one.
 */
function withSeedIdentity(ctx: MutationCtx, owner: SeedOwner): MutationCtx {
  const identity: UserIdentity = {
    tokenIdentifier: `${owner.issuer}|${owner.subject}`,
    issuer: owner.issuer,
    subject: owner.subject,
    ...(owner.name === undefined ? {} : { name: owner.name }),
    ...(owner.email === undefined ? {} : { email: owner.email, emailVerified: true }),
  };
  return {
    db: ctx.db,
    auth: { getUserIdentity: async () => identity },
    storage: ctx.storage,
    scheduler: ctx.scheduler,
    runQuery: ctx.runQuery,
    runMutation: ctx.runMutation,
    meta: ctx.meta,
  };
}

/** Creates the deployment-wide built-in catalogue through the field model. */
export const seedBuiltinFieldDefinitions = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    assertSeedingEnabled();
    await ensureBuiltinFieldDefinitions(ctx);
    return null;
  },
});

/**
 * Gives organizations created *before* starter provisioning existed the same
 * built-in catalogue and starter recipes a new organization now receives.
 *
 * `createOrganization` provisions inside its own transaction, so only tenants
 * that predate that change can be missing them; `provisionStarterRecipes` is
 * idempotent per organization, so an already-provisioned tenant is skipped by
 * its own indexed key lookup rather than duplicated.
 *
 * Provisioning is performed as each organization's own owner — resolved from
 * the membership rows — so the recipe models prove a real member's role instead
 * of receiving a bootstrap exception, exactly as they do at creation time. An
 * organization whose owner cannot be resolved is skipped rather than forced.
 *
 * Guarded by the seed opt-in for the same reason as the backfill below: it is a
 * deployment-level administrative operation, and `internalMutation` alone does
 * not stop someone running `convex run --prod`.
 */
export const provisionExistingOrganizations = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    assertSeedingEnabled();
    const fieldIds = await ensureBuiltinFieldDefinitions(ctx);
    // A deployment-wide administrative sweep, deliberately not a tenant-facing
    // read: this is the one place a full organization scan is the correct shape.
    const organizations = await ctx.db.query('organizations').collect();
    for (const organization of organizations) {
      const memberships = await ctx.db
        .query('organizationMemberships')
        .withIndex('by_org_user', (q) => q.eq('organizationId', organization._id))
        .collect();
      const owner = memberships.find((membership) => membership.role === 'owner');
      if (owner === undefined) continue;
      const user = await ctx.db.get(owner.userId);
      if (user === null) continue;
      await provisionStarterRecipes(
        withSeedIdentity(ctx, { issuer: user.authProvider, subject: user.authSubject }),
        organization._id,
        fieldIds,
      );
    }
    return null;
  },
});

/**
 * Backfills the publish time for pre-column recipe versions from the
 * transactionally-recorded publication audit event. This is deliberately
 * guarded by the seed deployment opt-in: it is a deployment-level
 * administrative operation in the same risk class, and internalMutation alone
 * does not guard against someone running `convex run --prod`.
 */
export const backfillRecipeVersionPublishedAt = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    assertSeedingEnabled();
    const versions = await ctx.db.query('recipeVersions').collect();
    for (const version of versions) {
      if ((version.status !== 'published' && version.status !== 'retired') || version.publishedAt !== undefined) continue;
      // This is an entity-scoped indexed read, never an audit-table scan.
      const audits = await ctx.db
        .query('auditEvents')
        .withIndex('by_org_entity', (q) =>
          q.eq('organizationId', version.organizationId).eq('entityType', 'recipeVersion').eq('entityId', version._id),
        )
        .collect();
      const published = audits.find((audit) => audit.action === 'recipeVersion.published');
      if (published !== undefined) await ctx.db.patch(version._id, { publishedAt: published._creationTime });
    }
    return null;
  },
});

/**
 * Backfills normalized search text after introducing the derived column. This
 * is deliberately guarded by the seed deployment opt-in: it is a deployment-
 * level administrative operation in the same risk class, and internalMutation
 * alone does not guard against someone running `convex run --prod`.
 */
export const backfillSearchText = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    assertSeedingEnabled();
    const locations = await ctx.db.query('locations').collect();
    for (const location of locations) {
      const searchText = normalizeSearchText(location.name);
      if (location.searchText !== searchText) await ctx.db.patch(location._id, { searchText });
    }
    const fields = await ctx.db.query('fieldDefinitions').collect();
    for (const field of fields) {
      const searchText = normalizeSearchText(field.key, field.label);
      if (field.searchText !== searchText) await ctx.db.patch(field._id, { searchText });
    }
    return null;
  },
});

function requireFieldId(ids: ReadonlyMap<BuiltinFieldKey, Id<'fieldDefinitions'>>, key: BuiltinFieldKey): Id<'fieldDefinitions'> {
  const id = ids.get(key);
  if (id === undefined) {
    return invalidInput('seedBuiltinFieldMissing', `Seed built-in field is missing: ${key}`);
  }
  return id;
}

/**
 * Seeds one complete, deterministic vertical slice: organization → project →
 * locations → provisioned recipe → published version 1 → typed Event, every step through
 * the ordinary domain models.
 *
 * Idempotent: a re-run stops at the recipe's indexed org/key lookup, so it can
 * never create a second project, location, version or event. The owner of an
 * already-seeded organization is not changed by a re-run with a different
 * `owner` — use `grantDemoMembership` to add a person to an existing demo.
 */
export const seedDemonstrationData = internalMutation({
  args: { owner: v.optional(seedOwnerValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSeedingEnabled();
    const fieldIds = await ensureBuiltinFieldDefinitions(ctx);
    const seededCtx = withSeedIdentity(ctx, args.owner ?? defaultSeedOwner);
    await ensureAuthenticatedUser(seededCtx);

    const existingOrganization = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', demonstrationOrganization.slug))
      .unique();
    if (existingOrganization !== null) {
      const existingRecipe = await ctx.db
        .query('eventRecipes')
        .withIndex('by_org_key', (q) => q.eq('organizationId', existingOrganization._id).eq('key', demonstrationRecipe.key))
        .unique();
      if (existingRecipe !== null) {
        // Provisioning always supplies this recipe; the named project is the
        // seed's durable completion marker. A tenant that merely chose the demo
        // slug has the starter recipe too, but must never receive demo data.
        const projects = await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('organizationId', existingOrganization._id))
          .collect();
        if (projects.some((project) => project.name === demonstrationProjectName)) return null;
      }
      // The slug is a deployment-wide namespace and something else owns it, so
      // there is no organization this seed may write into. Generic conflict:
      // the caller learns the seed cannot proceed, not who holds the slug (I9).
      // Mutations are transactional, so this is never a half-finished seed of
      // ours — it is a genuine collision, resolved by seeding a deployment
      // whose slug is free.
      return conflict();
    }

    const organizationId = await createOrganization(seededCtx, demonstrationOrganization);
    const projectId = await createProject(seededCtx, { organizationId, name: demonstrationProjectName });
    const airportId = await createLocation(seededCtx, {
      organizationId,
      name: 'Airport Terminal 2',
      type: 'airport',
      latitude: 41.2753,
      longitude: 28.7519,
    });
    const hotelId = await createLocation(seededCtx, {
      organizationId,
      name: 'Marriott Hotel',
      type: 'hotel',
      latitude: 41.0122,
      longitude: 28.976,
    });
    const recipe = await ctx.db
      .query('eventRecipes')
      .withIndex('by_org_key', (q) => q.eq('organizationId', organizationId).eq('key', demonstrationRecipe.key))
      .unique();
    if (recipe === null) return conflict();
    const publishedVersion = await ctx.db
      .query('recipeVersions')
      .withIndex('by_recipe_status', (q) => q.eq('recipeId', recipe._id).eq('status', 'published'))
      .unique();
    if (publishedVersion === null) return conflict();
    // Every composed field carries a value, so the demonstration exercises all
    // three text-ish semantic types (text, longText) and both location fields
    // end to end, not just the required four.
    await createEventFromRecipe(seededCtx, {
      projectId,
      recipeVersionId: publishedVersion._id,
      name: demonstrationEventName,
      startsAt: demonstrationStartsAt,
      values: [
        { fieldDefinitionId: requireFieldId(fieldIds, 'pickupLocation'), value: { kind: 'location', locationId: airportId } },
        { fieldDefinitionId: requireFieldId(fieldIds, 'destination'), value: { kind: 'location', locationId: hotelId } },
        { fieldDefinitionId: requireFieldId(fieldIds, 'passengerCount'), value: { kind: 'number', value: 42 } },
        { fieldDefinitionId: requireFieldId(fieldIds, 'flightNumber'), value: { kind: 'text', value: 'LH441' } },
        { fieldDefinitionId: requireFieldId(fieldIds, 'terminal'), value: { kind: 'text', value: 'Terminal 2' } },
        { fieldDefinitionId: requireFieldId(fieldIds, 'luggageCount'), value: { kind: 'number', value: 51 } },
        { fieldDefinitionId: requireFieldId(fieldIds, 'wheelchairCount'), value: { kind: 'number', value: 2 } },
        { fieldDefinitionId: requireFieldId(fieldIds, 'contactPerson'), value: { kind: 'text', value: 'Dana Ruiz' } },
        {
          fieldDefinitionId: requireFieldId(fieldIds, 'notes'),
          value: { kind: 'longText', value: 'Meet arrivals at the Terminal 2 exit; two wheelchair-assisted guests travelling with the group.' },
        },
      ],
    });
    return null;
  },
});

/**
 * Makes a real, sign-in-able person an owner of an already-seeded demonstration
 * organization.
 *
 * This is the repair path for a demo seeded under `defaultSeedOwner`: the
 * organization's only member is then an identity nobody can authenticate as, and
 * `addMember` requires an existing admin+, so no public door can let a human in.
 * The grant is performed AS the default seed owner, which is precisely the
 * situation that needs repairing; a demo seeded with a real `owner` already has
 * a human admin and should use the ordinary `addMember` mutation instead (this
 * function will fail its membership check there, generically, as it should).
 *
 * The target user row is provisioned from the supplied identity, so the person
 * need not have signed in yet: `(authProvider, authSubject)` is the identity
 * key, so their first sign-in resolves to exactly this row.
 */
export const grantDemoMembership = internalMutation({
  args: { owner: seedOwnerValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSeedingEnabled();
    const organization = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', demonstrationOrganization.slug))
      .unique();
    if (organization === null) {
      return invalidInput('seedDemonstrationOrganizationMissing', 'The demonstration organization has not been seeded on this deployment');
    }
    const userId = await ensureAuthenticatedUser(withSeedIdentity(ctx, args.owner));
    await addMember(withSeedIdentity(ctx, defaultSeedOwner), {
      organizationId: organization._id,
      userId,
      role: 'owner',
    });
    return null;
  },
});
