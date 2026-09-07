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
const createEvent = api.events.mutations.createEvent;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const updateFieldDefinition = api.fields.mutations.updateFieldDefinition;
const archiveFieldDefinition = api.fields.mutations.archiveFieldDefinition;
const createServiceKind = api.serviceKinds.mutations.createServiceKind;
const archiveServiceKind = api.serviceKinds.mutations.archiveServiceKind;
const createInitialDraftVersion = api.serviceKinds.mutations.createInitialDraftVersion;
const clonePublishedVersionToDraft = api.serviceKinds.mutations.clonePublishedVersionToDraft;
const publishServiceKindVersion = api.serviceKinds.mutations.publishServiceKindVersion;
const addServiceKindField = api.serviceKinds.fields.mutations.addServiceKindField;
const updateServiceKindField = api.serviceKinds.fields.mutations.updateServiceKindField;
const listServiceKindFields = api.serviceKinds.fields.queries.listServiceKindFields;
const createLocation = api.locations.mutations.createLocation;
const archiveLocation = api.locations.mutations.archiveLocation;
const createServiceFromServiceKind = api.services.mutations.createServiceFromServiceKind;
const updateServiceCoreFields = api.services.mutations.updateServiceCoreFields;
const updateServiceFields = api.services.mutations.updateServiceFields;
const changeServiceStatus = api.services.mutations.changeServiceStatus;
const getService = api.services.queries.getService;
const listProjectServices = api.services.queries.listProjectServices;
const listOrganizationServices = api.services.queries.listOrganizationServices;

const issuer = 'https://example.clerk.accounts.dev';
const inaccessible = 'notFoundOrInaccessible';
const unauthenticated = 'unauthenticated';
const firstPage = { numItems: 10, cursor: null };

/** The stored typed-value union, reused for the submission tables below. */
type FieldValue = Doc<'serviceFieldValues'>['value'];
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
 * One published serviceKind version composing every data type, so the validation
 * matrix exercises real snapshots rather than hand-inserted rows. `code` is the
 * only required field; every other field is optional, which is what lets each
 * test submit exactly the one value it is about.
 */
async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await provision(t, 'services-owner');
  const organizationId = await owner.client.mutation(createOrganization, { name: 'Services', slug: 'services-fixture' });
  const projectId = await owner.client.mutation(createProject, { organizationId, name: 'Service project' });
  const eventId = await owner.client.mutation(createEvent, { projectId, name: 'Service event', startsAt: 0 });
  const locationId = await owner.client.mutation(createLocation, { organizationId, name: 'Main venue', type: 'venue' });

  const field = (key: string, label: string, config: Doc<'fieldDefinitions'>['config']) =>
    owner.client.mutation(createFieldDefinition, { organizationId, key, label, config });
  const definitions = {
    code: await field('code', 'Code', { kind: 'text', minLength: 2, maxLength: 5 }),
    notes: await field('serviceNotes', 'Notes', { kind: 'longText', minLength: 3, maxLength: 10 }),
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

  const serviceKindId = await owner.client.mutation(createServiceKind, { organizationId, key: 'servicePlan', name: 'Service plan' });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { serviceKindId });
  for (const [key, fieldDefinitionId] of Object.entries(definitions)) {
    await owner.client.mutation(addServiceKindField, { serviceKindVersionId: versionId, fieldDefinitionId, required: key === 'code', visible: true });
  }
  await owner.client.mutation(publishServiceKindVersion, { serviceKindVersionId: versionId });

  /** The required value every valid creation must carry. */
  const requiredCode: SubmittedValue = { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'AB' } };
  const createService = (values: SubmittedValue[] = [requiredCode], overrides: { name?: string; startsAt?: number; endsAt?: number } = {}) =>
    owner.client.mutation(createServiceFromServiceKind, {
      eventId,
      serviceKindVersionId: versionId,
      name: overrides.name ?? 'Arrival',
      startsAt: overrides.startsAt ?? 1000,
      ...(overrides.endsAt === undefined ? {} : { endsAt: overrides.endsAt }),
      values,
    });

  return { t, owner, organizationId, projectId, eventId, serviceKindId, versionId, locationId, definitions, requiredCode, createService };
}

test('creation is gated on version status, serviceKind and project lifecycle, and tenant ownership', async () => {
  const { t, owner, organizationId, projectId, eventId, serviceKindId, versionId, requiredCode, createService } = await fixture();
  const values = [requiredCode];

  // A draft version has not frozen its rules yet, so it can never back an Service.
  const draftVersionId = await owner.client.mutation(clonePublishedVersionToDraft, { serviceKindId });
  await expect(
    owner.client.mutation(createServiceFromServiceKind, { eventId, serviceKindVersionId: draftVersionId, name: 'Arrival', startsAt: 1000, values }),
  ).rejects.toMatchObject({ data: { code: 'serviceKindUnavailable' } });

  // Publishing the clone retires v1; a retired version stays readable and keeps
  // validating its own services, but is no longer a source of new ones.
  await owner.client.mutation(publishServiceKindVersion, { serviceKindVersionId: draftVersionId });
  await expect(createService(values)).rejects.toMatchObject({ data: { code: 'serviceKindUnavailable' } });
  await expect(
    owner.client.mutation(createServiceFromServiceKind, { eventId, serviceKindVersionId: draftVersionId, name: 'Arrival', startsAt: 1000, values }),
  ).resolves.toBeDefined();

  // Archiving the serviceKind retires its published version in the same transaction.
  await owner.client.mutation(archiveServiceKind, { serviceKindId });
  await expect(
    owner.client.mutation(createServiceFromServiceKind, { eventId, serviceKindVersionId: draftVersionId, name: 'Arrival', startsAt: 1000, values }),
  ).rejects.toMatchObject({ data: { code: 'serviceKindUnavailable' } });

  // A serviceKind version belonging to another tenant is opaque even to a member of
  // both organizations: the project and the version must agree (I1/I9).
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'services-foreign-create' });
  const foreignServiceKindId = await owner.client.mutation(createServiceKind, { organizationId: foreignOrganizationId, key: 'servicePlan', name: 'Theirs' });
  const foreignVersionId = await owner.client.mutation(createInitialDraftVersion, { serviceKindId: foreignServiceKindId });
  const foreignField = await owner.client.mutation(createFieldDefinition, {
    organizationId: foreignOrganizationId,
    key: 'code',
    label: 'Code',
    config: { kind: 'text' },
  });
  await owner.client.mutation(addServiceKindField, { serviceKindVersionId: foreignVersionId, fieldDefinitionId: foreignField, required: false, visible: true });
  await owner.client.mutation(publishServiceKindVersion, { serviceKindVersionId: foreignVersionId });
  await expect(
    owner.client.mutation(createServiceFromServiceKind, { eventId, serviceKindVersionId: foreignVersionId, name: 'Arrival', startsAt: 1000, values: [] }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  // Project lifecycle: a completed project takes no new services, an archived one
  // takes none either (and freezes the ones it has — see the F2 regression test).
  const completedProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Completed' });
  const completedEventId = await owner.client.mutation(createEvent, { projectId: completedProjectId, name: 'Completed event', startsAt: 0 });
  await owner.client.mutation(updateProject, { projectId: completedProjectId, status: 'completed' });
  const archivedProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Archived' });
  const archivedEventId = await owner.client.mutation(createEvent, { projectId: archivedProjectId, name: 'Archived event', startsAt: 0 });
  await owner.client.mutation(archiveProject, { projectId: archivedProjectId });
  for (const closedEventId of [completedEventId, archivedEventId]) {
    await expect(
      owner.client.mutation(createServiceFromServiceKind, { eventId: closedEventId, serviceKindVersionId: versionId, name: 'Arrival', startsAt: 1000, values }),
    ).rejects.toMatchObject({ data: { code: 'serviceProjectUnavailable' } });
  }

  await t.run(async (ctx) => {
    expect(await ctx.db.query('services').withIndex('by_project', (q) => q.eq('projectId', completedProjectId)).collect()).toHaveLength(0);
  });
});

