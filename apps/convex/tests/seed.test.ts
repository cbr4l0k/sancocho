import { convexTest, type TestConvex } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { capabilitiesForField } from '../convex/fields/model';
import { enableSeedMutations, modules, seedOptInVariable } from './helpers';

// Deployment environment variables reach Convex functions through `process.env`;
// declared locally because this package carries no Node type dependency.
declare const process: { env: Record<string, string | undefined> };

const seedBuiltinFieldDefinitions = internal.seed.mutations.seedBuiltinFieldDefinitions;
const seedDemonstrationData = internal.seed.mutations.seedDemonstrationData;
const grantDemoMembership = internal.seed.mutations.grantDemoMembership;
const createBuiltinFieldDefinition = internal.fields.mutations.createBuiltinFieldDefinition;
const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const getEvent = api.events.queries.getEvent;
const getRecipeVersion = api.recipes.queries.getRecipeVersion;
const listProjectEvents = api.events.queries.listProjectEvents;
const listRecipes = api.recipes.queries.listRecipes;
const addRecipeField = api.recipes.fields.mutations.addRecipeField;

const issuer = 'https://seed.priamo.internal';
const subject = 'demonstration-owner';
const ownerIdentity = { issuer, subject, name: 'Demonstration Owner', email: 'demo-owner@priamo.invalid', emailVerified: true };

/**
 * 2026-06-15T15:40:00Z: the demonstration flight's 18:40 local arrival as a
 * complete absolute timestamp. Written as a literal rather than imported from
 * the seed so that a change to the seeded instant has to be made deliberately in
 * both places (I3's temporal rule is the point of the seeded Event).
 */
const expectedStartsAt = 1_781_538_000_000;

/** The issue #14 catalogue, in its tabulated order — key, label, data type, semantics, capabilities. */
const builtinCatalogue = [
  { key: 'passengerCount', label: 'Passenger Count', semanticType: 'passenger.count', config: { kind: 'number', min: 0, integer: true }, capabilities: ['passengerTotals', 'occupancyMetrics', 'capacityValidation'] },
  { key: 'pickupLocation', label: 'Pickup Location', semanticType: 'transport.origin', config: { kind: 'location' }, capabilities: [] },
  { key: 'destination', label: 'Destination', semanticType: 'transport.destination', config: { kind: 'location' }, capabilities: [] },
  { key: 'flightNumber', label: 'Flight Number', semanticType: 'aviation.flightNumber', config: { kind: 'text' }, capabilities: ['flightTracking'] },
  { key: 'luggageCount', label: 'Luggage Count', semanticType: 'luggage.count', config: { kind: 'number', min: 0, integer: true }, capabilities: [] },
  { key: 'wheelchairCount', label: 'Wheelchair Count', semanticType: 'accessibility.wheelchairCount', config: { kind: 'number', min: 0, integer: true }, capabilities: ['accessibilityRequirements'] },
  { key: 'contactPerson', label: 'Contact Person', semanticType: 'contact.primary', config: { kind: 'text' }, capabilities: [] },
  { key: 'terminal', label: 'Terminal', semanticType: 'aviation.terminal', config: { kind: 'text' }, capabilities: [] },
  { key: 'notes', label: 'Notes', semanticType: 'general.notes', config: { kind: 'longText' }, capabilities: [] },
] as const;

const catalogueOrder: readonly string[] = builtinCatalogue.map((field) => field.key);

/**
 * The Airport Arrival Transfer composition as issue #14 specifies it: position,
 * field key, and required flag together.
 *
 * Asserting the TRIPLE is what makes this load-bearing. Position and required
 * flags freeze at publish (I2), so a composition that lands in catalogue order,
 * or that derives `required` from an array index, is unfixable in place — and a
 * {position, required} assertion alone cannot see either mistake.
 */
const expectedComposition = [
  { position: 0, key: 'pickupLocation', required: true },
  { position: 1, key: 'destination', required: true },
  { position: 2, key: 'passengerCount', required: true },
  { position: 3, key: 'flightNumber', required: true },
  { position: 4, key: 'terminal', required: false },
  { position: 5, key: 'luggageCount', required: false },
  { position: 6, key: 'wheelchairCount', required: false },
  { position: 7, key: 'contactPerson', required: false },
  { position: 8, key: 'notes', required: false },
];

