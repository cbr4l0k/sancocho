import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { enableSeedMutations, modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const seedCordilleraOperations = internal.seed.cordillera.seedCordilleraOperations;
const resetTenantOperations = internal.seed.reset.resetTenantOperations;
const issuer = 'https://example.clerk.accounts.dev';
const slug = 'cordillera-demo';
const projectName = 'Cordillera 2026';
type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;
const festivalServiceKindKeys = [
  'festivalArtistDisposition',
  'festivalArtistTransfer',
  'festivalCoordination',
  'festivalCrewShuttle',
  'festivalInternalMovement',
  'festivalPartnerService',
];

enableSeedMutations();

async function tenant(t: SchemaTest) {
  const client = t.withIdentity({ issuer, subject: 'cordillera-owner', name: 'Owner', email: 'owner@example.com', emailVerified: true });
  await client.mutation(ensureUser, {});
  const organizationId = await client.mutation(createOrganization, { name: 'Cordillera Ops', slug });
  return { client, organizationId };
}

test('the Cordillera seed writes the real operating vocabulary and all seven operating sheets', async () => {
  const t = convexTest(schema, modules);
  const { organizationId } = await tenant(t);

  const result = await t.mutation(seedCordilleraOperations, { organizationSlug: slug });
  expect(result).toEqual({ fieldDefinitions: 18, serviceKinds: 6, locations: 10, services: 90, relationships: 37, projectName });

  await t.run(async (ctx) => {
    const memberships = await ctx.db.query('organizationMemberships').withIndex('by_org_user', (q) => q.eq('organizationId', organizationId)).collect();
    expect(memberships.some((membership) => membership.role === 'owner')).toBe(true);

    const fields = await ctx.db.query('fieldDefinitions').withIndex('by_org_key', (q) => q.eq('organizationId', organizationId)).collect();
    expect(fields).toHaveLength(18);
    expect(fields.every((field) => field.scope === 'organization' && field.semanticType === undefined)).toBe(true);
    expect(fields.map((field) => field.key).sort()).toContain('supplierStatus');

    const projects = await ctx.db.query('projects').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    const project = projects.find((row) => row.name === projectName);
    if (project === undefined) throw new Error('Expected the Cordillera project');
    expect(project).toMatchObject({ description: 'Festival Cordillera — Parque Simón Bolívar, Bogotá' });

    const locations = await ctx.db.query('locations').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    const services = await ctx.db.query('services').withIndex('by_project', (q) => q.eq('projectId', project._id)).collect();
    const relationships = (await ctx.db.query('serviceRelationships').collect()).filter((relationship) => relationship.organizationId === organizationId);
    expect(locations).toHaveLength(10);
    expect(services).toHaveLength(90);
    expect(relationships).toHaveLength(37);

    // These names are the sheet-level coverage markers: STAGE 3, STAGE 4,
    // CLUB COLOMBIA, OCESA, PROMOTORIA, MOV INTERNOS, and EQUIPO.
    const names = services.map((service) => service.name);
    expect(names).toEqual(expect.arrayContaining([
      expect.stringContaining('Latin Brothers'),
      expect.stringContaining('Kei Linch'),
      'Sprinter 1 Club Colombia — 12/09',
      'Servicio OCESA — 11/09 (Duster)',
      'Servicio Promotoría — 12/09 (H1)',
      'Movimiento interno Sprinter — 12/09',
      'Ruta AM equipo Páramo — 12/09',
    ]));
  });
}, 20_000);

test('re-running is idempotent for keyed configuration and clean-slate operations', async () => {
  const t = convexTest(schema, modules);
  const { organizationId } = await tenant(t);
  await t.mutation(seedCordilleraOperations, { organizationSlug: slug });

  const before = await t.run(async (ctx) => ({
    fields: (await ctx.db.query('fieldDefinitions').withIndex('by_org_key', (q) => q.eq('organizationId', organizationId)).collect()).length,
    serviceKinds: (await ctx.db.query('serviceKinds').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).filter((serviceKind) => festivalServiceKindKeys.includes(serviceKind.key)).length,
    locations: (await ctx.db.query('locations').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).length,
    services: (await ctx.db.query('services').withIndex('by_org_status_startsAt', (q) => q.eq('organizationId', organizationId)).collect()).length,
    relationships: (await ctx.db.query('serviceRelationships').collect()).filter((relationship) => relationship.organizationId === organizationId).length,
  }));

  await expect(t.mutation(seedCordilleraOperations, { organizationSlug: slug })).resolves.toMatchObject({ services: 90, relationships: 37 });

  const after = await t.run(async (ctx) => ({
    fields: (await ctx.db.query('fieldDefinitions').withIndex('by_org_key', (q) => q.eq('organizationId', organizationId)).collect()).length,
    serviceKinds: (await ctx.db.query('serviceKinds').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).filter((serviceKind) => festivalServiceKindKeys.includes(serviceKind.key)).length,
    locations: (await ctx.db.query('locations').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).length,
    services: (await ctx.db.query('services').withIndex('by_org_status_startsAt', (q) => q.eq('organizationId', organizationId)).collect()).length,
    relationships: (await ctx.db.query('serviceRelationships').collect()).filter((relationship) => relationship.organizationId === organizationId).length,
  }));
  expect(before).toEqual({ fields: 18, serviceKinds: 6, locations: 10, services: 90, relationships: 37 });
  expect(after).toEqual(before);
}, 20_000);

test('reset and repeated Cordillera reseeds reproduce byte-identical numeric figures', async () => {
  const t = convexTest(schema, modules);
  const { organizationId } = await tenant(t);

  await t.mutation(seedCordilleraOperations, { organizationSlug: slug });
  const first = await cordilleraFigures(t, organizationId);
  await t.mutation(resetTenantOperations, {});
  await t.mutation(seedCordilleraOperations, { organizationSlug: slug });
  const second = await cordilleraFigures(t, organizationId);
  await t.mutation(resetTenantOperations, {});
  await t.mutation(seedCordilleraOperations, { organizationSlug: slug });
  const third = await cordilleraFigures(t, organizationId);

  expect(second).toBe(first);
  expect(third).toBe(first);
}, 40_000);

async function cordilleraFigures(t: SchemaTest, organizationId: Id<'organizations'>) {
  return t.run(async (ctx) => {
    const services = await ctx.db
      .query('services')
      .withIndex('by_org_startsAt', (q) => q.eq('organizationId', organizationId))
      .collect();
    const figures: [string, string, number][] = [];
    for (const service of services) {
      const values = await ctx.db
        .query('serviceFieldValues')
        .withIndex('by_service_field', (q) => q.eq('serviceId', service._id))
        .collect();
      for (const stored of values) {
        if (stored.value.kind !== 'number') continue;
        const definition = await ctx.db.get(stored.fieldDefinitionId);
        if (definition === null) throw new Error('Expected the definition behind a Cordillera figure');
        figures.push([service.name, definition.key, stored.value.value]);
      }
    }
    figures.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]) || left[2] - right[2]);
    return JSON.stringify(figures);
  });
}

