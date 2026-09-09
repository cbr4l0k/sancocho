import { convexTest } from 'convex-test';
import * as ts from 'typescript';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { recordAuditEvent } from '../convex/audit/model';
import {
  auditActorFor,
  providerCapabilitySet,
  requirePrincipalForProject,
  type Capability,
  type ProjectIntent,
} from '../convex/lib/access';
import schema from '../convex/schema';
import { modules } from './helpers';

/**
 * The second principal arm (#71): the `Principal` union, the
 * `providerAccessGrants` table, the closed capability set, and the single gate
 * `requirePrincipalForProject`.
 *
 * Four Assignment-level tests named by this issue live in #67 and one in #87,
 * because `assignments` and `providerServiceProjection` do not exist yet. They
 * are deliberately NOT stubbed here: a placeholder that asserts nothing is worse
 * than a tracked gap.
 */

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProject = api.projects.mutations.createProject;
const archiveProject = api.projects.mutations.archiveProject;
const createEvent = api.events.mutations.createEvent;
const createLocation = api.locations.mutations.createLocation;
const createCostCentre = api.costCentres.mutations.createCostCentre;
const createFieldDefinition = api.fields.mutations.createFieldDefinition;
const createServiceKind = api.serviceKinds.mutations.createServiceKind;
const createInitialDraftVersion = api.serviceKinds.mutations.createInitialDraftVersion;
const addServiceKindField = api.serviceKinds.fields.mutations.addServiceKindField;
const publishServiceKindVersion = api.serviceKinds.mutations.publishServiceKindVersion;
const createServiceFromServiceKind = api.services.mutations.createServiceFromServiceKind;
const createProvider = api.providers.mutations.createProvider;
const archiveProvider = api.providers.mutations.archiveProvider;
const deleteProvider = api.providers.mutations.deleteProvider;
const grantProjectAccessToProvider = api.providers.mutations.grantProjectAccessToProvider;
const revokeProviderAccessGrant = api.providers.mutations.revokeProviderAccessGrant;
const listProjectProviderAccessGrants = api.providers.queries.listProjectProviderAccessGrants;

const getProject = api.projects.queries.getProject;
const listProjects = api.projects.queries.listProjects;
const getService = api.services.queries.getService;
const listProjectServices = api.services.queries.listProjectServices;
const listOrganizationServices = api.services.queries.listOrganizationServices;
const getServiceKind = api.serviceKinds.queries.getServiceKind;
const listServiceKinds = api.serviceKinds.queries.listServiceKinds;
const getServiceKindVersion = api.serviceKinds.queries.getServiceKindVersion;
const listServiceKindFields = api.serviceKinds.fields.queries.listServiceKindFields;
const getLocation = api.locations.queries.getLocation;
const listLocations = api.locations.queries.listLocations;
const getCostCentre = api.costCentres.queries.getCostCentre;
const listCostCentres = api.costCentres.queries.listCostCentres;
const getEvent = api.events.queries.getEvent;
const listProjectEvents = api.events.queries.listProjectEvents;
const listProviders = api.providers.queries.listProviders;
const listFieldDefinitions = api.fields.queries.listFieldDefinitions;

const inaccessible = 'notFoundOrInaccessible';
const unauthenticated = 'unauthenticated';
const issuer = 'https://example.clerk.accounts.dev';
const firstPage = { numItems: 10, cursor: null };

/** The complete grant vocabulary, sorted, as the closed set must resolve. */
const everyCapability: Capability[] = [
  'readAssignment',
  'readLinkedServiceProjection',
  'respondToTerms',
  'writeExecution',
];

type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;
type Client = ReturnType<SchemaTest['withIdentity']>;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId: Id<'users'> = await client.mutation(ensureUser, {});
  return { client, userId };
}

/**
 * Stands in for #86's verified claim mutation, which does not exist yet — the
 * same stand-in `providers.test.ts` already uses. Passing `undefined` revokes
 * the claim, which is the shape #86's revocation will take.
 */
function setClaim(t: SchemaTest, providerId: Id<'providers'>, linkedOrganizationId: Id<'organizations'> | undefined) {
  return t.run(async (ctx) => ctx.db.patch(providerId, { linkedOrganizationId }));
}

/**
 * A JSON-safe restatement of a resolved `Principal`.
 *
 * The gate is called through an INLINE query so the resolution runs against a
 * real query context under a real identity — exactly how #67's
 * `requireAssignmentAccess` will reach it. convex-test serializes an inline
 * function's return value as a Convex value, and `capabilities` is a `Set`, so
 * the shape is flattened here rather than returned raw.
 */
type PrincipalSummary =
  | { kind: 'member'; userId: Id<'users'>; organizationId: Id<'organizations'>; role: string }
  | {
      kind: 'provider';
      userId: Id<'users'>;
      providerId: Id<'providers'>;
      providerOrganizationId: Id<'organizations'>;
      grantId: Id<'providerAccessGrants'>;
      capabilities: string[];
      accessibleProviderIds: Id<'providers'>[];
    };

function resolvePrincipal(client: Client, projectId: Id<'projects'>, intent: ProjectIntent): Promise<PrincipalSummary> {
  return client.query(async (ctx): Promise<PrincipalSummary> => {
    const principal = await requirePrincipalForProject(ctx, projectId, intent);
    if (principal.kind === 'member') {
      return {
        kind: 'member',
        userId: principal.user._id,
        organizationId: principal.organization._id,
        role: principal.membership.role,
      };
    }
    return {
      kind: 'provider',
      userId: principal.user._id,
      providerId: principal.providerId,
      providerOrganizationId: principal.providerOrganizationId,
      grantId: principal.grantId,
      capabilities: [...principal.capabilities].sort(),
      accessibleProviderIds: [...principal.accessibleProviderIds],
    };
  });
}

/** The thrown error, captured whole, so two refusals can be compared field for field (I9). */
async function refusal(promise: Promise<unknown>): Promise<{ message: string; data: unknown }> {
  try {
    await promise;
  } catch (error) {
    const thrown = error as { message: string; data: unknown };
    return { message: thrown.message, data: thrown.data };
  }
  throw new Error('Expected the call to be refused, but it resolved');
}

/**
 * Coordinator tenant (a festival producer) with a full catalogue, a provider
 * firm in its OWN separate tenant, a claimed directory row linking the two, and
 * a grant on exactly one of the coordinator's two projects.
 */
