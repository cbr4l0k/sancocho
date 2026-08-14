import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProject = api.projects.mutations.createProject;
const updateProject = api.projects.mutations.updateProject;
const archiveProject = api.projects.mutations.archiveProject;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const updateFieldDefinition = api.fields.mutations.updateFieldDefinition;
const archiveFieldDefinition = api.fields.mutations.archiveFieldDefinition;
const createRecipe = api.recipes.mutations.createRecipe;
const archiveRecipe = api.recipes.mutations.archiveRecipe;
const createInitialDraftVersion = api.recipes.mutations.createInitialDraftVersion;
const clonePublishedVersionToDraft = api.recipes.mutations.clonePublishedVersionToDraft;
const publishRecipeVersion = api.recipes.mutations.publishRecipeVersion;
const addRecipeField = api.recipes.fields.mutations.addRecipeField;
const updateRecipeField = api.recipes.fields.mutations.updateRecipeField;
const listRecipeFields = api.recipes.fields.queries.listRecipeFields;
const createLocation = api.locations.mutations.createLocation;
const archiveLocation = api.locations.mutations.archiveLocation;
const createEventFromRecipe = api.events.mutations.createEventFromRecipe;
const updateEventCoreFields = api.events.mutations.updateEventCoreFields;
const updateEventFields = api.events.mutations.updateEventFields;
const changeEventStatus = api.events.mutations.changeEventStatus;
const getEvent = api.events.queries.getEvent;
const listProjectEvents = api.events.queries.listProjectEvents;

const issuer = 'https://example.clerk.accounts.dev';
const inaccessible = 'Not found or inaccessible';
const unauthenticated = 'Unauthenticated';
const firstPage = { numItems: 10, cursor: null };

/** The stored typed-value union, reused for the submission tables below. */
type FieldValue = Doc<'eventFieldValues'>['value'];
type SubmittedValue = { fieldDefinitionId: Id<'fieldDefinitions'>; value: FieldValue };
type ClearableValue = { fieldDefinitionId: Id<'fieldDefinitions'>; value: FieldValue | null };
/** Schema-aware test handle, so `t.run` fixtures can use the real table indexes. */
type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId = await client.mutation(ensureUser, {});
  return { client, userId };
}

/**
 * One published recipe version composing every data type, so the validation
 * matrix exercises real snapshots rather than hand-inserted rows. `code` is the
 * only required field; every other field is optional, which is what lets each
 * test submit exactly the one value it is about.
 */
async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'events-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Events', slug: 'events-fixture' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Event project' });
  const locationId = await owner.client.mutation(createLocation, { organizationId, name: 'Main venue', type: 'venue' });

  const field = (key: string, label: string, config: Doc<'fieldDefinitions'>['config']) =>
    owner.client.mutation(createFieldDefinition, { organizationId, key, label, config });
  const definitions = {
    code: await field('code', 'Code', { kind: 'text', minLength: 2, maxLength: 5 }),
    notes: await field('notes', 'Notes', { kind: 'longText', minLength: 3, maxLength: 10 }),
    seats: await field('seats', 'Seats', { kind: 'number', min: 1, max: 10, integer: true }),
    vip: await field('vip', 'VIP', { kind: 'boolean' }),
    day: await field('day', 'Day', { kind: 'date', min: '2026-01-01', max: '2026-12-31' }),
    pickup: await field('pickup', 'Pickup', { kind: 'time', min: '06:00', max: '22:00' }),
    at: await field('at', 'At', { kind: 'datetime', min: 0, max: 1000 }),
    tier: await field('tier', 'Tier', { kind: 'select', options: [{ id: 'gold', label: 'Gold' }, { id: 'silver', label: 'Silver' }] }),
    extras: await field('extras', 'Extras', {
      kind: 'multiSelect',
      options: [{ id: 'wifi', label: 'Wifi' }, { id: 'water', label: 'Water' }, { id: 'snack', label: 'Snack' }],
      minSelections: 1,
      maxSelections: 2,
    }),
    venue: await field('venue', 'Venue', { kind: 'location' }),
  };

  const recipeId = await owner.client.mutation(createRecipe, { organizationId, key: 'eventPlan', name: 'Event plan' });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  for (const [key, fieldDefinitionId] of Object.entries(definitions)) {
    await owner.client.mutation(addRecipeField, { recipeVersionId: versionId, fieldDefinitionId, required: key === 'code', visible: true });
  }
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: versionId });

  /** The required value every valid creation must carry. */
  const requiredCode: SubmittedValue = { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'AB' } };
  const createEvent = (values: SubmittedValue[] = [requiredCode], overrides: { name?: string; startsAt?: number; endsAt?: number } = {}) =>
    owner.client.mutation(createEventFromRecipe, {
      projectId,
      recipeVersionId: versionId,
      name: overrides.name ?? 'Arrival',
      startsAt: overrides.startsAt ?? 1000,
      ...(overrides.endsAt === undefined ? {} : { endsAt: overrides.endsAt }),
      values,
    });

  return { t, owner, organizationId, projectId, recipeId, versionId, locationId, definitions, requiredCode, createEvent };
}

