import type { UserIdentity } from 'convex/server';
import { v } from 'convex/values';

import { ensureAuthenticatedUser } from '../auth/model';
import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { createEventFromRecipe } from '../events/model';
import { createBuiltinFieldDefinition } from '../fields/model';
import { conflict, invalidInput } from '../lib/errors';
import { assertSeedingEnabled } from '../lib/seedGuard';
import { createLocation } from '../locations/model';
import { addMember, createOrganization } from '../organizations/model';
import { createProject } from '../projects/model';
import { addRecipeField } from '../recipes/fields/model';
import { createInitialDraftVersion, createRecipe, publishRecipeVersion } from '../recipes/model';
import type { fieldConfigValidator, SemanticType } from '../validators';

type FieldConfig = typeof fieldConfigValidator.type;

type BuiltinSeed = {
  key: string;
  label: string;
  semanticType: SemanticType;
  config: FieldConfig;
};

/**
 * The deployment-wide built-in catalogue, in the order issue #14 tabulates it.
 *
 * These rows are effectively permanent. A built-in key squats the key namespace
 * of EVERY tenant in the deployment (see the shadow probe in
 * fields/model.ts `assertKeyAvailable`), and once the demonstration version is
 * published `isReferencedByPublishedVersion` freezes each key, semanticType and
 * config for good (I2/I3). A typo shipped once can never be corrected in place —
 * so this array must be read against the issue's table, not adjusted casually.
 *
 * DECLARATION ORDER IS NOT COMPOSITION ORDER: the recipe's field order and
 * required flags live in `demonstrationComposition` below.
 */
const builtinFields = [
  { key: 'passengerCount', label: 'Passenger Count', semanticType: 'passenger.count', config: { kind: 'number', min: 0, integer: true } },
  { key: 'pickupLocation', label: 'Pickup Location', semanticType: 'transport.origin', config: { kind: 'location' } },
  { key: 'destination', label: 'Destination', semanticType: 'transport.destination', config: { kind: 'location' } },
  { key: 'flightNumber', label: 'Flight Number', semanticType: 'aviation.flightNumber', config: { kind: 'text' } },
  { key: 'luggageCount', label: 'Luggage Count', semanticType: 'luggage.count', config: { kind: 'number', min: 0, integer: true } },
  { key: 'wheelchairCount', label: 'Wheelchair Count', semanticType: 'accessibility.wheelchairCount', config: { kind: 'number', min: 0, integer: true } },
  { key: 'contactPerson', label: 'Contact Person', semanticType: 'contact.primary', config: { kind: 'text' } },
  { key: 'terminal', label: 'Terminal', semanticType: 'aviation.terminal', config: { kind: 'text' } },
  { key: 'notes', label: 'Notes', semanticType: 'general.notes', config: { kind: 'longText' } },
] as const satisfies readonly BuiltinSeed[];

type BuiltinKey = (typeof builtinFields)[number]['key'];

/**
 * The Airport Arrival Transfer composition: position IS this array's index and
 * `required` is stated per entry.
 *
 * Both are frozen the moment version 1 publishes (I2), and neither may be
 * derived from `builtinFields`' order — that coupling is exactly how a
 * catalogue reordering would silently rewrite which fields a published recipe
 * requires. The two lists are independent on purpose; `BuiltinKey` keeps them
 * referentially honest at compile time.
 */
const demonstrationComposition: readonly { key: BuiltinKey; required: boolean }[] = [
  { key: 'pickupLocation', required: true },
  { key: 'destination', required: true },
  { key: 'passengerCount', required: true },
  { key: 'flightNumber', required: true },
  { key: 'terminal', required: false },
  { key: 'luggageCount', required: false },
  { key: 'wheelchairCount', required: false },
  { key: 'contactPerson', required: false },
  { key: 'notes', required: false },
];

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

async function findBuiltinField(ctx: MutationCtx, key: string): Promise<Doc<'fieldDefinitions'> | null> {
  return ctx.db
    .query('fieldDefinitions')
    .withIndex('by_org_key', (q) => q.eq('organizationId', undefined).eq('key', key))
    .unique();
}

async function builtinFieldIds(ctx: MutationCtx): Promise<Map<string, Id<'fieldDefinitions'>>> {
  const ids = new Map<string, Id<'fieldDefinitions'>>();
  for (const field of builtinFields) {
    const existing = await findBuiltinField(ctx, field.key);
    if (existing === null) {
      ids.set(field.key, await createBuiltinFieldDefinition(ctx, field));
    } else {
      ids.set(field.key, existing._id);
    }
  }
  return ids;
}

/** Creates the deployment-wide built-in catalogue through the field model. */
export const seedBuiltinFieldDefinitions = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    assertSeedingEnabled();
    await builtinFieldIds(ctx);
    return null;
  },
});

function requireFieldId(ids: ReadonlyMap<string, Id<'fieldDefinitions'>>, key: BuiltinKey): Id<'fieldDefinitions'> {
  const id = ids.get(key);
  if (id === undefined) {
    return invalidInput(`Seed built-in field is missing: ${key}`);
  }
  return id;
}

/**
 * Seeds one complete, deterministic vertical slice: organization → project →
 * locations → recipe → published version 1 → typed Event, every step through
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
    const fieldIds = await builtinFieldIds(ctx);
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
      if (existingRecipe !== null) return null;
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
    const recipeId = await createRecipe(seededCtx, { organizationId, ...demonstrationRecipe });
    const recipeVersionId = await createInitialDraftVersion(seededCtx, recipeId);

    for (const [position, entry] of demonstrationComposition.entries()) {
      await addRecipeField(seededCtx, {
        recipeVersionId,
        fieldDefinitionId: requireFieldId(fieldIds, entry.key),
        required: entry.required,
        visible: true,
        position,
      });
    }
    await publishRecipeVersion(seededCtx, recipeVersionId);
    // Every composed field carries a value, so the demonstration exercises all
    // three text-ish semantic types (text, longText) and both location fields
    // end to end, not just the required four.
    await createEventFromRecipe(seededCtx, {
      projectId,
      recipeVersionId,
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
      return invalidInput('The demonstration organization has not been seeded on this deployment');
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