async function fixture() {
  const t = convexTest(schema, modules);

  const coordinator = await provision(t, 'grants-coordinator');
  const organizationId = await coordinator.client.mutation(createOrganization, { name: 'Andes Producciones', slug: 'grants-coordinator' });
  const projectId = await coordinator.client.mutation(createProject, { organizationId, name: 'Festival Cordillera' });
  // The ADJACENT project: same coordinator, same provider, no grant.
  const otherProjectId = await coordinator.client.mutation(createProject, { organizationId, name: 'Feria del Libro' });

  const locationId = await coordinator.client.mutation(createLocation, { organizationId, name: 'Parque Simón Bolívar', type: 'venue' });
  const costCentreId = await coordinator.client.mutation(createCostCentre, { organizationId, key: 'clienteA', name: 'Cliente A' });
  const eventId = await coordinator.client.mutation(createEvent, { projectId, name: 'Día 1', startsAt: 1_000 });

  const fieldDefinitionId = await coordinator.client.mutation(createFieldDefinition, {
    organizationId,
    key: 'code',
    label: 'Code',
    config: { kind: 'text', minLength: 1, maxLength: 8 },
  });
  const serviceKindId = await coordinator.client.mutation(createServiceKind, { organizationId, key: 'transfer', name: 'Traslado' });
  const serviceKindVersionId = await coordinator.client.mutation(createInitialDraftVersion, { serviceKindId });
  await coordinator.client.mutation(addServiceKindField, { serviceKindVersionId, fieldDefinitionId, required: true, visible: true });
  await coordinator.client.mutation(publishServiceKindVersion, { serviceKindVersionId });
  const serviceId = await coordinator.client.mutation(createServiceFromServiceKind, {
    eventId,
    serviceKindVersionId,
    name: 'Traslado aeropuerto',
    startsAt: 1_000,
    values: [{ fieldDefinitionId, value: { kind: 'text', value: 'AB' } }],
  });

  // The provider firm is its OWN tenant, with its own owner and its own ladder.
  const providerFirm = await provision(t, 'grants-provider-owner');
  const providerOrganizationId = await providerFirm.client.mutation(createOrganization, { name: 'TransAndes', slug: 'grants-provider' });
  const providerId = await coordinator.client.mutation(createProvider, { organizationId, name: 'TransAndes SAS', notes: 'Preferred vans supplier' });
  await setClaim(t, providerId, providerOrganizationId);

  const grantStartedAt = Date.now();
  const grantId: Id<'providerAccessGrants'> = await coordinator.client.mutation(grantProjectAccessToProvider, { projectId, providerId });
  const grantFinishedAt = Date.now();

  return {
    t,
    coordinator,
    organizationId,
    projectId,
    otherProjectId,
    eventId,
    serviceId,
    serviceKindId,
    serviceKindVersionId,
    fieldDefinitionId,
    locationId,
    costCentreId,
    providerFirm,
    providerOrganizationId,
    providerId,
    grantId,
    grantStartedAt,
    grantFinishedAt,
  };
}

// ---------------------------------------------------------------------------
// The closed capability set
// ---------------------------------------------------------------------------

test('a granted Provider Principal resolves with exactly the four capabilities and no others', async () => {
  const f = await fixture();

  const principal = await resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment');
  expect(principal.kind).toBe('provider');
  if (principal.kind !== 'provider') throw new Error('unreachable');

  // Exact equality, not `toContain`: a fifth member — `readProject`, say — must
  // fail here, which is the whole point of a set that is closed in code.
  expect(principal.capabilities).toEqual(everyCapability);
  expect(principal.accessibleProviderIds).toEqual([f.providerId]);
  expect(principal.providerId).toBe(f.providerId);
  expect(principal.providerOrganizationId).toBe(f.providerOrganizationId);
  expect(principal.grantId).toBe(f.grantId);
  expect(principal.userId).toBe(f.providerFirm.userId);

  // Every enumerated intent resolves; nothing in the set implies anything else
  // in it, so each is asked separately rather than through one representative.
  for (const intent of everyCapability) {
    await expect(resolvePrincipal(f.providerFirm.client, f.projectId, intent)).resolves.toMatchObject({ kind: 'provider' });
  }
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'writeAssignmentTerms'))
    .rejects.toMatchObject({ data: { code: inaccessible } });

  // The exported set is the same closed set, and it is a copy: mutating what a
  // caller receives cannot narrow the next principal's reach.
  const exported = providerCapabilitySet();
  expect([...exported].sort()).toEqual(everyCapability);
  expect(exported.size).toBe(4);
  (exported as Set<Capability>).delete('writeExecution');
  const second = await resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment');
  expect(second.kind === 'provider' && second.capabilities).toEqual(everyCapability);
  expect([...providerCapabilitySet()].sort()).toEqual(everyCapability);

  await f.providerFirm.client.query(async (ctx) => {
    const principal = await requirePrincipalForProject(ctx, f.projectId, 'readAssignment');
    if (principal.kind !== 'provider') throw new Error('unreachable');
    (principal.capabilities as Set<Capability>).delete('respondToTerms');
  });
  const third = await resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment');
  expect(third.kind === 'provider' && third.capabilities).toEqual(everyCapability);
});

test('the member arm answers the same intents by role rank, and never carries a capability set', async () => {
  const f = await fixture();
  const viewer = await provision(f.t, 'grants-viewer');
  const operator = await provision(f.t, 'grants-operator');
  const planner = await provision(f.t, 'grants-planner');
  await f.coordinator.client.mutation(addMember, { organizationId: f.organizationId, userId: viewer.userId, role: 'viewer' });
  await f.coordinator.client.mutation(addMember, { organizationId: f.organizationId, userId: operator.userId, role: 'operator' });
  await f.coordinator.client.mutation(addMember, { organizationId: f.organizationId, userId: planner.userId, role: 'planner' });

  await expect(resolvePrincipal(viewer.client, f.projectId, 'readAssignment')).resolves.toMatchObject({ kind: 'member', role: 'viewer' });
  await expect(resolvePrincipal(viewer.client, f.projectId, 'readLinkedServiceProjection')).resolves.toMatchObject({ kind: 'member', role: 'viewer' });
  await expect(resolvePrincipal(viewer.client, f.projectId, 'writeExecution')).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(resolvePrincipal(operator.client, f.projectId, 'writeExecution')).resolves.toMatchObject({ kind: 'member' });
  await expect(resolvePrincipal(operator.client, f.projectId, 'respondToTerms')).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(resolvePrincipal(planner.client, f.projectId, 'respondToTerms')).resolves.toMatchObject({ kind: 'member' });

  // A member principal publishes no capabilities: the two vocabularies never compose.
  const resolved = await resolvePrincipal(planner.client, f.projectId, 'readAssignment');
  expect(resolved).not.toHaveProperty('capabilities');
});

test('a coordinator member cannot fall through to their Provider grant when their member role is too low', async () => {
  const f = await fixture();
  await f.coordinator.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: f.providerFirm.userId,
    role: 'viewer',
  });

  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'writeExecution')).rejects.toMatchObject({
    data: { code: inaccessible },
  });
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'respondToTerms')).rejects.toMatchObject({
    data: { code: inaccessible },
  });
});

test('an unauthenticated caller is refused by the gate before any id is loaded', async () => {
  const f = await fixture();
  const anonymous = f.t.withIdentity({ issuer, subject: 'nobody' });
  // No `ensureUser`: there is an identity but no app user.
  await expect(resolvePrincipal(anonymous, f.projectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });

  await expect(
    f.t.query(async (ctx) => requirePrincipalForProject(ctx, f.projectId, 'readAssignment')),
  ).rejects.toMatchObject({ data: { code: unauthenticated } });
});