test('creation is gated on version status, recipe and project lifecycle, and tenant ownership', async () => {
  const { t, owner, organizationId, projectId, recipeId, versionId, requiredCode, createEvent } = await fixture();
  const values = [requiredCode];

  // A draft version has not frozen its rules yet, so it can never back an Event.
  const draftVersionId = await owner.client.mutation(clonePublishedVersionToDraft, { recipeId });
  await expect(
    owner.client.mutation(createEventFromRecipe, { projectId, recipeVersionId: draftVersionId, name: 'Arrival', startsAt: 1000, values }),
  ).rejects.toMatchObject({ data: 'Events require a published version of an active recipe' });

  // Publishing the clone retires v1; a retired version stays readable and keeps
  // validating its own events, but is no longer a source of new ones.
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: draftVersionId });
  await expect(createEvent(values)).rejects.toMatchObject({ data: 'Events require a published version of an active recipe' });
  await expect(
    owner.client.mutation(createEventFromRecipe, { projectId, recipeVersionId: draftVersionId, name: 'Arrival', startsAt: 1000, values }),
  ).resolves.toBeDefined();

  // Archiving the recipe retires its published version in the same transaction.
  await owner.client.mutation(archiveRecipe, { recipeId });
  await expect(
    owner.client.mutation(createEventFromRecipe, { projectId, recipeVersionId: draftVersionId, name: 'Arrival', startsAt: 1000, values }),
  ).rejects.toMatchObject({ data: 'Events require a published version of an active recipe' });

  // A recipe version belonging to another tenant is opaque even to a member of
  // both organizations: the project and the version must agree (I1/I9).
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'events-foreign-create' });
  const foreignRecipeId = await owner.client.mutation(createRecipe, { organizationId: foreignOrganizationId, key: 'eventPlan', name: 'Theirs' });
  const foreignVersionId = await owner.client.mutation(createInitialDraftVersion, { recipeId: foreignRecipeId });
  const foreignField = await owner.client.mutation(createFieldDefinition, {
    organizationId: foreignOrganizationId,
    key: 'code',
    label: 'Code',
    config: { kind: 'text' },
  });
  await owner.client.mutation(addRecipeField, { recipeVersionId: foreignVersionId, fieldDefinitionId: foreignField, required: false, visible: true });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: foreignVersionId });
  await expect(
    owner.client.mutation(createEventFromRecipe, { projectId, recipeVersionId: foreignVersionId, name: 'Arrival', startsAt: 1000, values: [] }),
  ).rejects.toMatchObject({ data: inaccessible });

  // Project lifecycle: a completed project takes no new events, an archived one
  // takes none either (and freezes the ones it has — see the F2 regression test).
  const completedProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Completed' });
  await owner.client.mutation(updateProject, { projectId: completedProjectId, status: 'completed' });
  const archivedProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Archived' });
  await owner.client.mutation(archiveProject, { projectId: archivedProjectId });
  for (const closedProjectId of [completedProjectId, archivedProjectId]) {
    await expect(
      owner.client.mutation(createEventFromRecipe, { projectId: closedProjectId, recipeVersionId: versionId, name: 'Arrival', startsAt: 1000, values }),
    ).rejects.toMatchObject({ data: 'Only draft and active projects can receive new events' });
  }

  await t.run(async (ctx) => {
    expect(await ctx.db.query('events').withIndex('by_project', (q) => q.eq('projectId', completedProjectId)).collect()).toHaveLength(0);
  });
});

test('every public event function is opaque to unauthenticated, fabricated, foreign, and non-member callers', async () => {
  const { t, owner, organizationId, projectId, versionId, requiredCode, createEvent } = await fixture();
  const outsider = await provision(t, 'events-outsider');
  const eventId = await createEvent();

  const missingEventId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('events', {
      organizationId,
      projectId,
      recipeId: (await ctx.db.get(eventId))?.recipeId ?? (() => { throw new Error('event missing'); })(),
      recipeVersionId: versionId,
      name: 'Temporary',
      status: 'draft',
      startsAt: 1,
    });
    await ctx.db.delete(id);
    return id;
  });
  const missingProjectId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('projects', { organizationId, name: 'Temporary', status: 'draft' });
    await ctx.db.delete(id);
    return id;
  });

  // Unauthenticated: identical error for real and fabricated ids, on all six.
  for (const id of [eventId, missingEventId]) {
    await expect(t.query(getEvent, { eventId: id })).rejects.toMatchObject({ data: unauthenticated });
    await expect(t.mutation(updateEventCoreFields, { eventId: id, name: 'Nope' })).rejects.toMatchObject({ data: unauthenticated });
    await expect(t.mutation(updateEventFields, { eventId: id, values: [] })).rejects.toMatchObject({ data: unauthenticated });
    await expect(t.mutation(changeEventStatus, { eventId: id, status: 'planned' })).rejects.toMatchObject({ data: unauthenticated });
  }
  for (const id of [projectId, missingProjectId]) {
    await expect(t.query(listProjectEvents, { projectId: id, paginationOpts: firstPage })).rejects.toMatchObject({ data: unauthenticated });
    await expect(
      t.mutation(createEventFromRecipe, { projectId: id, recipeVersionId: versionId, name: 'Nope', startsAt: 1, values: [requiredCode] }),
    ).rejects.toMatchObject({ data: unauthenticated });
  }

  // A user with no membership anywhere gets the same generic error for a real
  // event as for one that never existed (I9).
  for (const id of [eventId, missingEventId]) {
    await expect(outsider.client.query(getEvent, { eventId: id })).rejects.toMatchObject({ data: inaccessible });
    await expect(outsider.client.mutation(updateEventCoreFields, { eventId: id, name: 'Nope' })).rejects.toMatchObject({ data: inaccessible });
    await expect(outsider.client.mutation(updateEventFields, { eventId: id, values: [] })).rejects.toMatchObject({ data: inaccessible });
    await expect(outsider.client.mutation(changeEventStatus, { eventId: id, status: 'planned' })).rejects.toMatchObject({ data: inaccessible });
  }
  for (const id of [projectId, missingProjectId]) {
    await expect(outsider.client.query(listProjectEvents, { projectId: id, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });
    await expect(
      outsider.client.mutation(createEventFromRecipe, { projectId: id, recipeVersionId: versionId, name: 'Nope', startsAt: 1, values: [requiredCode] }),
    ).rejects.toMatchObject({ data: inaccessible });
  }

  // A member of another organization is exactly as blind as a stranger.
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'events-foreign-probe' });
  await owner.client.mutation(addMember, { organizationId: foreignOrganizationId, userId: outsider.userId, role: 'owner' });
  await expect(outsider.client.query(getEvent, { eventId })).rejects.toMatchObject({ data: inaccessible });
  await expect(outsider.client.query(listProjectEvents, { projectId, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });
});