test('published snapshots, service ownership, lifecycle audits, and mixed vocabulary preserve I1-I4', async () => {
  const t = convexTest(schema, modules);
  const { organizationId } = await tenant(t);
  await t.mutation(seedCordilleraOperations, { organizationSlug: slug });

  await t.run(async (ctx) => {
    const serviceKinds = (await ctx.db.query('serviceKinds').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect())
      .filter((serviceKind) => festivalServiceKindKeys.includes(serviceKind.key));
    expect(serviceKinds.map((serviceKind) => serviceKind.key).sort()).toEqual(festivalServiceKindKeys);
    for (const serviceKind of serviceKinds) {
      expect(serviceKind.status).toBe('active');
      const versions = await ctx.db.query('serviceKindVersions').withIndex('by_serviceKind_version', (q) => q.eq('serviceKindId', serviceKind._id)).collect();
      expect(versions).toHaveLength(1);
      const version = versions[0];
      if (version === undefined) throw new Error('Expected a published serviceKind version');
      expect(version.status).toBe('published');
      const serviceKindFields = await ctx.db.query('serviceKindFields').withIndex('by_version', (q) => q.eq('serviceKindVersionId', version._id)).collect();
      expect(serviceKindFields.length).toBeGreaterThan(0);
      expect(serviceKindFields.every((field) => field.config !== undefined)).toBe(true);
    }

    const project = (await ctx.db.query('projects').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect()).find((row) => row.name === projectName);
    if (project === undefined) throw new Error('Expected the Cordillera project');
    const services = await ctx.db.query('services').withIndex('by_project', (q) => q.eq('projectId', project._id)).collect();
    for (const service of services) {
      expect(service.organizationId).toBe(project.organizationId);
      const version = await ctx.db.get(service.serviceKindVersionId);
      const serviceKind = await ctx.db.get(service.serviceKindId);
      expect(version).toMatchObject({ status: 'published', serviceKindId: service.serviceKindId, organizationId: project.organizationId });
      expect(serviceKind).toMatchObject({ status: 'active', organizationId: project.organizationId });
    }

    const terminalServices = services.filter((service) => service.status === 'completed' || service.status === 'cancelled');
    expect(terminalServices.some((service) => service.status === 'completed')).toBe(true);
    expect(terminalServices.some((service) => service.status === 'cancelled')).toBe(true);
    for (const service of terminalServices) {
      const audits = await ctx.db.query('auditEvents').withIndex('by_org_entity', (q) =>
        q.eq('organizationId', organizationId).eq('entityType', 'service').eq('entityId', service._id),
      ).collect();
      const advances = audits.filter((audit) => audit.action === 'service.statusChanged');
      if (service.status === 'completed') {
        expect(advances).toHaveLength(4);
        expect(advances.map((audit) => audit.metadata.previousStatus)).toEqual(['draft', 'planned', 'confirmed', 'active']);
      } else {
        expect(advances).toHaveLength(2);
        expect(advances.map((audit) => audit.metadata.previousStatus)).toEqual(['draft', 'planned']);
        expect(audits.some((audit) => audit.action === 'service.cancelled' && audit.metadata.previousStatus === 'confirmed')).toBe(true);
      }
    }

    const composedService = services.find((service) => service.name.includes('Latin Brothers') && service.name.startsWith('Llegada'));
    if (composedService === undefined) throw new Error('Expected a Latin Brothers arrival');
    const storedValues = await ctx.db.query('serviceFieldValues').withIndex('by_service_field', (q) => q.eq('serviceId', composedService._id)).collect();
    const definitions = await Promise.all(storedValues.map((stored) => ctx.db.get(stored.fieldDefinitionId)));
    expect(definitions.some((definition) => definition?.key === 'artist' && definition.scope === 'organization')).toBe(true);
    expect(definitions.some((definition) => definition?.key === 'passengerCount' && definition.scope === 'builtin')).toBe(true);
  });
}, 20_000);