test('every grant entry point authenticates before loading real or dangling caller-supplied ids', async () => {
  const f = await fixture();
  const { goneProjectId, goneGrantId } = await f.t.run(async (ctx) => {
    const organizationId = await ctx.db.insert('organizations', { name: 'Gone auth', slug: 'grants-gone-auth' });
    const projectId = await ctx.db.insert('projects', { organizationId, name: 'Gone auth', status: 'draft' });
    const grantId = await ctx.db.insert('providerAccessGrants', {
      organizationId,
      providerId: f.providerId,
      providerOrganizationId: f.providerOrganizationId,
      projectId,
      status: 'active',
      grantedByUserId: f.coordinator.userId,
      grantedAt: Date.now(),
    });
    await ctx.db.delete(grantId);
    await ctx.db.delete(projectId);
    return { goneProjectId: projectId, goneGrantId: grantId };
  });

  const anonymousGateReal = await refusal(
    f.t.query(async (ctx) => requirePrincipalForProject(ctx, f.projectId, 'readAssignment')),
  );
  const anonymousGateGone = await refusal(
    f.t.query(async (ctx) => requirePrincipalForProject(ctx, goneProjectId, 'readAssignment')),
  );
  expect(anonymousGateGone).toEqual(anonymousGateReal);
  expect(anonymousGateReal.data).toEqual({ code: unauthenticated });

  const anonymousGrantReal = await refusal(
    f.t.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: f.providerId }),
  );
  const anonymousGrantGone = await refusal(
    f.t.mutation(grantProjectAccessToProvider, { projectId: goneProjectId, providerId: f.providerId }),
  );
  expect(anonymousGrantGone).toEqual(anonymousGrantReal);
  expect(anonymousGrantReal.data).toEqual({ code: unauthenticated });

  const anonymousRevokeReal = await refusal(f.t.mutation(revokeProviderAccessGrant, { grantId: f.grantId }));
  const anonymousRevokeGone = await refusal(f.t.mutation(revokeProviderAccessGrant, { grantId: goneGrantId }));
  expect(anonymousRevokeGone).toEqual(anonymousRevokeReal);
  expect(anonymousRevokeReal.data).toEqual({ code: unauthenticated });

  const anonymousListReal = await refusal(
    f.t.query(listProjectProviderAccessGrants, { projectId: f.projectId, paginationOpts: firstPage }),
  );
  const anonymousListGone = await refusal(
    f.t.query(listProjectProviderAccessGrants, { projectId: goneProjectId, paginationOpts: firstPage }),
  );
  expect(anonymousListGone).toEqual(anonymousListReal);
  expect(anonymousListReal.data).toEqual({ code: unauthenticated });

  // An identity without an app user follows the same field-identical rule, but
  // its refusal is the generic code so it cannot disclose whether the user or
  // target id was the missing link.
  const noUser = f.t.withIdentity(identity('grants-auth-no-user'));
  const noUserGateReal = await refusal(resolvePrincipal(noUser, f.projectId, 'readAssignment'));
  const noUserGateGone = await refusal(resolvePrincipal(noUser, goneProjectId, 'readAssignment'));
  expect(noUserGateGone).toEqual(noUserGateReal);
  expect(noUserGateReal.data).toEqual({ code: inaccessible });

  const noUserGrantReal = await refusal(
    noUser.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: f.providerId }),
  );
  const noUserGrantGone = await refusal(
    noUser.mutation(grantProjectAccessToProvider, { projectId: goneProjectId, providerId: f.providerId }),
  );
  expect(noUserGrantGone).toEqual(noUserGrantReal);
  expect(noUserGrantReal.data).toEqual({ code: inaccessible });

  const noUserRevokeReal = await refusal(noUser.mutation(revokeProviderAccessGrant, { grantId: f.grantId }));
  const noUserRevokeGone = await refusal(noUser.mutation(revokeProviderAccessGrant, { grantId: goneGrantId }));
  expect(noUserRevokeGone).toEqual(noUserRevokeReal);
  expect(noUserRevokeReal.data).toEqual({ code: inaccessible });

  const noUserListReal = await refusal(
    noUser.query(listProjectProviderAccessGrants, { projectId: f.projectId, paginationOpts: firstPage }),
  );
  const noUserListGone = await refusal(
    noUser.query(listProjectProviderAccessGrants, { projectId: goneProjectId, paginationOpts: firstPage }),
  );
  expect(noUserListGone).toEqual(noUserListReal);
  expect(noUserListReal.data).toEqual({ code: inaccessible });
});

// ---------------------------------------------------------------------------
// What a granted Provider may NOT read (docs/provider-access.md)
// ---------------------------------------------------------------------------

test('a granted Provider cannot read the Project, its Events, Services, Service Kinds, Locations or Cost Centres', async () => {
  const f = await fixture();
  const provider = f.providerFirm.client;
  const expectRefused = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ data: { code: inaccessible } });

  // 1. The Project itself — the very Project the grant names.
  await expectRefused(provider.query(getProject, { projectId: f.projectId }));
  await expectRefused(provider.query(listProjects, { organizationId: f.organizationId, paginationOpts: firstPage }));
  // The Event layer hanging off it.
  await expectRefused(provider.query(getEvent, { eventId: f.eventId }));
  await expectRefused(provider.query(listProjectEvents, { projectId: f.projectId, paginationOpts: firstPage }));
  // 2. Services in the granted Project.
  await expectRefused(provider.query(getService, { serviceId: f.serviceId }));
  await expectRefused(provider.query(listProjectServices, { projectId: f.projectId, paginationOpts: firstPage }));
  await expectRefused(provider.query(listOrganizationServices, { organizationId: f.organizationId, paginationOpts: firstPage }));
  // 5. Service Kinds, their versions, their fields, and the Field Definition catalogue.
  await expectRefused(provider.query(getServiceKind, { serviceKindId: f.serviceKindId }));
  await expectRefused(provider.query(listServiceKinds, { organizationId: f.organizationId, paginationOpts: firstPage }));
  await expectRefused(provider.query(getServiceKindVersion, { serviceKindVersionId: f.serviceKindVersionId }));
  await expectRefused(provider.query(listServiceKindFields, { serviceKindVersionId: f.serviceKindVersionId }));
  await expectRefused(provider.query(listFieldDefinitions, { organizationId: f.organizationId, paginationOpts: firstPage }));
  // 6. The Locations catalogue.
  await expectRefused(provider.query(getLocation, { locationId: f.locationId }));
  await expectRefused(provider.query(listLocations, { organizationId: f.organizationId, paginationOpts: firstPage }));
  // 7. Cost Centres.
  await expectRefused(provider.query(getCostCentre, { costCentreId: f.costCentreId }));
  await expectRefused(provider.query(listCostCentres, { organizationId: f.organizationId, paginationOpts: firstPage }));
  // 4. Any other Provider's existence: the coordinator's directory is not browsable.
  await expectRefused(provider.query(listProviders, { organizationId: f.organizationId, paginationOpts: firstPage }));
  // Nor who else the coordinator let in.
  await expectRefused(provider.query(listProjectProviderAccessGrants, { projectId: f.projectId, paginationOpts: firstPage }));

  // Rate Cards are #66 and statistics were deleted in #93; there is deliberately
  // no placeholder here for either. The grant nevertheless resolves, so the
  // refusals above are the gate working, not a missing grant.
  await expect(resolvePrincipal(provider, f.projectId, 'readAssignment')).resolves.toMatchObject({ kind: 'provider' });
});