test('event authoring is planner+, running an event is open to operators, and reading is open to any member', async () => {
  const { t, owner, organizationId, projectId, versionId, requiredCode, createEvent } = await fixture();
  const viewer = await provision(t, 'events-viewer');
  const operator = await provision(t, 'events-operator');
  const planner = await provision(t, 'events-planner');
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  await owner.client.mutation(addMember, { organizationId, userId: operator.userId, role: 'operator' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const eventId = await createEvent();

  // Authoring — creating an event, editing its columns, editing its values — is
  // refused below planner, with the generic error.
  for (const { client } of [viewer, operator]) {
    await expect(
      client.mutation(createEventFromRecipe, { projectId, recipeVersionId: versionId, name: 'Nope', startsAt: 1, values: [requiredCode] }),
    ).rejects.toMatchObject({ data: inaccessible });
    await expect(client.mutation(updateEventCoreFields, { eventId, name: 'Nope' })).rejects.toMatchObject({ data: inaccessible });
    await expect(client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: requiredCode.fieldDefinitionId, value: { kind: 'text', value: 'ZZ' } }] })).rejects.toMatchObject({ data: inaccessible });
  }

  // Reading stays open to any member, so the rejections above are a floor on
  // authoring, not on visibility.
  // Reading returns the event's CONTENT, not merely a resolved promise: a read
  // path that handed viewers an empty page would otherwise look like access.
  const viewerRead = await viewer.client.query(getEvent, { eventId });
  expect(viewerRead.event._id).toBe(eventId);
  expect(viewerRead.values.map((value) => [value.key, value.value])).toEqual([['code', { kind: 'text', value: 'AB' }]]);
  const viewerPage = await viewer.client.query(listProjectEvents, { projectId, paginationOpts: firstPage });
  expect(viewerPage.page.map((row) => row._id)).toEqual([eventId]);

  // Running an event is one rank lower on purpose: an operator advances status
  // without being able to change what the event says it is. A viewer still cannot.
  await expect(viewer.client.mutation(changeEventStatus, { eventId, status: 'planned' })).rejects.toMatchObject({ data: inaccessible });
  await expect(operator.client.mutation(changeEventStatus, { eventId, status: 'planned' })).resolves.toBeNull();
  await expect(operator.client.mutation(changeEventStatus, { eventId, status: 'confirmed' })).resolves.toBeNull();

  await expect(planner.client.mutation(updateEventCoreFields, { eventId, name: 'Planner edit' })).resolves.toBeNull();
  await expect(
    planner.client.mutation(createEventFromRecipe, { projectId, recipeVersionId: versionId, name: 'Planner event', startsAt: 1, values: [requiredCode] }),
  ).resolves.toBeDefined();
});

test('the value gate rejects every malformed, out-of-bounds, and cross-tenant submission', async () => {
  const { t, owner, organizationId, definitions, locationId, requiredCode, createEvent } = await fixture();
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'events-value-foreign' });
  const foreignDefinition = await owner.client.mutation(createFieldDefinition, { organizationId: foreignOrganizationId, key: 'code', label: 'Code', config: { kind: 'text' } });
  const foreignLocationId = await owner.client.mutation(createLocation, { organizationId: foreignOrganizationId, name: 'Their venue', type: 'venue' });
  const archivedLocationId = await owner.client.mutation(createLocation, { organizationId, name: 'Closed venue', type: 'venue' });
  await owner.client.mutation(archiveLocation, { locationId: archivedLocationId });
  const missingDefinition = await t.run(async (ctx) => {
    const id = await ctx.db.insert('fieldDefinitions', { scope: 'organization', organizationId, key: 'ghost', label: 'Ghost', status: 'active', config: { kind: 'text' } });
    await ctx.db.delete(id);
    return id;
  });

  const unknownField = 'Event value references an unknown recipe field';
  const kindMismatch = 'Field value kind must match its field configuration';
  const unknownOption = 'Field value must reference an option defined by the field configuration';
  const notFinite = 'Field value must be a finite number';
  const belowMinimum = 'Field value is below the configured minimum';
  const aboveMaximum = 'Field value is above the configured maximum';

  const rejections: { value: SubmittedValue; error: string }[] = [
    // Unknown fields: never composed, fabricated, and another tenant's — one error.
    { value: { fieldDefinitionId: missingDefinition, value: { kind: 'text', value: 'AB' } }, error: unknownField },
    { value: { fieldDefinitionId: foreignDefinition, value: { kind: 'text', value: 'AB' } }, error: unknownField },
    // Discriminator mismatches in both directions.
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'text', value: 'AB' } }, error: kindMismatch },
    { value: { fieldDefinitionId: definitions.notes, value: { kind: 'boolean', value: true } }, error: kindMismatch },
    { value: { fieldDefinitionId: definitions.venue, value: { kind: 'text', value: 'AB' } }, error: kindMismatch },
    // select / multiSelect.
    { value: { fieldDefinitionId: definitions.tier, value: { kind: 'select', optionId: 'bronze' } }, error: unknownOption },
    { value: { fieldDefinitionId: definitions.extras, value: { kind: 'multiSelect', optionIds: ['bronze'] } }, error: unknownOption },
    { value: { fieldDefinitionId: definitions.extras, value: { kind: 'multiSelect', optionIds: ['wifi', 'wifi'] } }, error: 'Field value must not repeat select options' },
    { value: { fieldDefinitionId: definitions.extras, value: { kind: 'multiSelect', optionIds: [] } }, error: 'Field value selects fewer options than the field configuration allows' },
    { value: { fieldDefinitionId: definitions.extras, value: { kind: 'multiSelect', optionIds: ['wifi', 'water', 'snack'] } }, error: 'Field value selects more options than the field configuration allows' },
    // number: finiteness before bounds, integrality before bounds.
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: Number.NaN } }, error: notFinite },
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: Number.POSITIVE_INFINITY } }, error: notFinite },
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 2.5 } }, error: 'Field value must be an integer' },
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 0 } }, error: belowMinimum },
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 11 } }, error: aboveMaximum },
    // text / longText lengths.
    { value: { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'A' } }, error: 'Field value is shorter than the configured minimum length' },
    { value: { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'TOOLONG' } }, error: 'Field value is longer than the configured maximum length' },
    { value: { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'ab' } }, error: 'Field value is shorter than the configured minimum length' },
    { value: { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'x'.repeat(11) } }, error: 'Field value is longer than the configured maximum length' },
    // date: format, then calendar validity, then bounds.
    { value: { fieldDefinitionId: definitions.day, value: { kind: 'date', value: '2026-1-1' } }, error: 'Field value must be a YYYY-MM-DD calendar date' },
    { value: { fieldDefinitionId: definitions.day, value: { kind: 'date', value: '2025-02-30' } }, error: 'Field value must be a YYYY-MM-DD calendar date' },
    { value: { fieldDefinitionId: definitions.day, value: { kind: 'date', value: '2025-12-31' } }, error: belowMinimum },
    { value: { fieldDefinitionId: definitions.day, value: { kind: 'date', value: '2027-01-01' } }, error: aboveMaximum },
    // time: 24:00 and 12:60 are well-formed strings but not wall-clock times.
    { value: { fieldDefinitionId: definitions.pickup, value: { kind: 'time', value: '24:00' } }, error: 'Field value must be an HH:mm wall-clock time' },
    { value: { fieldDefinitionId: definitions.pickup, value: { kind: 'time', value: '12:60' } }, error: 'Field value must be an HH:mm wall-clock time' },
    { value: { fieldDefinitionId: definitions.pickup, value: { kind: 'time', value: '05:59' } }, error: belowMinimum },
    { value: { fieldDefinitionId: definitions.pickup, value: { kind: 'time', value: '22:01' } }, error: aboveMaximum },
    // datetime is an absolute timestamp, so it gets the same finiteness rule.
    { value: { fieldDefinitionId: definitions.at, value: { kind: 'datetime', value: Number.NaN } }, error: notFinite },
    { value: { fieldDefinitionId: definitions.at, value: { kind: 'datetime', value: -1 } }, error: belowMinimum },
    { value: { fieldDefinitionId: definitions.at, value: { kind: 'datetime', value: 1001 } }, error: aboveMaximum },
    // Locations: a foreign one and a merely archived one are indistinguishable (I9).
    { value: { fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId: foreignLocationId } }, error: inaccessible },
    { value: { fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId: archivedLocationId } }, error: inaccessible },
  ];

  for (const { value, error } of rejections) {
    // Cases about the required field itself stand alone; everything else rides
    // alongside a valid required value so the missing-required rule never fires first.
    const values = value.fieldDefinitionId === definitions.code ? [value] : [requiredCode, value];
    await expect(createEvent(values)).rejects.toMatchObject({ data: error });
  }

  // Missing required value and a repeated field definition.
  await expect(createEvent([])).rejects.toMatchObject({ data: 'Required event fields must have a value' });
  await expect(createEvent([requiredCode, requiredCode])).rejects.toMatchObject({ data: 'Event values must not repeat field definitions' });

  // The whole matrix accepted at its boundaries, in one event.
  const eventId = await createEvent([
    requiredCode,
    { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'abc' } },
    { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 10 } },
    { fieldDefinitionId: definitions.vip, value: { kind: 'boolean', value: false } },
    { fieldDefinitionId: definitions.day, value: { kind: 'date', value: '2026-01-01' } },
    { fieldDefinitionId: definitions.pickup, value: { kind: 'time', value: '22:00' } },
    { fieldDefinitionId: definitions.at, value: { kind: 'datetime', value: 0 } },
    { fieldDefinitionId: definitions.tier, value: { kind: 'select', optionId: 'silver' } },
    { fieldDefinitionId: definitions.extras, value: { kind: 'multiSelect', optionIds: ['wifi', 'snack'] } },
    { fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId } },
  ]);
  const event = await owner.client.query(getEvent, { eventId });
  expect(event.values).toHaveLength(10);
  expect(event.values.find((value) => value.key === 'vip')?.value).toEqual({ kind: 'boolean', value: false });

  // Nothing from a rejected submission was ever written.
  await t.run(async (ctx) => {
    expect(await ctx.db.query('events').withIndex('by_org_startsAt', (q) => q.eq('organizationId', organizationId)).collect()).toHaveLength(1);
  });
});