test('service creation requires an Event, hides foreign Events, and derives projectId from the stored Event', async () => {
  const { t, owner, organizationId, projectId, eventId, versionId, requiredCode } = await fixture();

  await expect(
    // @ts-expect-error The runtime validator must also refuse callers that omit the required Event link.
    owner.client.mutation(createServiceFromServiceKind, {
      serviceKindVersionId: versionId,
      name: 'No parent',
      startsAt: 1,
      values: [requiredCode],
    }),
  ).rejects.toBeDefined();

  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Foreign event org', slug: 'foreign-event-org' });
  const foreignProjectId = await owner.client.mutation(createProject, { organizationId: foreignOrganizationId, name: 'Foreign project' });
  const foreignEventId = await owner.client.mutation(createEvent, { projectId: foreignProjectId, name: 'Foreign event', startsAt: 0 });
  await expect(
    owner.client.mutation(createServiceFromServiceKind, {
      eventId: foreignEventId,
      serviceKindVersionId: versionId,
      name: 'Cross tenant',
      startsAt: 1,
      values: [requiredCode],
    }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  const serviceId = await owner.client.mutation(createServiceFromServiceKind, {
    eventId,
    serviceKindVersionId: versionId,
    name: 'Derived project',
    startsAt: 1,
    values: [requiredCode],
  });
  await t.run(async (ctx) => {
    const storedEvent = await ctx.db.get(eventId);
    const storedService = await ctx.db.get(serviceId);
    expect(storedEvent).toMatchObject({ organizationId, projectId });
    expect(storedService).toMatchObject({ organizationId, eventId, projectId });
    expect(storedService?.projectId).toBe(projectId);
  });
});

test('every public service function is opaque to unauthenticated, fabricated, foreign, and non-member callers', async () => {
  const { t, owner, organizationId, projectId, eventId, versionId, requiredCode, createService } = await fixture();
  const outsider = await provision(t, 'services-outsider');
  const serviceId = await createService();

  const missingServiceId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('services', {
      organizationId,
      projectId,
      eventId,
      serviceKindId: (await ctx.db.get(serviceId))?.serviceKindId ?? (() => { throw new Error('service missing'); })(),
      serviceKindVersionId: versionId,
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
  const missingEventId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('events', { organizationId, projectId, name: 'Temporary', status: 'draft', startsAt: 0 });
    await ctx.db.delete(id);
    return id;
  });

  // Unauthenticated: identical error for real and fabricated ids, on all six.
  for (const id of [serviceId, missingServiceId]) {
    await expect(t.query(getService, { serviceId: id })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(updateServiceCoreFields, { serviceId: id, name: 'Nope' })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(updateServiceFields, { serviceId: id, values: [] })).rejects.toMatchObject({ data: { code: unauthenticated } });
    await expect(t.mutation(changeServiceStatus, { serviceId: id, status: 'planned' })).rejects.toMatchObject({ data: { code: unauthenticated } });
  }
  for (const id of [projectId, missingProjectId]) {
    await expect(t.query(listProjectServices, { projectId: id, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: unauthenticated } });
  }
  for (const id of [eventId, missingEventId]) {
    await expect(
      t.mutation(createServiceFromServiceKind, { eventId: id, serviceKindVersionId: versionId, name: 'Nope', startsAt: 1, values: [requiredCode] }),
    ).rejects.toMatchObject({ data: { code: unauthenticated } });
  }

  // A user with no membership anywhere gets the same generic error for a real
  // service as for one that never existed (I9).
  for (const id of [serviceId, missingServiceId]) {
    await expect(outsider.client.query(getService, { serviceId: id })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(updateServiceCoreFields, { serviceId: id, name: 'Nope' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(updateServiceFields, { serviceId: id, values: [] })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(outsider.client.mutation(changeServiceStatus, { serviceId: id, status: 'planned' })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  for (const id of [projectId, missingProjectId]) {
    await expect(outsider.client.query(listProjectServices, { projectId: id, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  for (const id of [eventId, missingEventId]) {
    await expect(
      outsider.client.mutation(createServiceFromServiceKind, { eventId: id, serviceKindVersionId: versionId, name: 'Nope', startsAt: 1, values: [requiredCode] }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  // A member of another organization is exactly as blind as a stranger.
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'services-foreign-probe' });
  await owner.client.mutation(addMember, { organizationId: foreignOrganizationId, userId: outsider.userId, role: 'owner' });
  await expect(outsider.client.query(getService, { serviceId })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(outsider.client.query(listProjectServices, { projectId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('service authoring is planner+, running an service is open to operators, and reading is open to any member', async () => {
  const { t, owner, organizationId, projectId, eventId, versionId, requiredCode, createService } = await fixture();
  const viewer = await provision(t, 'services-viewer');
  const operator = await provision(t, 'services-operator');
  const planner = await provision(t, 'services-planner');
  await owner.client.mutation(addMember, { organizationId, userId: viewer.userId, role: 'viewer' });
  await owner.client.mutation(addMember, { organizationId, userId: operator.userId, role: 'operator' });
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const serviceId = await createService();

  // Authoring — creating an service, editing its columns, editing its values — is
  // refused below planner, with the generic error.
  for (const { client } of [viewer, operator]) {
    await expect(
      client.mutation(createServiceFromServiceKind, { eventId, serviceKindVersionId: versionId, name: 'Nope', startsAt: 1, values: [requiredCode] }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(client.mutation(updateServiceCoreFields, { serviceId, name: 'Nope' })).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: requiredCode.fieldDefinitionId, value: { kind: 'text', value: 'ZZ' } }] })).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  // Reading stays open to any member, so the rejections above are a floor on
  // authoring, not on visibility.
  // Reading returns the service's CONTENT, not merely a resolved promise: a read
  // path that handed viewers an empty page would otherwise look like access.
  const viewerRead = await viewer.client.query(getService, { serviceId });
  expect(viewerRead.service._id).toBe(serviceId);
  expect(viewerRead.values.map((value) => [value.key, value.value])).toEqual([['code', { kind: 'text', value: 'AB' }]]);
  const viewerPage = await viewer.client.query(listProjectServices, { projectId, paginationOpts: firstPage });
  expect(viewerPage.page.map((row) => row._id)).toEqual([serviceId]);

  // Running an service is one rank lower on purpose: an operator advances status
  // without being able to change what the service says it is. A viewer still cannot.
  await expect(viewer.client.mutation(changeServiceStatus, { serviceId, status: 'planned' })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(operator.client.mutation(changeServiceStatus, { serviceId, status: 'planned' })).resolves.toBeNull();
  await expect(operator.client.mutation(changeServiceStatus, { serviceId, status: 'confirmed' })).resolves.toBeNull();

  await expect(planner.client.mutation(updateServiceCoreFields, { serviceId, name: 'Planner edit' })).resolves.toBeNull();
  await expect(
    planner.client.mutation(createServiceFromServiceKind, { eventId, serviceKindVersionId: versionId, name: 'Planner service', startsAt: 1, values: [requiredCode] }),
  ).resolves.toBeDefined();
});

test('the value gate rejects every malformed, out-of-bounds, and cross-tenant submission', async () => {
  const { t, owner, organizationId, definitions, locationId, requiredCode, createService } = await fixture();
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'services-value-foreign' });
  const foreignDefinition = await owner.client.mutation(createFieldDefinition, { organizationId: foreignOrganizationId, key: 'code', label: 'Code', config: { kind: 'text' } });
  const foreignLocationId = await owner.client.mutation(createLocation, { organizationId: foreignOrganizationId, name: 'Their venue', type: 'venue' });
  const archivedLocationId = await owner.client.mutation(createLocation, { organizationId, name: 'Closed venue', type: 'venue' });
  await owner.client.mutation(archiveLocation, { locationId: archivedLocationId });
  const missingDefinition = await t.run(async (ctx) => {
    const id = await ctx.db.insert('fieldDefinitions', { scope: 'organization', organizationId, key: 'ghost', label: 'Ghost', status: 'active', config: { kind: 'text' } });
    await ctx.db.delete(id);
    return id;
  });

  const unknownField = 'serviceFieldUnknown';
  const kindMismatch = 'fieldValueKindMismatch';
  const unknownOption = 'fieldValueOptionInvalid';
  const notFinite = 'fieldValueInvalid';
  const belowMinimum = 'fieldValueRangeInvalid';
  const aboveMaximum = 'fieldValueRangeInvalid';

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
    { value: { fieldDefinitionId: definitions.extras, value: { kind: 'multiSelect', optionIds: ['wifi', 'wifi'] } }, error: 'fieldValueOptionInvalid' },
    { value: { fieldDefinitionId: definitions.extras, value: { kind: 'multiSelect', optionIds: [] } }, error: 'fieldValueRangeInvalid' },
    { value: { fieldDefinitionId: definitions.extras, value: { kind: 'multiSelect', optionIds: ['wifi', 'water', 'snack'] } }, error: 'fieldValueRangeInvalid' },
    // number: finiteness before bounds, integrality before bounds.
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: Number.NaN } }, error: notFinite },
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: Number.POSITIVE_INFINITY } }, error: notFinite },
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 2.5 } }, error: 'fieldValueInvalid' },
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 0 } }, error: belowMinimum },
    { value: { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 11 } }, error: aboveMaximum },
    // text / longText lengths.
    { value: { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'A' } }, error: 'fieldValueLengthInvalid' },
    { value: { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'TOOLONG' } }, error: 'fieldValueLengthInvalid' },
    { value: { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'ab' } }, error: 'fieldValueLengthInvalid' },
    { value: { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'x'.repeat(11) } }, error: 'fieldValueLengthInvalid' },
    // date: format, then calendar validity, then bounds.
    { value: { fieldDefinitionId: definitions.day, value: { kind: 'date', value: '2026-1-1' } }, error: 'fieldValueInvalid' },
    { value: { fieldDefinitionId: definitions.day, value: { kind: 'date', value: '2025-02-30' } }, error: 'fieldValueInvalid' },
    { value: { fieldDefinitionId: definitions.day, value: { kind: 'date', value: '2025-12-31' } }, error: belowMinimum },
    { value: { fieldDefinitionId: definitions.day, value: { kind: 'date', value: '2027-01-01' } }, error: aboveMaximum },
    // time: 24:00 and 12:60 are well-formed strings but not wall-clock times.
    { value: { fieldDefinitionId: definitions.pickup, value: { kind: 'time', value: '24:00' } }, error: 'fieldValueInvalid' },
    { value: { fieldDefinitionId: definitions.pickup, value: { kind: 'time', value: '12:60' } }, error: 'fieldValueInvalid' },
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
    await expect(createService(values)).rejects.toMatchObject({ data: { code: error } });
  }

  // Missing required value and a repeated field definition.
  await expect(createService([])).rejects.toMatchObject({ data: { code: 'serviceFieldRequired' } });
  await expect(createService([requiredCode, requiredCode])).rejects.toMatchObject({ data: { code: 'serviceFieldDuplicate' } });

  // The whole matrix accepted at its boundaries, in one service.
  const serviceId = await createService([
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
  const service = await owner.client.query(getService, { serviceId });
  expect(service.values).toHaveLength(10);
  expect(service.values.find((value) => value.key === 'vip')?.value).toEqual({ kind: 'boolean', value: false });

  // Nothing from a rejected submission was ever written.
  await t.run(async (ctx) => {
    expect(await ctx.db.query('services').withIndex('by_org_startsAt', (q) => q.eq('organizationId', organizationId)).collect()).toHaveLength(1);
  });
});