// ---------------------------------------------------------------------------
// Revocation, scope, and I9
// ---------------------------------------------------------------------------

test('a revoked grant loses access on the very next call, and nothing caches the previous answer', async () => {
  const f = await fixture();

  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).resolves.toMatchObject({ kind: 'provider' });

  const revokeStartedAt = Date.now();
  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });
  const revokeFinishedAt = Date.now();
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });
  // Every intent, not just the one that was exercised while it was live.
  for (const intent of everyCapability) {
    await expect(resolvePrincipal(f.providerFirm.client, f.projectId, intent)).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  await f.t.run(async (ctx) => {
    const grant = await ctx.db.get(f.grantId);
    expect(grant?.status).toBe('revoked');
    expect(grant?.revokedAt).toBeGreaterThanOrEqual(revokeStartedAt);
    expect(grant?.revokedAt).toBeLessThanOrEqual(revokeFinishedAt);
  });

  // Reinstating restores it on the next call too — the answer is read off the
  // row every time, in both directions.
  const reinstated = await f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: f.providerId });
  expect(reinstated).toBe(f.grantId);
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).resolves.toMatchObject({ kind: 'provider', grantId: f.grantId });
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.grantId))?.revokedAt).toBeUndefined();
  });

  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('a grant for Project A confers nothing on Project B, same Provider and same coordinator', async () => {
  const f = await fixture();

  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).resolves.toMatchObject({ kind: 'provider' });
  for (const intent of everyCapability) {
    await expect(resolvePrincipal(f.providerFirm.client, f.otherProjectId, intent)).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  await expect(f.providerFirm.client.query(getProject, { projectId: f.otherProjectId })).rejects.toMatchObject({ data: { code: inaccessible } });

  // And a project in a THIRD tenant the provider has never been near.
  const stranger = await provision(f.t, 'grants-stranger');
  const strangerOrganizationId = await stranger.client.mutation(createOrganization, { name: 'Otra', slug: 'grants-stranger' });
  const strangerProjectId = await stranger.client.mutation(createProject, { organizationId: strangerOrganizationId, name: 'Ajena' });
  await expect(resolvePrincipal(f.providerFirm.client, strangerProjectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('provider resolution checks every caller membership when only the second organization holds the grant', async () => {
  const f = await fixture();
  const dispatcher = await provision(f.t, 'grants-multi-membership');
  await dispatcher.client.mutation(createOrganization, { name: 'Unrelated first firm', slug: 'grants-multi-first' });
  await f.providerFirm.client.mutation(addMember, {
    organizationId: f.providerOrganizationId,
    userId: dispatcher.userId,
    role: 'viewer',
  });

  const memberships = await f.t.run(async (ctx) =>
    ctx.db
      .query('organizationMemberships')
      .withIndex('by_user', (q) => q.eq('userId', dispatcher.userId))
      .collect(),
  );
  expect(memberships).toHaveLength(2);
  expect(memberships[1]?.organizationId).toBe(f.providerOrganizationId);
  await expect(resolvePrincipal(dispatcher.client, f.projectId, 'readAssignment')).resolves.toMatchObject({
    kind: 'provider',
    providerOrganizationId: f.providerOrganizationId,
  });
});

test('probing an adjacent project id is indistinguishable from probing one that never existed (I9)', async () => {
  const f = await fixture();

  // A genuinely dangling id: a row that existed and was removed, so the id is
  // well-formed for the table and resolves to nothing.
  const goneProjectId = await f.t.run(async (ctx) => {
    const organizationId = await ctx.db.insert('organizations', { name: 'Gone', slug: 'grants-gone' });
    const projectId = await ctx.db.insert('projects', { organizationId, name: 'Gone', status: 'draft' });
    await ctx.db.delete(projectId);
    return projectId;
  });

  // The adjacent id reaches the provider arm and fails there; the dangling id
  // fails before the arm is ever entered. Both must leave through one exit.
  const adjacent = await refusal(resolvePrincipal(f.providerFirm.client, f.otherProjectId, 'readAssignment'));
  const nonexistent = await refusal(resolvePrincipal(f.providerFirm.client, goneProjectId, 'readAssignment'));
  expect(adjacent).toEqual(nonexistent);
  expect(adjacent.data).toEqual({ code: inaccessible });

  // The same holds for a caller with no relationship to anything at all, so the
  // provider arm's refusal is not distinguishable from a stranger's either.
  const stranger = await provision(f.t, 'grants-probe-stranger');
  const strangerAdjacent = await refusal(resolvePrincipal(stranger.client, f.otherProjectId, 'readAssignment'));
  expect(strangerAdjacent).toEqual(nonexistent);

  // And through the public surface, not only the gate.
  const publicAdjacent = await refusal(f.providerFirm.client.query(getProject, { projectId: f.otherProjectId }));
  const publicNonexistent = await refusal(f.providerFirm.client.query(getProject, { projectId: goneProjectId }));
  expect(publicAdjacent).toEqual(publicNonexistent);
});

// ---------------------------------------------------------------------------
// Non-transitivity
// ---------------------------------------------------------------------------

test('a Provider Principal cannot create, delegate or re-grant access', async () => {
  const f = await fixture();

  // A second, fully claimed Provider in a third tenant: everything a grant needs
  // EXCEPT a caller who is a member of the coordinator. If non-transitivity ever
  // came from a data condition rather than the member gate, this is the call
  // that would slip through.
  const otherFirm = await provision(f.t, 'grants-other-firm');
  const otherFirmOrganizationId = await otherFirm.client.mutation(createOrganization, { name: 'Rutas del Sol', slug: 'grants-other-firm' });
  const otherProviderId = await f.coordinator.client.mutation(createProvider, { organizationId: f.organizationId, name: 'Rutas del Sol SAS' });
  await setClaim(f.t, otherProviderId, otherFirmOrganizationId);

  // The granted provider holds a live principal on this very project...
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'respondToTerms')).resolves.toMatchObject({ kind: 'provider' });
  // ...and still cannot extend access to anybody, including itself.
  await expect(
    f.providerFirm.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: otherProviderId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    f.providerFirm.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: f.providerId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    f.providerFirm.client.mutation(grantProjectAccessToProvider, { projectId: f.otherProjectId, providerId: f.providerId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  // Nor withdraw one, which is the other half of controlling access.
  await expect(
    f.providerFirm.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  // Nor enumerate what exists.
  await expect(
    f.providerFirm.client.query(listProjectProviderAccessGrants, { projectId: f.projectId, paginationOpts: firstPage }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  // The firm's own OWNER rank inside its own Organization confers nothing here:
  // the two vocabularies do not compose.
  await f.t.run(async (ctx) => {
    const membership = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', f.providerOrganizationId).eq('userId', f.providerFirm.userId))
      .unique();
    expect(membership?.role).toBe('owner');
  });

  // Nothing was written by any of it.
  await f.t.run(async (ctx) => {
    const grants = await ctx.db.query('providerAccessGrants').collect();
    expect(grants).toHaveLength(1);
    expect(grants[0]?._id).toBe(f.grantId);
    expect(grants[0]?.status).toBe('active');
  });
});

test('granting requires admin: planners, operators, viewers and outsiders are all refused', async () => {
  const f = await fixture();
  const secondProviderId = await f.coordinator.client.mutation(createProvider, { organizationId: f.organizationId, name: 'Buses del Norte' });
  const thirdFirm = await provision(f.t, 'grants-third-firm');
  const thirdOrganizationId = await thirdFirm.client.mutation(createOrganization, { name: 'Buses del Norte', slug: 'grants-third-firm' });
  await setClaim(f.t, secondProviderId, thirdOrganizationId);

  for (const role of ['planner', 'operator', 'viewer'] as const) {
    const member = await provision(f.t, `grants-role-${role}`);
    await f.coordinator.client.mutation(addMember, { organizationId: f.organizationId, userId: member.userId, role });
    await expect(
      member.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: secondProviderId }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(
      member.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
    await expect(
      member.client.query(listProjectProviderAccessGrants, { projectId: f.projectId, paginationOpts: firstPage }),
    ).rejects.toMatchObject({ data: { code: inaccessible } });
  }

  const outsider = await provision(f.t, 'grants-outsider');
  await expect(
    outsider.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: secondProviderId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(
    outsider.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });

  // An admin of a DIFFERENT tenant is an outsider here too.
  const adminElsewhere = await provision(f.t, 'grants-admin-elsewhere');
  await adminElsewhere.client.mutation(createOrganization, { name: 'Elsewhere', slug: 'grants-elsewhere' });
  await expect(
    adminElsewhere.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: secondProviderId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
});

// ---------------------------------------------------------------------------
// Grant creation: each party's disagreement, separately
// ---------------------------------------------------------------------------

test('grant creation refuses a Provider row belonging to another organization', async () => {
  const f = await fixture();
  // A Provider row in somebody else's directory, claimed and active — perfectly
  // valid, just not the granting coordinator's to give away.
  const otherCoordinator = await provision(f.t, 'grants-other-coordinator');
  const otherOrganizationId = await otherCoordinator.client.mutation(createOrganization, { name: 'Otra Productora', slug: 'grants-other-coord' });
  const foreignProviderId = await otherCoordinator.client.mutation(createProvider, { organizationId: otherOrganizationId, name: 'Ajena SAS' });
  await setClaim(f.t, foreignProviderId, f.providerOrganizationId);

  const foreign = await refusal(f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: foreignProviderId }));
  expect(foreign.data).toEqual({ code: inaccessible });

  // Indistinguishable from a Provider id that resolves to nothing (I9).
  const goneProviderId = await f.t.run(async (ctx) => {
    const providerId = await ctx.db.insert('providers', {
      organizationId: otherOrganizationId,
      name: 'Gone',
      searchText: 'gone',
      status: 'active',
    });
    await ctx.db.delete(providerId);
    return providerId;
  });
  const gone = await refusal(f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: goneProviderId }));
  expect(gone).toEqual(foreign);
});

test('grant creation refuses a Project belonging to another organization', async () => {
  const f = await fixture();
  const otherCoordinator = await provision(f.t, 'grants-project-owner');
  const otherOrganizationId = await otherCoordinator.client.mutation(createOrganization, { name: 'Tercera', slug: 'grants-project-owner' });
  const foreignProjectId = await otherCoordinator.client.mutation(createProject, { organizationId: otherOrganizationId, name: 'Ajeno' });

  // The caller is an admin of its own tenant and the Provider row is its own;
  // only the Project disagrees, and that alone is fatal.
  await expect(
    f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: foreignProjectId, providerId: f.providerId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.query('providerAccessGrants').collect()).toHaveLength(1);
  });
});

test('grant creation refuses an UNCLAIMED Provider', async () => {
  const f = await fixture();
  const unclaimedId = await f.coordinator.client.mutation(createProvider, { organizationId: f.organizationId, name: 'Sin Reclamar SAS' });
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(unclaimedId))?.linkedOrganizationId).toBeUndefined();
  });

  // A specific code, not the generic one: by this point the row is proven to be
  // the caller's own tenant data, so its state discloses nothing about anyone else.
  await expect(
    f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: unclaimedId }),
  ).rejects.toMatchObject({ data: { code: 'providerGrantRequiresClaim' } });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.query('providerAccessGrants').collect()).toHaveLength(1);
  });

  // Claiming it makes the identical call succeed, so the refusal is about the
  // claim and nothing else.
  const firm = await provision(f.t, 'grants-late-claim');
  const firmOrganizationId = await firm.client.mutation(createOrganization, { name: 'Sin Reclamar', slug: 'grants-late-claim' });
  await setClaim(f.t, unclaimedId, firmOrganizationId);
  await expect(
    f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: unclaimedId }),
  ).resolves.toBeDefined();
});