test('the location mirror is written on create, moved on update, and removed on clear', async () => {
  const { t, owner, organizationId, definitions, locationId, requiredCode, createEvent } = await fixture();
  const otherLocationId = await owner.client.mutation(createLocation, { organizationId, name: 'Annex', type: 'venue' });
  const eventId = await createEvent([requiredCode, { fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId } }]);

  // The mirror is what makes `deleteLocation`'s reference check indexed rather
  // than a table scan, so it is asserted directly rather than through the API.
  const mirrorsFor = (id: Id<'locations'>) =>
    t.run(async (ctx) => ctx.db.query('eventFieldValues').withIndex('by_location', (q) => q.eq('locationId', id)).collect());
  expect(await mirrorsFor(locationId)).toHaveLength(1);

  await owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId: otherLocationId } }] });
  expect(await mirrorsFor(locationId)).toHaveLength(0);
  expect(await mirrorsFor(otherLocationId)).toHaveLength(1);

  // Clearing the value must take the mirror with it, or the location stays
  // referenced by an index and undeletable forever.
  await owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.venue, value: null }] });
  expect(await mirrorsFor(otherLocationId)).toHaveLength(0);
  await t.run(async (ctx) => {
    const rows = await ctx.db.query('eventFieldValues').withIndex('by_event_field', (q) => q.eq('eventId', eventId)).collect();
    expect(rows.every((row) => row.locationId === undefined)).toBe(true);
  });
});

test('core event fields are validated on the merged pair, trimmed, and clearable', async () => {
  const { t, owner, projectId, versionId, requiredCode, createEvent } = await fixture();
  const create = (overrides: { name?: string; startsAt?: number; endsAt?: number }) =>
    owner.client.mutation(createEventFromRecipe, {
      projectId,
      recipeVersionId: versionId,
      name: overrides.name ?? 'Arrival',
      startsAt: overrides.startsAt ?? 1000,
      ...(overrides.endsAt === undefined ? {} : { endsAt: overrides.endsAt }),
      values: [requiredCode],
    });

  for (const startsAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await expect(create({ startsAt })).rejects.toMatchObject({ data: 'Event start must be a finite timestamp' });
  }
  for (const endsAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await expect(create({ endsAt })).rejects.toMatchObject({ data: 'Event end must be a finite timestamp' });
  }
  await expect(create({ startsAt: 2000, endsAt: 1000 })).rejects.toMatchObject({ data: 'Event end must not precede its start' });
  await expect(create({ name: '   ' })).rejects.toMatchObject({ data: 'Invalid event name' });
  await expect(create({ name: 'x'.repeat(201) })).rejects.toMatchObject({ data: 'Invalid event name' });

  // The trimmed name is what is stored, not the raw argument.
  const eventId = await create({ name: '  Arrival  ', startsAt: 1000, endsAt: 2000 });
  const storedEvent = () => t.run(async (ctx) => ctx.db.get(eventId));
  expect(await storedEvent()).toMatchObject({ name: 'Arrival' });

  // Ordering is judged on the merged pair: moving only the start past the stored
  // end is the same violation as submitting an inverted pair.
  await expect(owner.client.mutation(updateEventCoreFields, { eventId, startsAt: 3000 })).rejects.toMatchObject({ data: 'Event end must not precede its start' });
  await expect(owner.client.mutation(updateEventCoreFields, { eventId, endsAt: 500 })).rejects.toMatchObject({ data: 'Event end must not precede its start' });
  await expect(owner.client.mutation(updateEventCoreFields, { eventId, startsAt: Number.NaN })).rejects.toMatchObject({ data: 'Event start must be a finite timestamp' });
  expect(await storedEvent()).toMatchObject({ startsAt: 1000, endsAt: 2000 });

  await expect(owner.client.mutation(updateEventCoreFields, { eventId, name: '  Departure  ', startsAt: 1500, endsAt: 2500 })).resolves.toBeNull();
  expect(await storedEvent()).toMatchObject({ name: 'Departure', startsAt: 1500, endsAt: 2500 });

  // `null` clears the optional end, symmetric with clearing a field value; after
  // that, any start is orderable again.
  await expect(owner.client.mutation(updateEventCoreFields, { eventId, endsAt: null })).resolves.toBeNull();
  expect((await storedEvent())?.endsAt).toBeUndefined();
  await expect(owner.client.mutation(updateEventCoreFields, { eventId, startsAt: 9000 })).resolves.toBeNull();
  // Clearing an already-absent end is a no-op, not a change.
  await expect(owner.client.mutation(updateEventCoreFields, { eventId, endsAt: null })).resolves.toBeNull();

  await expect(createEvent([requiredCode], { startsAt: 30, endsAt: 30 })).resolves.toBeDefined();
});