enableSeedMutations();

type SeedTest = TestConvex<typeof schema>;

async function readBuiltins(t: SeedTest): Promise<Doc<'fieldDefinitions'>[]> {
  const fields = await t.run(async (ctx) =>
    ctx.db.query('fieldDefinitions').withIndex('by_org_key', (q) => q.eq('organizationId', undefined)).collect(),
  );
  return fields.sort((left, right) => catalogueOrder.indexOf(left.key) - catalogueOrder.indexOf(right.key));
}

/** The seeded slice, read straight from the database rather than through a query. */
async function readDemonstration(t: SeedTest) {
  return t.run(async (ctx) => {
    const organization = await ctx.db.query('organizations').withIndex('by_slug', (q) => q.eq('slug', 'priamo-demo')).unique();
    if (organization === null) throw new Error('Expected demonstration organization');
    const memberships = await ctx.db.query('organizationMemberships').withIndex('by_org_user', (q) => q.eq('organizationId', organization._id)).collect();
    const projects = await ctx.db.query('projects').withIndex('by_org', (q) => q.eq('organizationId', organization._id)).collect();
    const locations = await ctx.db.query('locations').withIndex('by_org', (q) => q.eq('organizationId', organization._id)).collect();
    const recipe = await ctx.db.query('eventRecipes').withIndex('by_org_key', (q) => q.eq('organizationId', organization._id).eq('key', 'airportArrivalTransfer')).unique();
    if (recipe === null) throw new Error('Expected demonstration recipe');
    const version = await ctx.db.query('recipeVersions').withIndex('by_recipe_version', (q) => q.eq('recipeId', recipe._id)).unique();
    if (version === null) throw new Error('Expected demonstration version');
    const fields = await ctx.db.query('recipeFields').withIndex('by_version', (q) => q.eq('recipeVersionId', version._id)).collect();
    const composition = await Promise.all(
      fields
        .sort((left, right) => left.position - right.position)
        .map(async (field) => {
          const definition = await ctx.db.get(field.fieldDefinitionId);
          if (definition === null) throw new Error('Expected a definition behind every composed recipe field');
          return { position: field.position, key: definition.key, required: field.required };
        }),
    );
    const events = await ctx.db.query('events').withIndex('by_recipeVersion', (q) => q.eq('recipeVersionId', version._id)).collect();
    return { organization, memberships, projects, locations, recipe, version, fields, composition, events };
  });
}

async function countRows(t: SeedTest) {
  return t.run(async (ctx) => ({
    users: (await ctx.db.query('users').collect()).length,
    organizations: (await ctx.db.query('organizations').collect()).length,
    organizationMemberships: (await ctx.db.query('organizationMemberships').collect()).length,
    projects: (await ctx.db.query('projects').collect()).length,
    locations: (await ctx.db.query('locations').collect()).length,
    fieldDefinitions: (await ctx.db.query('fieldDefinitions').collect()).length,
    recipes: (await ctx.db.query('eventRecipes').collect()).length,
    versions: (await ctx.db.query('recipeVersions').collect()).length,
    recipeFields: (await ctx.db.query('recipeFields').collect()).length,
    events: (await ctx.db.query('events').collect()).length,
    eventFieldValues: (await ctx.db.query('eventFieldValues').collect()).length,
  }));
}