test('the location mirror is written on create, moved on update, and removed on clear', async () => {
  const { t, owner, organizationId, definitions, locationId, requiredCode, createService } = await fixture();
  const otherLocationId = await owner.client.mutation(createLocation, { organizationId, name: 'Annex', type: 'venue' });
  const serviceId = await createService([requiredCode, { fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId } }]);

  // The mirror is what makes `deleteLocation`'s reference check indexed rather
  // than a table scan, so it is asserted directly rather than through the API.
  const mirrorsFor = (id: Id<'locations'>) =>
    t.run(async (ctx) => ctx.db.query('serviceFieldValues').withIndex('by_location', (q) => q.eq('locationId', id)).collect());
  expect(await mirrorsFor(locationId)).toHaveLength(1);

  await owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId: otherLocationId } }] });
  expect(await mirrorsFor(locationId)).toHaveLength(0);
  expect(await mirrorsFor(otherLocationId)).toHaveLength(1);

  // Clearing the value must take the mirror with it, or the location stays
  // referenced by an index and undeletable forever.
  await owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.venue, value: null }] });
  expect(await mirrorsFor(otherLocationId)).toHaveLength(0);
  await t.run(async (ctx) => {
    const rows = await ctx.db.query('serviceFieldValues').withIndex('by_service_field', (q) => q.eq('serviceId', serviceId)).collect();
    expect(rows.every((row) => row.locationId === undefined)).toBe(true);
  });
});