test('historical integrity: an event keeps validating against its own version after that version is retired (I3)', async () => {
  const { t, owner, projectId, recipeId, versionId, definitions, requiredCode, createEvent } = await fixture();
  const legalUnderV1: SubmittedValue = { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 8 } };
  const eventId = await createEvent([requiredCode, { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 5 } }]);

  // v2 narrows the seat bound to 1..3. Narrowing a snapshot is legal composition;
  // it must not reach back into events already written against v1.
  const v2 = await owner.client.mutation(clonePublishedVersionToDraft, { recipeId });
  const draftRows = await owner.client.query(listRecipeFields, { recipeVersionId: v2 });
  const seatsRow = draftRows.find((row) => row.fieldDefinitionId === definitions.seats);
  if (seatsRow === undefined) throw new Error('cloned seats row missing');
  await owner.client.mutation(updateRecipeField, { recipeFieldId: seatsRow._id, config: { kind: 'number', min: 1, max: 3, integer: true } });

  // Mutating the still-draft v2 changes nothing for the v1 event.
  await expect(owner.client.mutation(updateEventFields, { eventId, values: [legalUnderV1] })).resolves.toBeNull();

  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: v2 });
  expect((await t.run(async (ctx) => ctx.db.get(versionId)))?.status).toBe('retired');

  // THE headline: the event's rules are v1's, and v1 is retired. A value legal
  // under v1 and illegal under v2 still succeeds — the update reads the event's
  // own recipeVersionId rows with no status filter.
  await expect(owner.client.mutation(updateEventFields, { eventId, values: [legalUnderV1] })).resolves.toBeNull();
  await t.run(async (ctx) => {
    const row = await ctx.db.query('eventFieldValues').withIndex('by_event_field', (q) => q.eq('eventId', eventId).eq('fieldDefinitionId', definitions.seats)).unique();
    expect(row?.value).toEqual({ kind: 'number', value: 8 });
    // The row still points at v1's snapshot, not v2's replacement of it.
    expect((await ctx.db.get(row?.recipeFieldId ?? seatsRow._id))?.recipeVersionId).toBe(versionId);
  });

  // A value illegal under v1 fails with v1's rule, not v2's: 11 is above v1's
  // maximum of 10, and 8 (rejected by v2) was accepted above.
  await expect(
    owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 11 } }] }),
  ).rejects.toMatchObject({ data: 'Field value is above the configured maximum' });

  // The event is still fully readable under the retired version.
  const event = await owner.client.query(getEvent, { eventId });
  expect(event.event.recipeVersionId).toBe(versionId);
  expect(event.values.find((value) => value.key === 'seats')?.value).toEqual({ kind: 'number', value: 8 });

  // New events must use v2, and v2's narrower rule binds them.
  await expect(createEvent([requiredCode])).rejects.toMatchObject({ data: 'Events require a published version of an active recipe' });
  const fromV2 = (values: SubmittedValue[]) =>
    owner.client.mutation(createEventFromRecipe, { projectId, recipeVersionId: v2, name: 'Under v2', startsAt: 1000, values });
  await expect(fromV2([requiredCode, legalUnderV1])).rejects.toMatchObject({ data: 'Field value is above the configured maximum' });
  await expect(fromV2([requiredCode, { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 3 } }])).resolves.toBeDefined();
});

test('field values upsert in place, clear, and re-set without ever duplicating a row', async () => {
  const { t, owner, definitions, requiredCode, createEvent } = await fixture();
  const eventId = await createEvent([requiredCode, { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'first' } }]);
  const rowsFor = (fieldDefinitionId: Id<'fieldDefinitions'>) =>
    t.run(async (ctx) => ctx.db.query('eventFieldValues').withIndex('by_event_field', (q) => q.eq('eventId', eventId).eq('fieldDefinitionId', fieldDefinitionId)).collect());

  // Two updates to the same field leave exactly one row: the second is a patch,
  // not a second insert.
  await owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'BB' } }] });
  await owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'CC' } }] });
  const codeRows = await rowsFor(definitions.code);
  expect(codeRows).toHaveLength(1);
  expect(codeRows[0]?.value).toEqual({ kind: 'text', value: 'CC' });

  // Clearing an optional value that exists removes the row; re-setting it inserts
  // exactly one again.
  await owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.notes, value: null }] });
  expect(await rowsFor(definitions.notes)).toHaveLength(0);
  await owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'again' } }] });
  expect(await rowsFor(definitions.notes)).toHaveLength(1);

  // Clearing an optional value that was never set is an accepted no-op.
  await expect(owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.tier, value: null }] })).resolves.toBeNull();
  expect(await rowsFor(definitions.tier)).toHaveLength(0);

  const duplicate: ClearableValue[] = [
    { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'DD' } },
    { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'EE' } },
  ];
  await expect(owner.client.mutation(updateEventFields, { eventId, values: duplicate })).rejects.toMatchObject({ data: 'Event values must not repeat field definitions' });
  await expect(
    owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.code, value: null }] }),
  ).rejects.toMatchObject({ data: 'Required event fields cannot be cleared' });

  // An unknown field is refused on the update path by the same single gate.
  const strayDefinition = await owner.client.mutation(createFieldDefinition, {
    organizationId: (await t.run(async (ctx) => (await ctx.db.get(eventId))?.organizationId)) ?? (() => { throw new Error('event missing'); })(),
    key: 'stray',
    label: 'Stray',
    config: { kind: 'text' },
  });
  await expect(
    owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: strayDefinition, value: { kind: 'text', value: 'AB' } }] }),
  ).rejects.toMatchObject({ data: 'Event value references an unknown recipe field' });

  // A rejected submission wrote nothing: the required value survives intact.
  expect((await rowsFor(definitions.code))[0]?.value).toEqual({ kind: 'text', value: 'CC' });
});