test('built-in seed creates the issue catalogue exactly once, with the capabilities the registry derives', async () => {
  const t = convexTest(schema, modules);
  await t.mutation(seedBuiltinFieldDefinitions, {});
  await t.mutation(seedBuiltinFieldDefinitions, {});

  const fields = await readBuiltins(t);
  expect(fields).toHaveLength(9);
  expect(fields.map((field) => ({ key: field.key, label: field.label, dataType: field.config.kind, semanticType: field.semanticType, config: field.config }))).toEqual(
    builtinCatalogue.map((row) => ({ key: row.key, label: row.label, dataType: row.config.kind, semanticType: row.semanticType, config: row.config })),
  );
  // Capabilities are code-owned: every seeded semantic type must resolve to
  // exactly the row the issue tabulates, and to nothing the seed itself states.
  expect(fields.map((field) => capabilitiesForField(field))).toEqual(builtinCatalogue.map((row) => row.capabilities));
  expect(fields.every((field) => field.scope === 'builtin' && field.organizationId === undefined && field.status === 'active')).toBe(true);
});

test('seeding is refused unless the deployment opted in, on all four irreversible doors', async () => {
  delete process.env[seedOptInVariable];
  const t = convexTest(schema, modules);
  const builtinField = { key: 'squatted', label: 'Squatted', config: { kind: 'text' } as const };
  await expect(t.mutation(seedDemonstrationData, {})).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
  await expect(t.mutation(seedBuiltinFieldDefinitions, {})).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
  await expect(t.mutation(grantDemoMembership, { owner: { issuer, subject } })).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
  // The fourth door: creating ONE built-in has the same irreversible effect as
  // seeding the catalogue — the key is squatted in every tenant's namespace and
  // cannot be released — so being an internal function is not the guard.
  await expect(t.mutation(createBuiltinFieldDefinition, builtinField)).rejects.toMatchObject({ data: { code: 'seedDisabled' } });
  // The refusal is total: not one built-in key is squatted on the deployment.
  expect(await readBuiltins(t)).toHaveLength(0);

  // The same call succeeds once the deployment says yes, so the rejections above
  // are the opt-in and not a broken argument.
  process.env[seedOptInVariable] = 'true';
  await expect(t.mutation(createBuiltinFieldDefinition, builtinField)).resolves.toBeDefined();
});