test('core service fields are validated on the merged pair, trimmed, and clearable', async () => {
  const { t, owner, eventId, versionId, requiredCode, createService } = await fixture();
  const create = (overrides: { name?: string; startsAt?: number; endsAt?: number }) =>
    owner.client.mutation(createServiceFromServiceKind, {
      eventId,
      serviceKindVersionId: versionId,
      name: overrides.name ?? 'Arrival',
      startsAt: overrides.startsAt ?? 1000,
      ...(overrides.endsAt === undefined ? {} : { endsAt: overrides.endsAt }),
      values: [requiredCode],
    });

  for (const startsAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await expect(create({ startsAt })).rejects.toMatchObject({ data: { code: 'serviceStartInvalid' } });
  }
  for (const endsAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await expect(create({ endsAt })).rejects.toMatchObject({ data: { code: 'serviceEndInvalid' } });
  }
  await expect(create({ startsAt: 2000, endsAt: 1000 })).rejects.toMatchObject({ data: { code: 'serviceDateRangeInvalid' } });
  await expect(create({ name: '   ' })).rejects.toMatchObject({ data: { code: 'entityNameInvalid' } });
  await expect(create({ name: 'x'.repeat(201) })).rejects.toMatchObject({ data: { code: 'entityNameInvalid' } });

  // The trimmed name is what is stored, not the raw argument.
  const serviceId = await create({ name: '  Arrival  ', startsAt: 1000, endsAt: 2000 });
  const storedService = () => t.run(async (ctx) => ctx.db.get(serviceId));
  expect(await storedService()).toMatchObject({ name: 'Arrival' });

  // Ordering is judged on the merged pair: moving only the start past the stored
  // end is the same violation as submitting an inverted pair.
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, startsAt: 3000 })).rejects.toMatchObject({ data: { code: 'serviceDateRangeInvalid' } });
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, endsAt: 500 })).rejects.toMatchObject({ data: { code: 'serviceDateRangeInvalid' } });
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, startsAt: Number.NaN })).rejects.toMatchObject({ data: { code: 'serviceStartInvalid' } });
  expect(await storedService()).toMatchObject({ startsAt: 1000, endsAt: 2000 });

  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, name: '  Departure  ', startsAt: 1500, endsAt: 2500 })).resolves.toBeNull();
  expect(await storedService()).toMatchObject({ name: 'Departure', startsAt: 1500, endsAt: 2500 });

  // `null` clears the optional end, symmetric with clearing a field value; after
  // that, any start is orderable again.
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, endsAt: null })).resolves.toBeNull();
  expect((await storedService())?.endsAt).toBeUndefined();
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, startsAt: 9000 })).resolves.toBeNull();
  // Clearing an already-absent end is a no-op, not a change.
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, endsAt: null })).resolves.toBeNull();

  await expect(createService([requiredCode], { startsAt: 30, endsAt: 30 })).resolves.toBeDefined();
});

test('an service must fall inside its project window, on creation and on every later edit', async () => {
  const { t, owner, organizationId, versionId, requiredCode } = await fixture();
  // A project that runs 1000..2000 — the operational envelope its services live
  // inside. A project with no dates (the fixture's own) constrains nothing.
  const projectId = await owner.client.mutation(createProject, {
    organizationId,
    name: 'Windowed project',
    startsAt: 1000,
    endsAt: 2000,
  });
  const eventId = await owner.client.mutation(createEvent, { projectId, name: 'Windowed event', startsAt: 1000, endsAt: 2000 });
  const create = (overrides: { startsAt?: number; endsAt?: number } = {}) =>
    owner.client.mutation(createServiceFromServiceKind, {
      eventId,
      serviceKindVersionId: versionId,
      name: 'Arrival',
      startsAt: overrides.startsAt ?? 1200,
      ...(overrides.endsAt === undefined ? {} : { endsAt: overrides.endsAt }),
      values: [requiredCode],
    });

  await expect(create({ startsAt: 999 })).rejects.toMatchObject({ data: { code: 'serviceBeforeProjectWindow' } });
  await expect(create({ startsAt: 2001 })).rejects.toMatchObject({ data: { code: 'serviceAfterProjectWindow' } });
  await expect(create({ startsAt: 1200, endsAt: 2001 })).rejects.toMatchObject({
    data: { code: 'serviceAfterProjectWindow' },
  });
  // Both boundaries are inclusive: a service may start exactly when the project
  // does and end exactly when it ends.
  await expect(create({ startsAt: 1000, endsAt: 2000 })).resolves.toBeDefined();

  const serviceId = await create({ startsAt: 1200, endsAt: 1800 });
  const storedService = () => t.run(async (ctx) => ctx.db.get(serviceId));

  // Editing is gated by the same rule, on the MERGED pair: moving one end out of
  // the window is as much a violation as writing both outside it.
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, startsAt: 900 })).rejects.toMatchObject({
    data: { code: 'serviceBeforeProjectWindow' },
  });
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, endsAt: 2500 })).rejects.toMatchObject({
    data: { code: 'serviceAfterProjectWindow' },
  });
  expect(await storedService()).toMatchObject({ startsAt: 1200, endsAt: 1800 });

  // Clearing the end leaves the start as the service's last instant, so the same
  // rule still applies to it and nothing escapes the window through the gap.
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, endsAt: null })).resolves.toBeNull();
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, startsAt: 2001 })).rejects.toMatchObject({
    data: { code: 'serviceAfterProjectWindow' },
  });
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, startsAt: 1900 })).resolves.toBeNull();

  // A half-open window constrains only the end it declares.
  const openEndedId = await owner.client.mutation(createProject, {
    organizationId,
    name: 'Open ended project',
    startsAt: 1000,
  });
  const openEndedEventId = await owner.client.mutation(createEvent, { projectId: openEndedId, name: 'Open ended event', startsAt: 1000 });
  const inOpenEnded = (startsAt: number) =>
    owner.client.mutation(createServiceFromServiceKind, {
      eventId: openEndedEventId,
      serviceKindVersionId: versionId,
      name: 'Arrival',
      startsAt,
      values: [requiredCode],
    });
  await expect(inOpenEnded(999)).rejects.toMatchObject({ data: { code: 'serviceBeforeProjectWindow' } });
  await expect(inOpenEnded(999_999)).resolves.toBeDefined();
});

test('the organization-wide service list interleaves projects, narrows by filter, and carries each row’s fields', async () => {
  const { owner, organizationId, projectId, versionId, definitions, requiredCode, createService } = await fixture();
  const otherProjectId = await owner.client.mutation(createProject, { organizationId, name: 'Second project' });
  const otherEventId = await owner.client.mutation(createEvent, { projectId: otherProjectId, name: 'Second event', startsAt: 0 });

  const first = await createService([requiredCode], { name: 'Earliest', startsAt: 100 });
  const third = await createService([requiredCode], { name: 'Latest', startsAt: 900 });
  const second = await owner.client.mutation(createServiceFromServiceKind, {
    eventId: otherEventId,
    serviceKindVersionId: versionId,
    name: 'Middle',
    startsAt: 500,
    values: [requiredCode, { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 4 } }],
  });

  const listed = await owner.client.query(listOrganizationServices, { organizationId, paginationOpts: firstPage });
  // Ordered by start time across every project — which is the whole point of
  // the screen this serves.
  expect(listed.page.map((row) => row.service._id)).toEqual([first, second, third]);
  expect(listed.page.map((row) => row.projectName)).toEqual(['Service project', 'Second project', 'Service project']);

  // Each row carries every visible field its own version composes, valued or
  // not, so the table can offer a column per field and edit it in place.
  const middle = listed.page[1];
  expect(middle?.fields.map((field) => field.key).sort()).toEqual(
    ['at', 'code', 'day', 'serviceNotes', 'extras', 'pickup', 'seats', 'tier', 'venue', 'vip'].sort(),
  );
  expect(middle?.fields.find((field) => field.key === 'seats')?.value).toEqual({ kind: 'number', value: 4 });
  expect(middle?.fields.find((field) => field.key === 'vip')?.value).toBeUndefined();
  // The immutable snapshot travels with the value, so an editor validates
  // against the rules this service was created under (I3).
  expect(middle?.fields.find((field) => field.key === 'seats')?.config).toMatchObject({ kind: 'number', max: 10 });

  // Filters narrow what is FETCHED, so they mean "all matching services".
  const byProject = await owner.client.query(listOrganizationServices, {
    organizationId,
    projectId: otherProjectId,
    paginationOpts: firstPage,
  });
  expect(byProject.page.map((row) => row.service._id)).toEqual([second]);

  await owner.client.mutation(changeServiceStatus, { serviceId: third, status: 'planned' });
  const byStatus = await owner.client.query(listOrganizationServices, {
    organizationId,
    status: 'planned',
    paginationOpts: firstPage,
  });
  expect(byStatus.page.map((row) => row.service._id)).toEqual([third]);
  const byBoth = await owner.client.query(listOrganizationServices, {
    organizationId,
    projectId,
    status: 'planned',
    paginationOpts: firstPage,
  });
  expect(byBoth.page.map((row) => row.service._id)).toEqual([third]);

  // Paginated, like every unbounded tenant list (I6).
  const page = await owner.client.query(listOrganizationServices, {
    organizationId,
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(page.page).toHaveLength(2);
  expect(page.isDone).toBe(false);
  const rest = await owner.client.query(listOrganizationServices, {
    organizationId,
    paginationOpts: { numItems: 2, cursor: page.continueCursor },
  });
  expect(rest.page.map((row) => row.service._id)).toEqual([third]);

});

test('a location value on a listed service is named, not returned as a bare reference', async () => {
  const { owner, organizationId, eventId, versionId, locationId, definitions, requiredCode } = await fixture();
  await owner.client.mutation(createServiceFromServiceKind, {
    eventId,
    serviceKindVersionId: versionId,
    name: 'Pickup',
    startsAt: 1000,
    values: [requiredCode, { fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId } }],
  });

  const listed = await owner.client.query(listOrganizationServices, { organizationId, paginationOpts: firstPage });
  const venue = listed.page[0]?.fields.find((field) => field.key === 'venue');
  expect(venue?.value).toEqual({ kind: 'location', locationId });
  expect(venue?.locationName).toBe('Main venue');

  // The single-service door names it the same way, so the detail screen and the
  // table agree instead of one of them printing an id.
  const detail = await owner.client.query(getService, { serviceId: listed.page[0]!.service._id });
  expect(detail.values.find((value) => value.key === 'venue')?.locationName).toBe('Main venue');
});