test('S1 regression: resubmitting an unchanged value is not re-judged, even after its location is archived', async () => {
  const { t, owner, organizationId, definitions, locationId, requiredCode, createEvent } = await fixture();
  const venue: SubmittedValue = { fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId } };
  const eventId = await createEvent([requiredCode, venue]);

  // The ordinary read-modify-write shape: load the event, change one field, send
  // the whole form back. The untouched location value must not be re-validated
  // against the world as it is now — it already passed this immutable snapshot
  // when it was written, and there is no way to "fix" it (the location has no
  // unarchive, and clearing the field is a different edit than the user made).
  await owner.client.mutation(archiveLocation, { locationId });
  await expect(
    owner.client.mutation(updateEventFields, {
      eventId,
      values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'changed' } }, venue],
    }),
  ).resolves.toBeNull();
  await t.run(async (ctx) => {
    const rows = await ctx.db.query('eventFieldValues').withIndex('by_event_field', (q) => q.eq('eventId', eventId)).collect();
    expect(rows.find((row) => row.fieldDefinitionId === definitions.venue)?.value).toEqual({ kind: 'location', locationId });
    expect(rows.find((row) => row.fieldDefinitionId === definitions.notes)?.value).toEqual({ kind: 'longText', value: 'changed' });
  });
  // Only the field that moved is audited: the unchanged one is not an edit.
  await t.run(async (ctx) => {
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'event').eq('entityId', eventId))
      .collect();
    expect(audits.filter((audit) => audit.action === 'event.fieldsUpdated').map((audit) => audit.metadata.changedFields)).toEqual([definitions.notes]);
  });

  // Skipping the re-check is scoped to values that did NOT change: pointing the
  // field at the archived location as a real edit is still refused, and so is a
  // fresh event created against it.
  const otherLocationId = await owner.client.mutation(createLocation, { organizationId, name: 'Annex', type: 'venue' });
  await owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId: otherLocationId } }] });
  await expect(owner.client.mutation(updateEventFields, { eventId, values: [venue] })).rejects.toMatchObject({ data: inaccessible });
  await expect(createEvent([requiredCode, venue])).rejects.toMatchObject({ data: inaccessible });
});

test('S3 regression: stored string values are capped absolutely, whatever the snapshot omits', async () => {
  const { owner, organizationId, projectId, requiredCode, createEvent } = await fixture();
  // A config with NO maxLength — the shape the seeded `notes` built-in ships —
  // is exactly the case where only the absolute ceiling stands between a tenant
  // and a multi-megabyte event that `getEvent` can never read back.
  const unbounded = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'freeform', label: 'Freeform', config: { kind: 'longText' } });
  const short = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'line', label: 'Line', config: { kind: 'text' } });
  const recipeId = await owner.client.mutation(createRecipe, { organizationId, key: 'capsPlan', name: 'Caps plan' });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { recipeId });
  await owner.client.mutation(addRecipeField, { recipeVersionId: versionId, fieldDefinitionId: unbounded, required: false, visible: true });
  await owner.client.mutation(addRecipeField, { recipeVersionId: versionId, fieldDefinitionId: short, required: false, visible: true });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: versionId });
  const create = (values: SubmittedValue[]) =>
    owner.client.mutation(createEventFromRecipe, { projectId, recipeVersionId: versionId, name: 'Capped', startsAt: 1000, values });

  await expect(create([{ fieldDefinitionId: unbounded, value: { kind: 'longText', value: 'x'.repeat(10_001) } }])).rejects.toMatchObject({
    data: 'Field value must not exceed 10000 characters',
  });
  await expect(create([{ fieldDefinitionId: short, value: { kind: 'text', value: 'x'.repeat(2001) } }])).rejects.toMatchObject({
    data: 'Field value must not exceed 2000 characters',
  });
  // The bound is inclusive, and it applies on the update door too.
  const eventId = await create([{ fieldDefinitionId: unbounded, value: { kind: 'longText', value: 'x'.repeat(10_000) } }]);
  await expect(
    owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: unbounded, value: { kind: 'longText', value: 'x'.repeat(10_001) } }] }),
  ).rejects.toMatchObject({ data: 'Field value must not exceed 10000 characters' });

  // The other half of the same rule: a config can promise less than the ceiling,
  // never more, so no snapshot can advertise a bound the value gate would refuse.
  await expect(
    owner.client.mutation(createFieldDefinition, { organizationId, key: 'tooWide', label: 'Too wide', config: { kind: 'longText', maxLength: 10_001 } }),
  ).rejects.toMatchObject({ data: 'Field length bounds must not exceed 10000 characters' });
  await expect(
    owner.client.mutation(createFieldDefinition, { organizationId, key: 'tooWideText', label: 'Too wide text', config: { kind: 'text', maxLength: 2001 } }),
  ).rejects.toMatchObject({ data: 'Field length bounds must not exceed 2000 characters' });
  // Untouched by the caps: the ordinary bounded fixture still accepts its values.
  await expect(createEvent([requiredCode])).resolves.toBeDefined();
});