test('revoking a Provider claim kills an existing grant on the very next resolution', async () => {
  const f = await fixture();
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).resolves.toMatchObject({ kind: 'provider' });

  // #86's claim revocation, without touching the grant row at all.
  await setClaim(f.t, f.providerId, undefined);
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });
  await f.t.run(async (ctx) => {
    const grant = await ctx.db.get(f.grantId);
    // The grant is untouched and still says "active": the claim is what died.
    expect(grant?.status).toBe('active');
    expect(grant?.providerOrganizationId).toBe(f.providerOrganizationId);
  });

  // Re-claimed by a DIFFERENT firm, the stale grant still resolves to nothing
  // for the old holder — and to nothing for the new one either, because the
  // grant row's own provider organization no longer matches the live link.
  const successor = await provision(f.t, 'grants-successor');
  const successorOrganizationId = await successor.client.mutation(createOrganization, { name: 'Sucesora', slug: 'grants-successor' });
  await setClaim(f.t, f.providerId, successorOrganizationId);
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });
  await expect(resolvePrincipal(successor.client, f.projectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });

  // Restoring the original claim restores resolution, proving the refusals above
  // were the claim check and not some unrelated breakage.
  await setClaim(f.t, f.providerId, f.providerOrganizationId);
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).resolves.toMatchObject({ kind: 'provider' });
});

test('grant creation refuses a Provider claimed by the granting organization itself', async () => {
  const f = await fixture();
  const selfProviderId = await f.coordinator.client.mutation(createProvider, { organizationId: f.organizationId, name: 'Nosotros SAS' });
  // A directory row pointing back at the coordinator's own tenant: granting it
  // would manufacture a provider principal out of the coordinator's own members
  // and hand them a capability set their role never granted.
  await setClaim(f.t, selfProviderId, f.organizationId);

  await expect(
    f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: selfProviderId }),
  ).rejects.toMatchObject({ data: { code: 'providerGrantSelfReference' } });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.query('providerAccessGrants').collect()).toHaveLength(1);
  });
});