test('the seed refuses to adopt — and permanently freeze — a tenant field it did not create', async () => {
  const t = convexTest(schema, modules);
  const { client, organizationId } = await tenant(t);

  // A tenant that already owns `driverName` for its own purposes, with a
  // different config than the seed's. Publishing a seed serviceKind against it would
  // freeze that definition forever (I2/I3), so the seed must refuse instead.
  await client.mutation(api.fields.mutations.createFieldDefinition, {
    organizationId,
    key: 'driverName',
    label: 'Conductor asignado',
    config: { kind: 'longText' },
  });

  await expect(t.mutation(seedCordilleraOperations, { organizationSlug: slug })).rejects.toMatchObject({
    data: { code: 'seedFieldConflict' },
  });

  // The refusal rolls the whole mutation back: nothing was half-seeded.
  await t.run(async (ctx) => {
    const services = await ctx.db.query('services').withIndex('by_org_startsAt', (q) => q.eq('organizationId', organizationId)).collect();
    const serviceKinds = (await ctx.db.query('serviceKinds').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect())
      .filter((serviceKind) => festivalServiceKindKeys.includes(serviceKind.key));
    expect(services).toHaveLength(0);
    expect(serviceKinds).toHaveLength(0);
  });
}, 20_000);

test('a second run under a different project name reuses the location catalogue rather than duplicating it', async () => {
  const t = convexTest(schema, modules);
  const { organizationId } = await tenant(t);
  await t.mutation(seedCordilleraOperations, { organizationSlug: slug });
  await t.mutation(seedCordilleraOperations, { organizationSlug: slug, projectName: 'Cordillera 2027' });

  await t.run(async (ctx) => {
    const locations = await ctx.db.query('locations').withIndex('by_org', (q) => q.eq('organizationId', organizationId)).collect();
    expect(locations).toHaveLength(10);
    expect(new Set(locations.map((location) => location.name)).size).toBe(10);
  });
}, 30_000);