test('demonstration seed makes one published, immutable airport-transfer vertical slice', async () => {
  const t = convexTest(schema, modules);
  await t.mutation(seedDemonstrationData, {});

  const snapshot = await readDemonstration(t);
  expect(snapshot.memberships).toHaveLength(1);
  expect(snapshot.memberships[0]).toMatchObject({ organizationId: snapshot.organization._id, role: 'owner' });
  expect(snapshot.projects).toHaveLength(1);
  // Locations are deterministic placeholder reference data: type and
  // coordinates are part of the demonstration, not decoration.
  expect(snapshot.locations.map((location) => ({ name: location.name, type: location.type, latitude: location.latitude, longitude: location.longitude })).sort((left, right) => left.name.localeCompare(right.name))).toEqual([
    { name: 'Airport Terminal 2', type: 'airport', latitude: 41.2753, longitude: 28.7519 },
    { name: 'Marriott Hotel', type: 'hotel', latitude: 41.0122, longitude: 28.976 },
  ]);
  expect(snapshot.recipe).toMatchObject({ key: 'airportArrivalTransfer', name: 'Airport Arrival Transfer', status: 'active' });
  expect(snapshot.version).toMatchObject({ versionNumber: 1, status: 'published', recipeId: snapshot.recipe._id });
  expect(snapshot.composition).toEqual(expectedComposition);
  expect(snapshot.fields.every((field) => field.visible)).toBe(true);
  expect(snapshot.events).toHaveLength(1);

  const event = snapshot.events[0];
  if (event === undefined) throw new Error('Expected demonstration event');
  expect(event).toMatchObject({
    name: 'LH441 arrival transfer',
    status: 'draft',
    // Derived server-side from the version, never supplied by the seed (I4).
    recipeId: snapshot.recipe._id,
    projectId: snapshot.projects[0]?._id,
    organizationId: snapshot.organization._id,
  });
  // The headline temporal rule: an absolute instant, not a bare wall-clock time.
  expect(Number.isFinite(event.startsAt)).toBe(true);
  expect(event.startsAt).toBe(expectedStartsAt);
  expect(event.endsAt).toBeUndefined();

  const client = t.withIdentity(ownerIdentity);
  const result = await client.query(getEvent, { eventId: event._id });
  const airport = snapshot.locations.find((location) => location.type === 'airport');
  const hotel = snapshot.locations.find((location) => location.type === 'hotel');
  if (airport === undefined || hotel === undefined) throw new Error('Expected both seeded locations');
  // Exactly nine values — one per composed field, so text, longText, number and
  // location all travel the typed path end to end — joined with their live labels.
  expect(result.values).toHaveLength(9);
  expect(Object.fromEntries(result.values.map((value) => [value.key, { label: value.label, value: value.value }]))).toEqual({
    pickupLocation: { label: 'Pickup Location', value: { kind: 'location', locationId: airport._id } },
    destination: { label: 'Destination', value: { kind: 'location', locationId: hotel._id } },
    passengerCount: { label: 'Passenger Count', value: { kind: 'number', value: 42 } },
    flightNumber: { label: 'Flight Number', value: { kind: 'text', value: 'LH441' } },
    terminal: { label: 'Terminal', value: { kind: 'text', value: 'Terminal 2' } },
    luggageCount: { label: 'Luggage Count', value: { kind: 'number', value: 51 } },
    wheelchairCount: { label: 'Wheelchair Count', value: { kind: 'number', value: 2 } },
    contactPerson: { label: 'Contact Person', value: { kind: 'text', value: 'Dana Ruiz' } },
    notes: { label: 'Notes', value: { kind: 'longText', value: 'Meet arrivals at the Terminal 2 exit; two wheelchair-assisted guests travelling with the group.' } },
  });

  // The seeded data is reachable through the ordinary paginated public queries,
  // not only through direct database reads.
  const events = await client.query(listProjectEvents, { projectId: event.projectId, paginationOpts: { numItems: 10, cursor: null } });
  expect(events.page.map((row) => row._id)).toEqual([event._id]);
  expect(events.isDone).toBe(true);
  const recipes = await client.query(listRecipes, { organizationId: snapshot.organization._id, paginationOpts: { numItems: 10, cursor: null } });
  expect(recipes.page.map((row) => ({ key: row.key, status: row.status })).sort((left, right) => left.key.localeCompare(right.key))).toEqual([
    { key: 'airportArrivalTransfer', status: 'active' },
    { key: 'airportDepartureTransfer', status: 'active' },
    { key: 'pointToPointTransfer', status: 'active' },
    { key: 'shuttleService', status: 'active' },
  ]);

  const recipeVersion = await client.query(getRecipeVersion, { recipeVersionId: snapshot.version._id });
  await expect(client.mutation(addRecipeField, {
    recipeVersionId: snapshot.version._id,
    fieldDefinitionId: recipeVersion.recipeFields[0]?.fieldDefinitionId ?? (() => { throw new Error('Expected recipe field'); })(),
    required: false,
    visible: true,
  })).rejects.toMatchObject({ data: { code: 'recipeVersionNotDraft' } });

  // Re-running writes nothing new anywhere: the counts cover every table the
  // seed touches, including the ones a duplicate user or membership would show up in.
  await t.mutation(seedDemonstrationData, {});
  expect(await countRows(t)).toEqual({
    users: 1,
    organizations: 1,
    organizationMemberships: 1,
    projects: 1,
    locations: 2,
    fieldDefinitions: 9,
    recipes: 4,
    versions: 4,
    recipeFields: 29,
    events: 1,
    eventFieldValues: 9,
  });
  expect((await readDemonstration(t)).composition).toEqual(expectedComposition);
});

test('the demonstration seed reuses built-ins that already exist instead of duplicating them', async () => {
  const t = convexTest(schema, modules);
  // Branch one of `builtinFieldIds`: the catalogue is already present, so the
  // demo must adopt those exact definition ids. (Branch two — creating them
  // inline — is what the previous test exercises.)
  await t.mutation(seedBuiltinFieldDefinitions, {});
  const before = await readBuiltins(t);
  await t.mutation(seedDemonstrationData, {});
  const after = await readBuiltins(t);

  expect(after.map((field) => field._id)).toEqual(before.map((field) => field._id));
  const snapshot = await readDemonstration(t);
  expect(snapshot.composition).toEqual(expectedComposition);
  const composed = new Set<Id<'fieldDefinitions'>>(snapshot.fields.map((field) => field.fieldDefinitionId));
  expect(before.every((field) => composed.has(field._id))).toBe(true);
  expect((await countRows(t)).fieldDefinitions).toBe(9);
});