test('grant creation refuses archived Providers and archived Projects', async () => {
  const f = await fixture();
  const firm = await provision(f.t, 'grants-archived-firm');
  const firmOrganizationId = await firm.client.mutation(createOrganization, { name: 'Archivada', slug: 'grants-archived-firm' });
  const archivedProviderId = await f.coordinator.client.mutation(createProvider, { organizationId: f.organizationId, name: 'Archivada SAS' });
  await setClaim(f.t, archivedProviderId, firmOrganizationId);
  await f.coordinator.client.mutation(archiveProvider, { providerId: archivedProviderId });

  await expect(
    f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: archivedProviderId }),
  ).rejects.toMatchObject({ data: { code: 'providerArchived' } });

  // An archived Provider is the coordinator's off switch: an EXISTING grant on
  // one stops resolving too.
  await f.coordinator.client.mutation(archiveProvider, { providerId: f.providerId });
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });

  await f.coordinator.client.mutation(archiveProject, { projectId: f.otherProjectId });
  await expect(
    f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.otherProjectId, providerId: archivedProviderId }),
  ).rejects.toMatchObject({ data: { code: 'projectArchived' } });
});

test('a grant row is server-derived from the proven graph and unique per (Provider, Project)', async () => {
  const f = await fixture();

  await f.t.run(async (ctx) => {
    const grant = await ctx.db.get(f.grantId);
    expect(grant).toMatchObject({
      organizationId: f.organizationId,
      providerId: f.providerId,
      // Derived from the Provider row's own claim, never from a client argument (I4).
      providerOrganizationId: f.providerOrganizationId,
      projectId: f.projectId,
      status: 'active',
      grantedByUserId: f.coordinator.userId,
    });
    expect(grant?.grantedAt).toBeGreaterThanOrEqual(f.grantStartedAt);
    expect(grant?.grantedAt).toBeLessThanOrEqual(f.grantFinishedAt);
    expect(grant?.revokedAt).toBeUndefined();
  });

  // A duplicate is a conflict, not a second row.
  await expect(
    f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: f.providerId }),
  ).rejects.toMatchObject({ data: { code: 'conflict' } });
  await f.t.run(async (ctx) => {
    const grants = await ctx.db
      .query('providerAccessGrants')
      .withIndex('by_provider_project', (q) => q.eq('providerId', f.providerId).eq('projectId', f.projectId))
      .collect();
    expect(grants).toHaveLength(1);
  });

  // Revoking and re-granting REUSES the row rather than accumulating a second
  // one, so the uniqueness key stays true across the whole lifecycle.
  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });
  const reinstated = await f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.projectId, providerId: f.providerId });
  expect(reinstated).toBe(f.grantId);
  await f.t.run(async (ctx) => {
    expect(await ctx.db.query('providerAccessGrants').collect()).toHaveLength(1);
  });

  // The SAME Provider on a DIFFERENT Project is a different key, so it is allowed.
  const second = await f.coordinator.client.mutation(grantProjectAccessToProvider, { projectId: f.otherProjectId, providerId: f.providerId });
  expect(second).not.toBe(f.grantId);
  await f.t.run(async (ctx) => {
    expect(await ctx.db.query('providerAccessGrants').collect()).toHaveLength(2);
  });
});

test('reinstatement re-derives the current firm, actor and time after the Provider is re-claimed', async () => {
  const f = await fixture();
  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });

  const successor = await provision(f.t, 'grants-reinstate-successor');
  const successorOrganizationId = await successor.client.mutation(createOrganization, {
    name: 'Successor firm',
    slug: 'grants-reinstate-successor',
  });
  await setClaim(f.t, f.providerId, successorOrganizationId);

  const newGrantor = await provision(f.t, 'grants-reinstate-admin');
  await f.coordinator.client.mutation(addMember, {
    organizationId: f.organizationId,
    userId: newGrantor.userId,
    role: 'admin',
  });
  // Make a stale timestamp deterministic: a reinstatement that fails to derive
  // a new clock value cannot accidentally pass because two calls shared a ms.
  await f.t.run(async (ctx) => ctx.db.patch(f.grantId, { grantedAt: 0 }));

  const reinstateStartedAt = Date.now();
  const reinstated = await newGrantor.client.mutation(grantProjectAccessToProvider, {
    projectId: f.projectId,
    providerId: f.providerId,
  });
  const reinstateFinishedAt = Date.now();
  expect(reinstated).toBe(f.grantId);

  await f.t.run(async (ctx) => {
    const grant = await ctx.db.get(f.grantId);
    expect(grant).toMatchObject({
      providerOrganizationId: successorOrganizationId,
      grantedByUserId: newGrantor.userId,
      status: 'active',
    });
    expect(grant?.grantedAt).toBeGreaterThanOrEqual(reinstateStartedAt);
    expect(grant?.grantedAt).toBeLessThanOrEqual(reinstateFinishedAt);
    expect(grant?.revokedAt).toBeUndefined();
  });
  await expect(resolvePrincipal(successor.client, f.projectId, 'readAssignment')).resolves.toMatchObject({
    kind: 'provider',
    providerOrganizationId: successorOrganizationId,
  });
});

test('revocation is idempotent and never refusable', async () => {
  const f = await fixture();
  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });
  const first = await f.t.run(async (ctx) => (await ctx.db.get(f.grantId))?.revokedAt);
  // A repeat is a no-op, not an error: access withdrawal must always be repeatable.
  await expect(f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId })).resolves.toBeNull();
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get(f.grantId))?.revokedAt).toBe(first);
  });
  // And it records exactly one revocation.
  const audits = await f.t.run(async (ctx) =>
    ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', f.organizationId).eq('entityType', 'providerAccessGrant').eq('entityId', f.grantId))
      .collect(),
  );
  expect(audits.filter((row) => row.action === 'providerAccessGrant.revoked')).toHaveLength(1);
});

test('the coordinator can page its own grant list, including revoked rows', async () => {
  const f = await fixture();
  const secondFirm = await provision(f.t, 'grants-page-second');
  const secondFirmOrganizationId = await secondFirm.client.mutation(createOrganization, {
    name: 'Second page firm',
    slug: 'grants-page-second',
  });
  const secondProviderId = await f.coordinator.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Second page Provider',
  });
  await setClaim(f.t, secondProviderId, secondFirmOrganizationId);
  const secondGrantId = await f.coordinator.client.mutation(grantProjectAccessToProvider, {
    projectId: f.projectId,
    providerId: secondProviderId,
  });

  const page = await f.coordinator.client.query(listProjectProviderAccessGrants, {
    projectId: f.projectId,
    paginationOpts: { numItems: 1, cursor: null },
  });
  expect(page.page.map((row) => row._id)).toEqual([f.grantId]);
  expect(page.isDone).toBe(false);
  const continuation = await f.coordinator.client.query(listProjectProviderAccessGrants, {
    projectId: f.projectId,
    paginationOpts: { numItems: 1, cursor: page.continueCursor },
  });
  expect(continuation.page.map((row) => row._id)).toEqual([secondGrantId]);
  expect(continuation.isDone).toBe(true);

  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });
  const afterRevocation = await f.coordinator.client.query(listProjectProviderAccessGrants, { projectId: f.projectId, paginationOpts: firstPage });
  // Revoked rows stay: they are the record of who used to be able to read this.
  expect(afterRevocation.page).toHaveLength(2);
  expect(afterRevocation.page.find((row) => row._id === f.grantId)?.status).toBe('revoked');

  // The adjacent project has none of it.
  const other = await f.coordinator.client.query(listProjectProviderAccessGrants, { projectId: f.otherProjectId, paginationOpts: firstPage });
  expect(other.page).toEqual([]);
});