test('the organization-wide service list is tenant-isolated on both of its ids (I1, I9)', async () => {
  const { t, owner, organizationId, projectId } = await fixture();
  const outsider = await provision(t, 'services-outsider');
  const outsiderOrgId = await outsider.client.mutation(createOrganization, {
    name: 'Outside',
    slug: 'services-outside',
  });

  // An unauthenticated caller gets nothing, and a member of another
  // organization cannot read this one's list by knowing its id.
  await expect(t.query(listOrganizationServices, { organizationId, paginationOpts: firstPage })).rejects.toMatchObject({
    data: { code: unauthenticated },
  });
  await expect(
    outsider.client.query(listOrganizationServices, { organizationId, paginationOpts: firstPage }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  // Knowing a project id from another tenant grants nothing either, and the
  // refusal does not distinguish "not yours" from "does not exist" (I9).
  await expect(
    outsider.client.query(listOrganizationServices, {
      organizationId: outsiderOrgId,
      projectId,
      paginationOpts: firstPage,
    }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  // The two ids are checked against EACH OTHER, not just against the caller.
  // A member of both organizations can reach either on its own, so the only
  // thing standing between org A's list and org B's project is that cross-check.
  const both = await provision(t, 'services-two-orgs');
  const secondOrgId = await both.client.mutation(createOrganization, { name: 'Second', slug: 'services-second' });
  await owner.client.mutation(addMember, { organizationId, userId: both.userId, role: 'planner' });
  const secondProjectId = await both.client.mutation(createProject, {
    organizationId: secondOrgId,
    name: 'Second org project',
  });
  await expect(
    both.client.query(listOrganizationServices, { organizationId, projectId: secondProjectId, paginationOpts: firstPage }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  // Each id is genuinely reachable on its own, which is what makes the pairing
  // the thing under test rather than either membership.
  await expect(
    both.client.query(listOrganizationServices, { organizationId, projectId, paginationOpts: firstPage }),
  ).resolves.toBeDefined();
  await expect(
    both.client.query(listOrganizationServices, {
      organizationId: secondOrgId,
      projectId: secondProjectId,
      paginationOpts: firstPage,
    }),
  ).resolves.toBeDefined();
});

test('historical integrity: an service keeps validating against its own version after that version is retired (I3)', async () => {
  const { t, owner, eventId, serviceKindId, versionId, definitions, requiredCode, createService } = await fixture();
  const legalUnderV1: SubmittedValue = { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 8 } };
  const serviceId = await createService([requiredCode, { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 5 } }]);

  // v2 narrows the seat bound to 1..3. Narrowing a snapshot is legal composition;
  // it must not reach back into services already written against v1.
  const v2 = await owner.client.mutation(clonePublishedVersionToDraft, { serviceKindId });
  const draftRows = await owner.client.query(listServiceKindFields, { serviceKindVersionId: v2 });
  const seatsRow = draftRows.find((row) => row.fieldDefinitionId === definitions.seats);
  if (seatsRow === undefined) throw new Error('cloned seats row missing');
  await owner.client.mutation(updateServiceKindField, { serviceKindFieldId: seatsRow._id, config: { kind: 'number', min: 1, max: 3, integer: true } });

  // Mutating the still-draft v2 changes nothing for the v1 service.
  await expect(owner.client.mutation(updateServiceFields, { serviceId, values: [legalUnderV1] })).resolves.toBeNull();

  await owner.client.mutation(publishServiceKindVersion, { serviceKindVersionId: v2 });
  expect((await t.run(async (ctx) => ctx.db.get(versionId)))?.status).toBe('retired');

  // THE headline: the service's rules are v1's, and v1 is retired. A value legal
  // under v1 and illegal under v2 still succeeds — the update reads the service's
  // own serviceKindVersionId rows with no status filter.
  await expect(owner.client.mutation(updateServiceFields, { serviceId, values: [legalUnderV1] })).resolves.toBeNull();
  await t.run(async (ctx) => {
    const row = await ctx.db.query('serviceFieldValues').withIndex('by_service_field', (q) => q.eq('serviceId', serviceId).eq('fieldDefinitionId', definitions.seats)).unique();
    expect(row?.value).toEqual({ kind: 'number', value: 8 });
    // The row still points at v1's snapshot, not v2's replacement of it.
    expect((await ctx.db.get(row?.serviceKindFieldId ?? seatsRow._id))?.serviceKindVersionId).toBe(versionId);
  });

  // A value illegal under v1 fails with v1's rule, not v2's: 11 is above v1's
  // maximum of 10, and 8 (rejected by v2) was accepted above.
  await expect(
    owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 11 } }] }),
  ).rejects.toMatchObject({ data: { code: 'fieldValueRangeInvalid' } });

  // The service is still fully readable under the retired version.
  const service = await owner.client.query(getService, { serviceId });
  expect(service.service.serviceKindVersionId).toBe(versionId);
  expect(service.values.find((value) => value.key === 'seats')?.value).toEqual({ kind: 'number', value: 8 });

  // New services must use v2, and v2's narrower rule binds them.
  await expect(createService([requiredCode])).rejects.toMatchObject({ data: { code: 'serviceKindUnavailable' } });
  const fromV2 = (values: SubmittedValue[]) =>
    owner.client.mutation(createServiceFromServiceKind, { eventId, serviceKindVersionId: v2, name: 'Under v2', startsAt: 1000, values });
  await expect(fromV2([requiredCode, legalUnderV1])).rejects.toMatchObject({ data: { code: 'fieldValueRangeInvalid' } });
  await expect(fromV2([requiredCode, { fieldDefinitionId: definitions.seats, value: { kind: 'number', value: 3 } }])).resolves.toBeDefined();
});