test('the status matrix advances one step at a time, cancels from anywhere, and is terminal at both ends', async () => {
  const { owner, definitions, requiredCode, createEvent } = await fixture();
  const notPermitted = 'Event status transition is not permitted';
  const terminal = 'Completed and cancelled events are terminal';

  const forward = await createEvent();
  for (const status of ['planned', 'confirmed', 'active', 'completed'] as const) {
    await expect(owner.client.mutation(changeEventStatus, { eventId: forward, status })).resolves.toBeNull();
  }
  await expect(owner.client.mutation(changeEventStatus, { eventId: forward, status: 'cancelled' })).rejects.toMatchObject({ data: terminal });
  // Completed is read-only through both authoring doors, not only the status one.
  await expect(owner.client.mutation(updateEventCoreFields, { eventId: forward, name: 'Late edit' })).rejects.toMatchObject({ data: 'Completed and cancelled events are read-only' });
  await expect(
    owner.client.mutation(updateEventFields, { eventId: forward, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'late' } }] }),
  ).rejects.toMatchObject({ data: 'Completed and cancelled events are read-only' });

  // Skipping ahead, moving backwards, and re-declaring the current status are all
  // refused by the same matrix (the same-status case has no separate branch).
  const strict = await createEvent();
  await expect(owner.client.mutation(changeEventStatus, { eventId: strict, status: 'confirmed' })).rejects.toMatchObject({ data: notPermitted });
  await expect(owner.client.mutation(changeEventStatus, { eventId: strict, status: 'draft' })).rejects.toMatchObject({ data: notPermitted });
  await owner.client.mutation(changeEventStatus, { eventId: strict, status: 'planned' });
  await expect(owner.client.mutation(changeEventStatus, { eventId: strict, status: 'planned' })).rejects.toMatchObject({ data: notPermitted });
  await expect(owner.client.mutation(changeEventStatus, { eventId: strict, status: 'draft' })).rejects.toMatchObject({ data: notPermitted });
  await expect(owner.client.mutation(changeEventStatus, { eventId: strict, status: 'completed' })).rejects.toMatchObject({ data: notPermitted });

  // Cancellation is reachable from every non-terminal state.
  for (const path of [[], ['planned'], ['planned', 'confirmed'], ['planned', 'confirmed', 'active']] as const) {
    const eventId = await createEvent([requiredCode]);
    for (const status of path) await owner.client.mutation(changeEventStatus, { eventId, status });
    await expect(owner.client.mutation(changeEventStatus, { eventId, status: 'cancelled' })).resolves.toBeNull();
    // Cancelled is terminal in every direction, and read-only for authoring.
    await expect(owner.client.mutation(changeEventStatus, { eventId, status: 'planned' })).rejects.toMatchObject({ data: terminal });
    await expect(owner.client.mutation(changeEventStatus, { eventId, status: 'cancelled' })).rejects.toMatchObject({ data: terminal });
    await expect(owner.client.mutation(updateEventCoreFields, { eventId, name: 'Nope' })).rejects.toMatchObject({ data: 'Completed and cancelled events are read-only' });
  }
});

test('every event operation writes an attributed audit row naming what changed, and no-ops write none', async () => {
  const { t, owner, organizationId, versionId, definitions, requiredCode, createEvent } = await fixture();
  const planner = await provision(t, 'events-audit-planner');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const eventId = await createEvent([requiredCode, { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'first' } }]);

  await planner.client.mutation(updateEventCoreFields, { eventId, name: 'Renamed', startsAt: 1500 });
  // A core-field patch that changes nothing must not write an empty audit row.
  await planner.client.mutation(updateEventCoreFields, { eventId, name: 'Renamed' });
  await planner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'second' } }] });
  // Neither must a value submission that echoes what is already stored, nor an
  // empty one, nor clearing an already-absent optional value.
  await planner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'second' } }] });
  await planner.client.mutation(updateEventFields, { eventId, values: [] });
  await planner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.tier, value: null }] });
  await owner.client.mutation(changeEventStatus, { eventId, status: 'planned' });

  const cancelled = await createEvent();
  await owner.client.mutation(changeEventStatus, { eventId: cancelled, status: 'cancelled' });

  await t.run(async (ctx) => {
    const auditsFor = (entityId: string) =>
      ctx.db
        .query('auditEvents')
        .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'event').eq('entityId', entityId))
        .collect();

    const audits = await auditsFor(eventId);
    // Core-column edits and typed-value edits are DIFFERENT actions on purpose:
    // both write `metadata.changedFields`, but one holds column names and the
    // other holds field-definition ids, and a log consumer must not have to sniff
    // the value to tell which vocabulary it is reading.
    expect(audits.map((audit) => audit.action)).toEqual(['event.created', 'event.updated', 'event.fieldsUpdated', 'event.statusChanged']);
    expect(audits.every((audit) => audit.organizationId === organizationId)).toBe(true);
    expect(audits[0]).toMatchObject({ actorUserId: owner.userId, metadata: { recipeVersionId: versionId } });
    expect(audits[1]).toMatchObject({ actorUserId: planner.userId, metadata: { changedFields: 'name,startsAt' } });
    // The value update names the field definitions that actually changed, matching
    // the changedFields convention used by projects, recipes, and locations.
    expect(audits[2]).toMatchObject({ actorUserId: planner.userId, metadata: { changedFields: definitions.notes } });
    expect(audits[3]).toMatchObject({ actorUserId: owner.userId, metadata: { previousStatus: 'draft' } });

    // Cancellation is its own action, so the terminal removal path is greppable.
    const cancelledAudits = await auditsFor(cancelled);
    expect(cancelledAudits.map((audit) => audit.action)).toEqual(['event.created', 'event.cancelled']);
    expect(cancelledAudits[1]).toMatchObject({ metadata: { previousStatus: 'draft' } });
  });
});

test('event queries paginate by start time, stay tenant-scoped, and join live definition metadata', async () => {
  const { t, owner, organizationId, projectId, definitions, requiredCode, createEvent } = await fixture();
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'events-query-foreign' });
  const foreignProjectId = await owner.client.mutation(createProject, { organizationId: foreignOrganizationId, name: 'Theirs' });
  const member = await provision(t, 'events-query-member');
  await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'viewer' });

  // Inserted out of order; the index orders them by start time.
  const late = await createEvent([requiredCode], { startsAt: 300 });
  const early = await createEvent([requiredCode], { startsAt: 100 });
  const middle = await createEvent([requiredCode], { startsAt: 200 });

  const first = await member.client.query(listProjectEvents, { projectId, paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page.map((row) => row._id)).toEqual([early, middle]);
  expect(first.isDone).toBe(false);
  const second = await member.client.query(listProjectEvents, { projectId, paginationOpts: { numItems: 2, cursor: first.continueCursor } });
  expect(second.page.map((row) => row._id)).toEqual([late]);
  expect(second.isDone).toBe(true);
  expect(second.page.every((row) => row.organizationId === organizationId)).toBe(true);

  // A project in another tenant is opaque even to a member of this one.
  await expect(member.client.query(listProjectEvents, { projectId: foreignProjectId, paginationOpts: firstPage })).rejects.toMatchObject({ data: inaccessible });

  // The live join contract: `key` is frozen for any definition an event can
  // reference (renaming it is refused), while `label` follows the definition and
  // archival does not hide stored values.
  const eventId = await createEvent([requiredCode, { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'joined' } }]);
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: definitions.notes, key: 'renamedNotes' })).rejects.toMatchObject({
    data: 'Fields referenced by published or retired recipe versions may only update label or description',
  });
  await owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: definitions.notes, label: 'Operator notes' });
  await owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId: definitions.notes });
  const event = await member.client.query(getEvent, { eventId });
  expect(event.values.find((value) => value.fieldDefinitionId === definitions.notes)).toEqual({
    fieldDefinitionId: definitions.notes,
    key: 'notes',
    label: 'Operator notes',
    value: { kind: 'longText', value: 'joined' },
  });

  // A foreign event id is opaque through getEvent too.
  const foreignRecipeId = await owner.client.mutation(createRecipe, { organizationId: foreignOrganizationId, key: 'eventPlan', name: 'Theirs' });
  const foreignVersionId = await owner.client.mutation(createInitialDraftVersion, { recipeId: foreignRecipeId });
  const foreignField = await owner.client.mutation(createFieldDefinition, { organizationId: foreignOrganizationId, key: 'code', label: 'Code', config: { kind: 'text' } });
  await owner.client.mutation(addRecipeField, { recipeVersionId: foreignVersionId, fieldDefinitionId: foreignField, required: false, visible: true });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: foreignVersionId });
  const foreignEventId = await owner.client.mutation(createEventFromRecipe, {
    projectId: foreignProjectId,
    recipeVersionId: foreignVersionId,
    name: 'Theirs',
    startsAt: 1,
    values: [],
  });
  await expect(member.client.query(getEvent, { eventId: foreignEventId })).rejects.toMatchObject({ data: inaccessible });
});