// ---------------------------------------------------------------------------
// Audit: both actor dimensions
// ---------------------------------------------------------------------------

test('grant and revocation audit rows name the acting member and no provider behalf', async () => {
  const f = await fixture();
  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });

  const audits = await f.t.run(async (ctx) =>
    ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', f.organizationId).eq('entityType', 'providerAccessGrant').eq('entityId', f.grantId))
      .collect(),
  );
  expect(audits.map((row) => row.action).sort()).toEqual(['providerAccessGrant.granted', 'providerAccessGrant.revoked']);
  for (const row of audits) {
    expect(row.actorUserId).toBe(f.coordinator.userId);
    expect(row.metadata).toMatchObject({ providerId: f.providerId, projectId: f.projectId });
    // A coordinator deciding who gets in acts as ITSELF. Recording it as acting
    // "on behalf of" the firm it is admitting would invert the column's meaning.
    expect(row.onBehalfOfProviderId).toBeUndefined();
  }
});

test('auditActorFor derives both actor dimensions from the resolved principal, and the column persists', async () => {
  const f = await fixture();

  const memberActorResult = await f.coordinator.client.query(async (ctx) => {
    const principal = await requirePrincipalForProject(ctx, f.projectId, 'readAssignment');
    const actor = auditActorFor(principal);
    return { actor, keys: Object.keys(actor).sort() };
  });
  expect(memberActorResult.actor).toStrictEqual({ actorUserId: f.coordinator.userId });
  expect(memberActorResult.keys).toStrictEqual(['actorUserId']);

  const providerActor = await f.providerFirm.client.query(async (ctx) => {
    const principal = await requirePrincipalForProject(ctx, f.projectId, 'writeExecution');
    return auditActorFor(principal);
  });
  expect(providerActor).toEqual({ actorUserId: f.providerFirm.userId, onBehalfOfProviderId: f.providerId });

  // The audit writer stores the second dimension when a provider-arm operation
  // supplies it. #88 is its first domain producer; this proves the plumbing that
  // makes "who changed this, under whose grant" answerable.
  const auditId = await f.t.run(async (ctx) =>
    recordAuditEvent(ctx, {
      organizationId: f.organizationId,
      ...providerActor,
      action: 'providerAccessGrant.granted',
      entityType: 'providerAccessGrant',
      entityId: f.grantId,
      metadata: { providerId: f.providerId, projectId: f.projectId },
    }),
  );
  await f.t.run(async (ctx) => {
    const row: Doc<'auditEvents'> | null = await ctx.db.get(auditId);
    expect(row?.actorUserId).toBe(f.providerFirm.userId);
    expect(row?.onBehalfOfProviderId).toBe(f.providerId);
  });
});

// ---------------------------------------------------------------------------
// I4: the gate re-derives ownership from the stored graph, and trusts no column
// ---------------------------------------------------------------------------

/**
 * The two checks below cannot be reached through any public mutation:
 * `grantProjectAccessToProvider` proves both agreements before it inserts, so no
 * caller can produce a row that violates either. They are asserted against rows
 * written DIRECTLY to the database for exactly that reason.
 *
 * That is the point of I4, not a gap in it. `organizationId` on a grant and
 * `organizationId` on a Provider are denormalized index caches; authorization
 * walks the stored graph and rejects any row whose cache disagrees with its
 * parent, so a bad row — from a future migration, a seed, an admin repair, or a
 * write path that does not exist yet — fails closed rather than resolving into a
 * cross-tenant principal. A behavioural test that only drives the public API
 * cannot see these checks at all; without them a regression here would be
 * silent until the day something wrote such a row.
 */
test('a grant whose Provider row belongs to another coordinator resolves to nothing', async () => {
  const f = await fixture();
  const otherCoordinator = await provision(f.t, 'grants-graph-coordinator');
  const otherOrganizationId = await otherCoordinator.client.mutation(createOrganization, { name: 'Vecina', slug: 'grants-graph-coord' });

  // A Provider row in ANOTHER coordinator's directory, claimed by the same firm,
  // named by a grant on THIS coordinator's project.
  const foreignProviderId = await f.t.run(async (ctx) =>
    ctx.db.insert('providers', {
      organizationId: otherOrganizationId,
      name: 'Vecina SAS',
      searchText: 'vecina sas',
      status: 'active',
      linkedOrganizationId: f.providerOrganizationId,
    }),
  );
  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });
  await f.t.run(async (ctx) =>
    ctx.db.insert('providerAccessGrants', {
      organizationId: f.organizationId,
      providerId: foreignProviderId,
      providerOrganizationId: f.providerOrganizationId,
      projectId: f.projectId,
      status: 'active',
      grantedByUserId: f.coordinator.userId,
      grantedAt: Date.now(),
    }),
  );

  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });
});

test("a grant whose denormalized coordinator column disagrees with the Project resolves to nothing", async () => {
  const f = await fixture();
  const otherCoordinator = await provision(f.t, 'grants-graph-column');
  const otherOrganizationId = await otherCoordinator.client.mutation(createOrganization, { name: 'Tercera', slug: 'grants-graph-column' });

  // The row still names the right Provider, the right firm and the right
  // Project — only its cached coordinator id disagrees with the Project's own.
  await f.t.run(async (ctx) => ctx.db.patch(f.grantId, { organizationId: otherOrganizationId }));
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).rejects.toMatchObject({ data: { code: inaccessible } });

  // Restoring the agreement restores resolution, so the refusal was the column
  // comparison and not some unrelated breakage.
  await f.t.run(async (ctx) => ctx.db.patch(f.grantId, { organizationId: f.organizationId }));
  await expect(resolvePrincipal(f.providerFirm.client, f.projectId, 'readAssignment')).resolves.toMatchObject({ kind: 'provider' });
});