test('field values upsert in place, clear, and re-set without ever duplicating a row', async () => {
  const { t, owner, definitions, requiredCode, createService } = await fixture();
  const serviceId = await createService([requiredCode, { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'first' } }]);
  const rowsFor = (fieldDefinitionId: Id<'fieldDefinitions'>) =>
    t.run(async (ctx) => ctx.db.query('serviceFieldValues').withIndex('by_service_field', (q) => q.eq('serviceId', serviceId).eq('fieldDefinitionId', fieldDefinitionId)).collect());

  // Two updates to the same field leave exactly one row: the second is a patch,
  // not a second insert.
  await owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'BB' } }] });
  await owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'CC' } }] });
  const codeRows = await rowsFor(definitions.code);
  expect(codeRows).toHaveLength(1);
  expect(codeRows[0]?.value).toEqual({ kind: 'text', value: 'CC' });

  // Clearing an optional value that exists removes the row; re-setting it inserts
  // exactly one again.
  await owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.notes, value: null }] });
  expect(await rowsFor(definitions.notes)).toHaveLength(0);
  await owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'again' } }] });
  expect(await rowsFor(definitions.notes)).toHaveLength(1);

  // Clearing an optional value that was never set is an accepted no-op.
  await expect(owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.tier, value: null }] })).resolves.toBeNull();
  expect(await rowsFor(definitions.tier)).toHaveLength(0);

  const duplicate: ClearableValue[] = [
    { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'DD' } },
    { fieldDefinitionId: definitions.code, value: { kind: 'text', value: 'EE' } },
  ];
  await expect(owner.client.mutation(updateServiceFields, { serviceId, values: duplicate })).rejects.toMatchObject({ data: { code: 'serviceFieldDuplicate' } });
  await expect(
    owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.code, value: null }] }),
  ).rejects.toMatchObject({ data: { code: 'serviceFieldRequired' } });

  // An unknown field is refused on the update path by the same single gate.
  const strayDefinition = await owner.client.mutation(createFieldDefinition, {
    organizationId: (await t.run(async (ctx) => (await ctx.db.get(serviceId))?.organizationId)) ?? (() => { throw new Error('service missing'); })(),
    key: 'stray',
    label: 'Stray',
    config: { kind: 'text' },
  });
  await expect(
    owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: strayDefinition, value: { kind: 'text', value: 'AB' } }] }),
  ).rejects.toMatchObject({ data: { code: 'serviceFieldUnknown' } });

  // A rejected submission wrote nothing: the required value survives intact.
  expect((await rowsFor(definitions.code))[0]?.value).toEqual({ kind: 'text', value: 'CC' });
});

test('S1 regression: resubmitting an unchanged value is not re-judged, even after its location is archived', async () => {
  const { t, owner, organizationId, definitions, locationId, requiredCode, createService } = await fixture();
  const venue: SubmittedValue = { fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId } };
  const serviceId = await createService([requiredCode, venue]);

  // The ordinary read-modify-write shape: load the service, change one field, send
  // the whole form back. The untouched location value must not be re-validated
  // against the world as it is now — it already passed this immutable snapshot
  // when it was written, and there is no way to "fix" it (the location has no
  // unarchive, and clearing the field is a different edit than the user made).
  await owner.client.mutation(archiveLocation, { locationId });
  await expect(
    owner.client.mutation(updateServiceFields, {
      serviceId,
      values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'changed' } }, venue],
    }),
  ).resolves.toBeNull();
  await t.run(async (ctx) => {
    const rows = await ctx.db.query('serviceFieldValues').withIndex('by_service_field', (q) => q.eq('serviceId', serviceId)).collect();
    expect(rows.find((row) => row.fieldDefinitionId === definitions.venue)?.value).toEqual({ kind: 'location', locationId });
    expect(rows.find((row) => row.fieldDefinitionId === definitions.notes)?.value).toEqual({ kind: 'longText', value: 'changed' });
  });
  // Only the field that moved is audited: the unchanged one is not an edit.
  await t.run(async (ctx) => {
    const audits = await ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'service').eq('entityId', serviceId))
      .collect();
    expect(audits.filter((audit) => audit.action === 'service.fieldsUpdated').map((audit) => audit.metadata.changedFields)).toEqual([definitions.notes]);
  });

  // Skipping the re-check is scoped to values that did NOT change: pointing the
  // field at the archived location as a real edit is still refused, and so is a
  // fresh service created against it.
  const otherLocationId = await owner.client.mutation(createLocation, { organizationId, name: 'Annex', type: 'venue' });
  await owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.venue, value: { kind: 'location', locationId: otherLocationId } }] });
  await expect(owner.client.mutation(updateServiceFields, { serviceId, values: [venue] })).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(createService([requiredCode, venue])).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('S3 regression: stored string values are capped absolutely, whatever the snapshot omits', async () => {
  const { owner, organizationId, eventId, requiredCode, createService } = await fixture();
  // A config with NO maxLength — the shape the seeded `notes` built-in ships —
  // is exactly the case where only the absolute ceiling stands between a tenant
  // and a multi-megabyte service that `getService` can never read back.
  const unbounded = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'freeform', label: 'Freeform', config: { kind: 'longText' } });
  const short = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'line', label: 'Line', config: { kind: 'text' } });
  const serviceKindId = await owner.client.mutation(createServiceKind, { organizationId, key: 'capsPlan', name: 'Caps plan' });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { serviceKindId });
  await owner.client.mutation(addServiceKindField, { serviceKindVersionId: versionId, fieldDefinitionId: unbounded, required: false, visible: true });
  await owner.client.mutation(addServiceKindField, { serviceKindVersionId: versionId, fieldDefinitionId: short, required: false, visible: true });
  await owner.client.mutation(publishServiceKindVersion, { serviceKindVersionId: versionId });
  const create = (values: SubmittedValue[]) =>
    owner.client.mutation(createServiceFromServiceKind, { eventId, serviceKindVersionId: versionId, name: 'Capped', startsAt: 1000, values });

  await expect(create([{ fieldDefinitionId: unbounded, value: { kind: 'longText', value: 'x'.repeat(10_001) } }])).rejects.toMatchObject({
    data: { code: 'fieldValueLengthInvalid' },
  });
  await expect(create([{ fieldDefinitionId: short, value: { kind: 'text', value: 'x'.repeat(2001) } }])).rejects.toMatchObject({
    data: { code: 'fieldValueLengthInvalid' },
  });
  // The bound is inclusive, and it applies on the update door too.
  const serviceId = await create([{ fieldDefinitionId: unbounded, value: { kind: 'longText', value: 'x'.repeat(10_000) } }]);
  await expect(
    owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: unbounded, value: { kind: 'longText', value: 'x'.repeat(10_001) } }] }),
  ).rejects.toMatchObject({ data: { code: 'fieldValueLengthInvalid' } });

  // The other half of the same rule: a config can promise less than the ceiling,
  // never more, so no snapshot can advertise a bound the value gate would refuse.
  await expect(
    owner.client.mutation(createFieldDefinition, { organizationId, key: 'tooWide', label: 'Too wide', config: { kind: 'longText', maxLength: 10_001 } }),
  ).rejects.toMatchObject({ data: { code: 'fieldConfigInvalid' } });
  await expect(
    owner.client.mutation(createFieldDefinition, { organizationId, key: 'tooWideText', label: 'Too wide text', config: { kind: 'text', maxLength: 2001 } }),
  ).rejects.toMatchObject({ data: { code: 'fieldConfigInvalid' } });
  // Untouched by the caps: the ordinary bounded fixture still accepts its values.
  await expect(createService([requiredCode])).resolves.toBeDefined();
});