test('F3 regression: configured defaults are materialized at creation, before the required-field check', async () => {
  const { t, owner, organizationId, projectId, locationId } = await fixture();
  // A fresh recipe whose fields carry defaults, including a REQUIRED one: the
  // default is what makes omitting it legal.
  const label = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'shift', label: 'Shift', config: { kind: 'text', maxLength: 8 } });
  const tier = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'grade', label: 'Grade', config: { kind: 'select', options: [{ id: 'gold', label: 'Gold' }, { id: 'silver', label: 'Silver' }] } });
  const spot = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'spot', label: 'Spot', config: { kind: 'location' } });
  const defaultsRecipeId = await owner.client.mutation(createRecipe, { organizationId, key: 'defaultsPlan', name: 'Defaults plan' });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { recipeId: defaultsRecipeId });
  await owner.client.mutation(addRecipeField, { recipeVersionId: versionId, fieldDefinitionId: label, required: true, visible: true, defaultValue: { kind: 'text', value: 'MORNING' } });
  await owner.client.mutation(addRecipeField, { recipeVersionId: versionId, fieldDefinitionId: tier, required: false, visible: true, defaultValue: { kind: 'select', optionId: 'silver' } });
  await owner.client.mutation(addRecipeField, { recipeVersionId: versionId, fieldDefinitionId: spot, required: false, visible: true, defaultValue: { kind: 'location', locationId } });
  await owner.client.mutation(publishRecipeVersion, { recipeVersionId: versionId });

  const create = (values: SubmittedValue[]) =>
    owner.client.mutation(createEventFromRecipe, { projectId, recipeVersionId: versionId, name: 'Defaulted', startsAt: 1000, values });

  // A required field with a configured default succeeds when omitted, and every
  // default is materialized as a real stored value.
  const eventId = await create([]);
  const event = await owner.client.query(getEvent, { eventId });
  expect(event.values.map((value) => [value.key, value.value]).sort()).toEqual(
    [['shift', { kind: 'text', value: 'MORNING' }], ['grade', { kind: 'select', optionId: 'silver' }], ['spot', { kind: 'location', locationId }]].sort(),
  );
  // The location default carries its mirror like any other stored value.
  await t.run(async (ctx) => {
    expect(await ctx.db.query('eventFieldValues').withIndex('by_location', (q) => q.eq('locationId', locationId)).collect()).toHaveLength(1);
  });

  // A submitted value wins over the default; only the omitted rows are filled in.
  const overridden = await create([{ fieldDefinitionId: label, value: { kind: 'text', value: 'NIGHT' } }]);
  const overriddenEvent = await owner.client.query(getEvent, { eventId: overridden });
  expect(overriddenEvent.values.find((value) => value.key === 'shift')?.value).toEqual({ kind: 'text', value: 'NIGHT' });

  // Materialized defaults go through the same gate as submitted values: once the
  // defaulted location is archived, creation fails rather than storing it blind.
  await owner.client.mutation(archiveLocation, { locationId });
  await expect(create([])).rejects.toMatchObject({ data: inaccessible });

  // Defaults are a creation-time concept: updating never re-materializes them, so
  // an optional value cleared after creation stays cleared.
  await owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: tier, value: null }] });
  const afterClear = await owner.client.query(getEvent, { eventId });
  expect(afterClear.values.some((value) => value.key === 'grade')).toBe(false);
});

test('F2 regression: an archived project freezes its events through every write door', async () => {
  const { t, owner, projectId, definitions, requiredCode, createEvent } = await fixture();
  const eventId = await createEvent([requiredCode, { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'before' } }]);
  await owner.client.mutation(changeEventStatus, { eventId, status: 'planned' });

  // Archiving is allowed regardless of how many events the project holds — the
  // events are frozen, not refused or cascaded.
  await expect(owner.client.mutation(archiveProject, { projectId })).resolves.toBeNull();

  const frozen = 'Archived projects are read-only for their events';
  await expect(owner.client.mutation(updateEventCoreFields, { eventId, name: 'Nope' })).rejects.toMatchObject({ data: frozen });
  await expect(
    owner.client.mutation(updateEventFields, { eventId, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'after' } }] }),
  ).rejects.toMatchObject({ data: frozen });
  // Including cancellation: an archived project freezes the lifecycle entirely.
  await expect(owner.client.mutation(changeEventStatus, { eventId, status: 'confirmed' })).rejects.toMatchObject({ data: frozen });
  await expect(owner.client.mutation(changeEventStatus, { eventId, status: 'cancelled' })).rejects.toMatchObject({ data: frozen });

  // Frozen means read-only, not gone: the event is untouched and still readable.
  const event = await owner.client.query(getEvent, { eventId });
  expect(event.event).toMatchObject({ name: 'Arrival', status: 'planned' });
  expect(event.values.find((value) => value.key === 'notes')?.value).toEqual({ kind: 'longText', value: 'before' });
  await expect(owner.client.query(listProjectEvents, { projectId, paginationOpts: firstPage })).resolves.toMatchObject({ isDone: true });
  await t.run(async (ctx) => {
    expect(await ctx.db.query('events').withIndex('by_project', (q) => q.eq('projectId', projectId)).collect()).toHaveLength(1);
  });
});