test("revocation refuses a grant whose denormalized coordinator column disagrees with its Project", async () => {
  const f = await fixture();
  const otherCoordinator = await provision(f.t, 'grants-revoke-graph-column');
  const otherOrganizationId = await otherCoordinator.client.mutation(createOrganization, {
    name: 'Foreign revoke cache',
    slug: 'grants-revoke-graph-column',
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.grantId, { organizationId: otherOrganizationId }));

  await expect(
    f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId }),
  ).rejects.toMatchObject({ data: { code: inaccessible } });
  await f.t.run(async (ctx) => {
    const grant = await ctx.db.get(f.grantId);
    expect(grant?.status).toBe('active');
    expect(grant?.revokedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Confinement: the principal names rows, it does not carry them
// ---------------------------------------------------------------------------

test('a Provider Principal carries identifiers only — never the Provider, Organization or grant rows', async () => {
  const f = await fixture();

  /** Columns that exist only on rows a Provider Principal must never be handed. */
  const forbiddenColumns = ['searchText', 'notes', 'taxId', 'linkedOrganizationId', 'grantedByUserId', 'grantedAt', 'revokedAt'];

  const shape = await f.providerFirm.client.query(async (ctx) => {
    const principal = await requirePrincipalForProject(ctx, f.projectId, 'readAssignment');
    const leaked: string[] = [];
    for (const [key, value] of Object.entries(principal)) {
      if (value === null || typeof value !== 'object') continue;
      for (const column of forbiddenColumns) {
        if (column in value) leaked.push(`${key}.${column}`);
      }
    }
    return { keys: Object.keys(principal).sort(), leaked: leaked.sort() };
  });

  // Exactly these, and no `provider`, `providerOrganization` or `grant`. The
  // capability set is an AUTHORIZATION decision; it does not confine what a
  // handler may return, so the shape has to. Once #67 exists, a handler
  // authorized for `readAssignment` must not be one property access away from
  // the coordinator's private notes about the firm it is about.
  expect(shape.keys).toEqual([
    'accessibleProviderIds',
    'capabilities',
    'grantId',
    'identity',
    'kind',
    'providerId',
    'providerOrganizationId',
    'user',
  ]);
  expect(shape.leaked).toEqual([]);
});

// ---------------------------------------------------------------------------
// Referential integrity: a grant is a reference (I4)
// ---------------------------------------------------------------------------

test('a Provider referenced by any grant cannot be deleted, active or revoked', async () => {
  const f = await fixture();

  // The orphaning sequence: grant while claimed, then revoke the claim, then
  // archive. Without the grant reference check the delete would go through and
  // leave the grant row — and the two audit events naming it — pointing at a
  // `providerId` that resolves to nothing.
  await setClaim(f.t, f.providerId, undefined);
  await f.coordinator.client.mutation(archiveProvider, { providerId: f.providerId });
  await expect(
    f.coordinator.client.mutation(deleteProvider, { providerId: f.providerId }),
  ).rejects.toMatchObject({ data: { code: 'providerDeleteBlocked' } });

  // A REVOKED grant blocks it too: it is the record of who used to be able to
  // read this Project, not dead weight.
  await f.coordinator.client.mutation(revokeProviderAccessGrant, { grantId: f.grantId });
  await expect(
    f.coordinator.client.mutation(deleteProvider, { providerId: f.providerId }),
  ).rejects.toMatchObject({ data: { code: 'providerDeleteBlocked' } });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(f.providerId)).not.toBeNull();
  });

  // Removing the last referencing row is what releases it, so the refusal was
  // the grant and nothing else.
  await f.t.run(async (ctx) => ctx.db.delete(f.grantId));
  await expect(f.coordinator.client.mutation(deleteProvider, { providerId: f.providerId })).resolves.toBeNull();
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(f.providerId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The structural rule: exactly one helper resolves both principal arms
// ---------------------------------------------------------------------------

/**
 * Read as text at transform time, so this asserts over the SOURCES rather than
 * over behaviour. The rule #71 exists to establish is not "the checks are
 * correct today" but "there is exactly one place they can be wrong": adding a
 * third principal, or narrowing what a grant confers, must remain a change to
 * `lib/access.ts` alone. A behavioural test cannot see a second inlined check
 * that happens to be written correctly; this one can.
 */
const backendSources: Record<string, string> = import.meta.glob(
  ['../convex/**/*.ts', '!../convex/_generated/**'],
  { query: '?raw', import: 'default', eager: true },
);

/**
 * Comments are stripped first, so these assertions are about CODE. The rule is
 * about where a check can be written, and a doc comment naming the gate — of
 * which this codebase has many, deliberately — is not a second implementation.
 */
function withoutComments(contents: string): string {
  return contents.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourcesMatching(pattern: RegExp): string[] {
  return Object.entries(backendSources)
    .filter(([, contents]) => pattern.test(withoutComments(contents)))
    .map(([path]) => path.replace(/^.*\/convex\//, ''))
    .sort();
}

function exportedRuntimeNames(contents: string): string[] {
  const source = ts.createSourceFile('grants.ts', contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      names.push('default');
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined) {
        names.push('*');
      } else if (ts.isNamedExports(statement.exportClause)) {
        names.push(...statement.exportClause.elements.map((element) => element.name.text));
      }
      continue;
    }
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.push(ts.isIdentifier(declaration.name) ? declaration.name.text : '<destructured>');
      }
    } else if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isEnumDeclaration(statement)
        || ts.isModuleDeclaration(statement))
      && statement.name !== undefined
    ) {
      names.push(statement.name.text);
    }
  }
  return names.sort();
}

test('exactly one helper resolves both principal arms, and no operation inlines either check', async () => {
  // The glob has to have found the backend at all, or every assertion below
  // passes vacuously.
  expect(sourcesMatching(/requireAuthenticatedUser/).length).toBeGreaterThan(5);
  expect(Object.keys(backendSources).some((path) => path.endsWith('/lib/access.ts'))).toBe(true);

  // 1. THE GATE is defined exactly once.
  const definitions = Object.values(backendSources).flatMap(
    (contents) => withoutComments(contents).match(/export async function requirePrincipalForProject/g) ?? [],
  );
  expect(definitions).toHaveLength(1);
  expect(sourcesMatching(/export async function requirePrincipalForProject/)).toEqual(['lib/access.ts']);

  // 2. The grants table is READ FOR AUTHORIZATION in exactly one place. The
  //    coordinator-side module reads it too, for its uniqueness key and for the
  //    `deleteProvider` reference guard — both write-path concerns, not
  //    principal resolution, which is why that file is named here rather than
  //    allowed by a looser pattern.
  expect(sourcesMatching(/\.query\('providerAccessGrants'\)/)).toEqual(['lib/access.ts', 'providers/grants.ts']);

  // The lifecycle module may expose only these four operations. In particular,
  // it cannot export a grant-reading authorization helper for another module to
  // consume while still hiding behind this file's legitimate table reads.
  const grantsSource = Object.entries(backendSources).find(([path]) => path.endsWith('/providers/grants.ts'))?.[1];
  expect(grantsSource).toBeDefined();
  expect(exportedRuntimeNames(grantsSource ?? '')).toEqual([
    'grantProjectAccessToProvider',
    'listProjectProviderAccessGrants',
    'providerHasAccessGrants',
    'revokeProviderAccessGrant',
  ]);

  // 3. The RESOLUTION index has exactly one reader besides its definition.
  expect(sourcesMatching(/by_providerOrganization_project/)).toEqual(['lib/access.ts', 'schema.ts']);

  // 4. The closed capability set is stated once and never re-stated.
  expect(sourcesMatching(/providerGrantCapabilities/)).toEqual(['lib/access.ts']);
  expect(sourcesMatching(/kind: 'provider'/)).toEqual(['lib/access.ts']);

  // 5. Nothing outside the gate decides what a grant means by reading its status.
  expect(sourcesMatching(/grant\.status !== 'active'/)).toEqual(['lib/access.ts']);
});