test('the status matrix advances one step at a time, cancels from anywhere, and is terminal at both ends', async () => {
  const { owner, definitions, requiredCode, createService } = await fixture();
  const notPermitted = 'serviceStatusTransitionInvalid';
  const terminal = 'serviceTerminal';

  const forward = await createService();
  for (const status of ['planned', 'confirmed', 'active', 'completed'] as const) {
    await expect(owner.client.mutation(changeServiceStatus, { serviceId: forward, status })).resolves.toBeNull();
  }
  await expect(owner.client.mutation(changeServiceStatus, { serviceId: forward, status: 'cancelled' })).rejects.toMatchObject({ data: { code: terminal } });
  // Completed is read-only through both authoring doors, not only the status one.
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId: forward, name: 'Late edit' })).rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });
  await expect(
    owner.client.mutation(updateServiceFields, { serviceId: forward, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'late' } }] }),
  ).rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });

  // Skipping ahead, moving backwards, and re-declaring the current status are all
  // refused by the same matrix (the same-status case has no separate branch).
  const strict = await createService();
  await expect(owner.client.mutation(changeServiceStatus, { serviceId: strict, status: 'confirmed' })).rejects.toMatchObject({ data: { code: notPermitted } });
  await expect(owner.client.mutation(changeServiceStatus, { serviceId: strict, status: 'draft' })).rejects.toMatchObject({ data: { code: notPermitted } });
  await owner.client.mutation(changeServiceStatus, { serviceId: strict, status: 'planned' });
  await expect(owner.client.mutation(changeServiceStatus, { serviceId: strict, status: 'planned' })).rejects.toMatchObject({ data: { code: notPermitted } });
  await expect(owner.client.mutation(changeServiceStatus, { serviceId: strict, status: 'draft' })).rejects.toMatchObject({ data: { code: notPermitted } });
  await expect(owner.client.mutation(changeServiceStatus, { serviceId: strict, status: 'completed' })).rejects.toMatchObject({ data: { code: notPermitted } });

  // Cancellation is reachable from every non-terminal state.
  for (const path of [[], ['planned'], ['planned', 'confirmed'], ['planned', 'confirmed', 'active']] as const) {
    const serviceId = await createService([requiredCode]);
    for (const status of path) await owner.client.mutation(changeServiceStatus, { serviceId, status });
    await expect(owner.client.mutation(changeServiceStatus, { serviceId, status: 'cancelled' })).resolves.toBeNull();
    // Cancelled is terminal in every direction, and read-only for authoring.
    await expect(owner.client.mutation(changeServiceStatus, { serviceId, status: 'planned' })).rejects.toMatchObject({ data: { code: terminal } });
    await expect(owner.client.mutation(changeServiceStatus, { serviceId, status: 'cancelled' })).rejects.toMatchObject({ data: { code: terminal } });
    await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, name: 'Nope' })).rejects.toMatchObject({ data: { code: 'serviceReadOnly' } });
  }
});

test('every service operation writes an attributed audit row naming what changed, and no-ops write none', async () => {
  const { t, owner, organizationId, versionId, definitions, requiredCode, createService } = await fixture();
  const planner = await provision(t, 'services-audit-planner');
  await owner.client.mutation(addMember, { organizationId, userId: planner.userId, role: 'planner' });
  const serviceId = await createService([requiredCode, { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'first' } }]);

  await planner.client.mutation(updateServiceCoreFields, { serviceId, name: 'Renamed', startsAt: 1500 });
  // A core-field patch that changes nothing must not write an empty audit row.
  await planner.client.mutation(updateServiceCoreFields, { serviceId, name: 'Renamed' });
  await planner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'second' } }] });
  // Neither must a value submission that echoes what is already stored, nor an
  // empty one, nor clearing an already-absent optional value.
  await planner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'second' } }] });
  await planner.client.mutation(updateServiceFields, { serviceId, values: [] });
  await planner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.tier, value: null }] });
  await owner.client.mutation(changeServiceStatus, { serviceId, status: 'planned' });

  const cancelled = await createService();
  await owner.client.mutation(changeServiceStatus, { serviceId: cancelled, status: 'cancelled' });

  await t.run(async (ctx) => {
    const auditsFor = (entityId: string) =>
      ctx.db
        .query('auditEvents')
        .withIndex('by_org_entity', (q) => q.eq('organizationId', organizationId).eq('entityType', 'service').eq('entityId', entityId))
        .collect();

    const audits = await auditsFor(serviceId);
    // Core-column edits and typed-value edits are DIFFERENT actions on purpose:
    // both write `metadata.changedFields`, but one holds column names and the
    // other holds field-definition ids, and a log consumer must not have to sniff
    // the value to tell which vocabulary it is reading.
    expect(audits.map((audit) => audit.action)).toEqual(['service.created', 'service.updated', 'service.fieldsUpdated', 'service.statusChanged']);
    expect(audits.every((audit) => audit.organizationId === organizationId)).toBe(true);
    expect(audits[0]).toMatchObject({ actorUserId: owner.userId, metadata: { serviceKindVersionId: versionId } });
    expect(audits[1]).toMatchObject({ actorUserId: planner.userId, metadata: { changedFields: 'name,startsAt' } });
    // The value update names the field definitions that actually changed, matching
    // the changedFields convention used by projects, serviceKinds, and locations.
    expect(audits[2]).toMatchObject({ actorUserId: planner.userId, metadata: { changedFields: definitions.notes } });
    expect(audits[3]).toMatchObject({ actorUserId: owner.userId, metadata: { previousStatus: 'draft' } });

    // Cancellation is its own action, so the terminal removal path is greppable.
    const cancelledAudits = await auditsFor(cancelled);
    expect(cancelledAudits.map((audit) => audit.action)).toEqual(['service.created', 'service.cancelled']);
    expect(cancelledAudits[1]).toMatchObject({ metadata: { previousStatus: 'draft' } });
  });
});