test('demonstration entities stay invisible to identities without a membership', async () => {
  const t = convexTest(schema, modules);
  await t.mutation(seedDemonstrationData, {});
  const snapshot = await readDemonstration(t);
  const event = snapshot.events[0];
  if (event === undefined) throw new Error('Expected demonstration event');

  // A real deployment's developers are exactly this caller until the demo is
  // seeded with (or granted to) their own identity — the reason the owner is a
  // parameter rather than a fabricated issuer.
  const outsider = t.withIdentity({ issuer: 'https://example.clerk.accounts.dev', subject: 'outsider', name: 'Outsider' });
  await outsider.mutation(ensureUser, {});
  await expect(outsider.query(getEvent, { eventId: event._id })).rejects.toMatchObject({ data: { code: 'notFoundOrInaccessible' } });
  await expect(outsider.query(getRecipeVersion, { recipeVersionId: snapshot.version._id })).rejects.toMatchObject({ data: { code: 'notFoundOrInaccessible' } });
});

test('a real identity can own the demonstration, before or after it is seeded', async () => {
  const t = convexTest(schema, modules);
  const clerkIssuer = 'https://example.clerk.accounts.dev';
  await t.mutation(seedDemonstrationData, { owner: { issuer: clerkIssuer, subject: 'real-developer', name: 'Real Developer' } });

  const developer = t.withIdentity({ issuer: clerkIssuer, subject: 'real-developer', name: 'Real Developer' });
  const snapshot = await readDemonstration(t);
  const event = snapshot.events[0];
  if (event === undefined) throw new Error('Expected demonstration event');
  await expect(developer.query(getEvent, { eventId: event._id })).resolves.toMatchObject({ event: { _id: event._id } });
  // No synthetic seed identity was provisioned: the demo's only member is a
  // person who can actually sign in.
  const users = await t.run((ctx) => ctx.db.query('users').collect());
  expect(users.map((user) => ({ provider: user.authProvider, subject: user.authSubject }))).toEqual([{ provider: clerkIssuer, subject: 'real-developer' }]);

  // The repair path for a demo seeded under the default owner.
  const other = convexTest(schema, modules);
  await other.mutation(seedDemonstrationData, {});
  await other.mutation(grantDemoMembership, { owner: { issuer: clerkIssuer, subject: 'late-arrival', name: 'Late Arrival' } });
  const otherSnapshot = await readDemonstration(other);
  const otherEvent = otherSnapshot.events[0];
  if (otherEvent === undefined) throw new Error('Expected demonstration event');
  const lateArrival = other.withIdentity({ issuer: clerkIssuer, subject: 'late-arrival', name: 'Late Arrival' });
  await expect(lateArrival.query(getEvent, { eventId: otherEvent._id })).resolves.toMatchObject({ event: { _id: otherEvent._id } });
  expect(otherSnapshot.memberships.map((membership) => membership.role)).toEqual(['owner', 'owner']);
});

test('the seed refuses to write into an organization that already owns the demonstration slug', async () => {
  const t = convexTest(schema, modules);
  const squatter = t.withIdentity({ issuer: 'https://example.clerk.accounts.dev', subject: 'squatter', name: 'Squatter' });
  await squatter.mutation(ensureUser, {});
  await squatter.mutation(createOrganization, { name: 'Someone Else', slug: 'priamo-demo' });

  // Generic conflict: the seed cannot proceed, and says nothing about who holds
  // the deployment-wide slug (I9).
  await expect(t.mutation(seedDemonstrationData, {})).rejects.toMatchObject({ data: { code: 'conflict' } });
  const counts = await countRows(t);
  expect(counts).toMatchObject({ organizations: 1, projects: 0, recipes: 4, events: 0 });
});