test('service queries paginate by start time, stay tenant-scoped, and join live definition metadata', async () => {
  const { t, owner, organizationId, projectId, definitions, requiredCode, createService } = await fixture();
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Other', slug: 'services-query-foreign' });
  const foreignProjectId = await owner.client.mutation(createProject, { organizationId: foreignOrganizationId, name: 'Theirs' });
  const foreignEventId = await owner.client.mutation(createEvent, { projectId: foreignProjectId, name: 'Theirs', startsAt: 0 });
  const member = await provision(t, 'services-query-member');
  await owner.client.mutation(addMember, { organizationId, userId: member.userId, role: 'viewer' });

  // Inserted out of order; the index orders them by start time.
  const late = await createService([requiredCode], { startsAt: 300 });
  const early = await createService([requiredCode], { startsAt: 100 });
  const middle = await createService([requiredCode], { startsAt: 200 });

  const first = await member.client.query(listProjectServices, { projectId, paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page.map((row) => row._id)).toEqual([early, middle]);
  expect(first.isDone).toBe(false);
  const second = await member.client.query(listProjectServices, { projectId, paginationOpts: { numItems: 2, cursor: first.continueCursor } });
  expect(second.page.map((row) => row._id)).toEqual([late]);
  expect(second.isDone).toBe(true);
  expect(second.page.every((row) => row.organizationId === organizationId)).toBe(true);

  // A project in another tenant is opaque even to a member of this one.
  await expect(member.client.query(listProjectServices, { projectId: foreignProjectId, paginationOpts: firstPage })).rejects.toMatchObject({ data: { code: inaccessible } });

  // The live join contract: `key` is frozen for any definition an service can
  // reference (renaming it is refused), while `label` follows the definition and
  // archival does not hide stored values.
  const serviceId = await createService([requiredCode, { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'joined' } }]);
  await expect(owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: definitions.notes, key: 'renamedNotes' })).rejects.toMatchObject({
    data: { code: 'fieldHistoricalFrozen' },
  });
  await owner.client.mutation(updateFieldDefinition, { fieldDefinitionId: definitions.notes, label: 'Operator notes' });
  await owner.client.mutation(archiveFieldDefinition, { fieldDefinitionId: definitions.notes });
  const service = await member.client.query(getService, { serviceId });
  expect(service.values.find((value) => value.fieldDefinitionId === definitions.notes)).toEqual({
    fieldDefinitionId: definitions.notes,
    key: 'serviceNotes',
    label: 'Operator notes',
    value: { kind: 'longText', value: 'joined' },
  });

  // A foreign service id is opaque through getService too.
  const foreignServiceKindId = await owner.client.mutation(createServiceKind, { organizationId: foreignOrganizationId, key: 'servicePlan', name: 'Theirs' });
  const foreignVersionId = await owner.client.mutation(createInitialDraftVersion, { serviceKindId: foreignServiceKindId });
  const foreignField = await owner.client.mutation(createFieldDefinition, { organizationId: foreignOrganizationId, key: 'code', label: 'Code', config: { kind: 'text' } });
  await owner.client.mutation(addServiceKindField, { serviceKindVersionId: foreignVersionId, fieldDefinitionId: foreignField, required: false, visible: true });
  await owner.client.mutation(publishServiceKindVersion, { serviceKindVersionId: foreignVersionId });
  const foreignServiceId = await owner.client.mutation(createServiceFromServiceKind, {
    eventId: foreignEventId,
    serviceKindVersionId: foreignVersionId,
    name: 'Theirs',
    startsAt: 1,
    values: [],
  });
  await expect(member.client.query(getService, { serviceId: foreignServiceId })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('F3 regression: configured defaults are materialized at creation, before the required-field check', async () => {
  const { t, owner, organizationId, eventId, locationId } = await fixture();
  // A fresh serviceKind whose fields carry defaults, including a REQUIRED one: the
  // default is what makes omitting it legal.
  const label = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'shift', label: 'Shift', config: { kind: 'text', maxLength: 8 } });
  const tier = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'grade', label: 'Grade', config: { kind: 'select', options: [{ id: 'gold', label: 'Gold' }, { id: 'silver', label: 'Silver' }] } });
  const spot = await owner.client.mutation(createFieldDefinition, { organizationId, key: 'spot', label: 'Spot', config: { kind: 'location' } });
  const defaultsServiceKindId = await owner.client.mutation(createServiceKind, { organizationId, key: 'defaultsPlan', name: 'Defaults plan' });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { serviceKindId: defaultsServiceKindId });
  await owner.client.mutation(addServiceKindField, { serviceKindVersionId: versionId, fieldDefinitionId: label, required: true, visible: true, defaultValue: { kind: 'text', value: 'MORNING' } });
  await owner.client.mutation(addServiceKindField, { serviceKindVersionId: versionId, fieldDefinitionId: tier, required: false, visible: true, defaultValue: { kind: 'select', optionId: 'silver' } });
  await owner.client.mutation(addServiceKindField, { serviceKindVersionId: versionId, fieldDefinitionId: spot, required: false, visible: true, defaultValue: { kind: 'location', locationId } });
  await owner.client.mutation(publishServiceKindVersion, { serviceKindVersionId: versionId });

  const create = (values: SubmittedValue[]) =>
    owner.client.mutation(createServiceFromServiceKind, { eventId, serviceKindVersionId: versionId, name: 'Defaulted', startsAt: 1000, values });

  // A required field with a configured default succeeds when omitted, and every
  // default is materialized as a real stored value.
  const serviceId = await create([]);
  const service = await owner.client.query(getService, { serviceId });
  expect(service.values.map((value) => [value.key, value.value]).sort()).toEqual(
    [['shift', { kind: 'text', value: 'MORNING' }], ['grade', { kind: 'select', optionId: 'silver' }], ['spot', { kind: 'location', locationId }]].sort(),
  );
  // The location default carries its mirror like any other stored value.
  await t.run(async (ctx) => {
    expect(await ctx.db.query('serviceFieldValues').withIndex('by_location', (q) => q.eq('locationId', locationId)).collect()).toHaveLength(1);
  });

  // A submitted value wins over the default; only the omitted rows are filled in.
  const overridden = await create([{ fieldDefinitionId: label, value: { kind: 'text', value: 'NIGHT' } }]);
  const overriddenService = await owner.client.query(getService, { serviceId: overridden });
  expect(overriddenService.values.find((value) => value.key === 'shift')?.value).toEqual({ kind: 'text', value: 'NIGHT' });

  // Materialized defaults go through the same gate as submitted values: once the
  // defaulted location is archived, creation fails rather than storing it blind.
  await owner.client.mutation(archiveLocation, { locationId });
  await expect(create([])).rejects.toMatchObject({ data: { code: inaccessible } });

  // Defaults are a creation-time concept: updating never re-materializes them, so
  // an optional value cleared after creation stays cleared.
  await owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: tier, value: null }] });
  const afterClear = await owner.client.query(getService, { serviceId });
  expect(afterClear.values.some((value) => value.key === 'grade')).toBe(false);
});

test('F2 regression: an archived project freezes its services through every write door', async () => {
  const { t, owner, projectId, definitions, requiredCode, createService } = await fixture();
  const serviceId = await createService([requiredCode, { fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'before' } }]);
  await owner.client.mutation(changeServiceStatus, { serviceId, status: 'planned' });

  // Archiving is allowed regardless of how many services the project holds — the
  // services are frozen, not refused or cascaded.
  await expect(owner.client.mutation(archiveProject, { projectId })).resolves.toBeNull();

  const frozen = 'serviceProjectReadOnly';
  await expect(owner.client.mutation(updateServiceCoreFields, { serviceId, name: 'Nope' })).rejects.toMatchObject({ data: { code: frozen } });
  await expect(
    owner.client.mutation(updateServiceFields, { serviceId, values: [{ fieldDefinitionId: definitions.notes, value: { kind: 'longText', value: 'after' } }] }),
  ).rejects.toMatchObject({ data: { code: frozen } });
  // Including cancellation: an archived project freezes the lifecycle entirely.
  await expect(owner.client.mutation(changeServiceStatus, { serviceId, status: 'confirmed' })).rejects.toMatchObject({ data: { code: frozen } });
  await expect(owner.client.mutation(changeServiceStatus, { serviceId, status: 'cancelled' })).rejects.toMatchObject({ data: { code: frozen } });

  // Frozen means read-only, not gone: the service is untouched and still readable.
  const service = await owner.client.query(getService, { serviceId });
  expect(service.service).toMatchObject({ name: 'Arrival', status: 'planned' });
  expect(service.values.find((value) => value.key === 'serviceNotes')?.value).toEqual({ kind: 'longText', value: 'before' });
  await expect(owner.client.query(listProjectServices, { projectId, paginationOpts: firstPage })).resolves.toMatchObject({ isDone: true });
  await t.run(async (ctx) => {
    expect(await ctx.db.query('services').withIndex('by_project', (q) => q.eq('projectId', projectId)).collect()).toHaveLength(1);
  });
});
