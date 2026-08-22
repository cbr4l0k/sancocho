import type { UserIdentity } from 'convex/server';
import { v } from 'convex/values';

import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { changeEventStatus, createEventFromRecipe } from '../events/model';
import { ensureBuiltinFieldDefinitions, type BuiltinFieldKey } from '../fields/builtins';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { assertSeedingEnabled } from '../lib/seedGuard';
import { createLocation } from '../locations/model';
import { createProject } from '../projects/model';
import { provisionStarterRecipes } from '../recipes/builtins';
import type { eventFieldValueValidator } from '../validators';

/**
 * A Bogotá (BOG) demonstration: real El Dorado terminals, real venues, and the
 * ground transport a festival production actually books between them.
 *
 * It seeds into an organization that already exists rather than creating one of
 * its own, because the point is to fill a developer's own tenant with something
 * recognisable to click through. The organization, its members and its projects
 * are inputs here; only Locations and Services are written.
 *
 * Every timestamp below is stated as an absolute instant computed from Bogotá
 * wall-clock time. Colombia is UTC-5 year round and observes no DST, so the
 * offset is a constant rather than a date-dependent lookup — but the stored
 * value is still a complete instant, never a wall-clock string, which is the
 * rule an Event's `startsAt` exists to demonstrate.
 */
const bogotaUtcOffsetHours = -5;

function bogota(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - bogotaUtcOffsetHours, minute);
}

type LocationKey =
  | 'eldoradoT1'
  | 'eldoradoT2'
  | 'grandHyatt'
  | 'dannCarlton'
  | 'simonBolivar'
  | 'movistarArena'
  | 'corferias'
  | 'fontibonDepot';

/**
 * Coordinates are approximate landmark centroids, good enough to place a pin in
 * the right part of the city and deliberately not presented as survey data.
 */
const locations: readonly {
  key: LocationKey;
  name: string;
  type: 'airport' | 'hotel' | 'venue' | 'depot';
  address: string;
  latitude: number;
  longitude: number;
}[] = [
  { key: 'eldoradoT1', name: 'El Dorado T1 — Llegadas internacionales', type: 'airport', address: 'Av. El Dorado #103-9, Fontibón, Bogotá', latitude: 4.7016, longitude: -74.1469 },
  { key: 'eldoradoT2', name: 'El Dorado T2 — Puente Aéreo', type: 'airport', address: 'Av. El Dorado #106-39, Fontibón, Bogotá', latitude: 4.7106, longitude: -74.1441 },
  { key: 'grandHyatt', name: 'Grand Hyatt Bogotá', type: 'hotel', address: 'Calle 24A #57-60, Bogotá', latitude: 4.6503, longitude: -74.1057 },
  { key: 'dannCarlton', name: 'Hotel Casa Dann Carlton', type: 'hotel', address: 'Carrera 19 #103-32, Bogotá', latitude: 4.6875, longitude: -74.0475 },
  { key: 'simonBolivar', name: 'Parque Metropolitano Simón Bolívar', type: 'venue', address: 'Av. Calle 63 #59-05, Bogotá', latitude: 4.6580, longitude: -74.0930 },
  { key: 'movistarArena', name: 'Movistar Arena', type: 'venue', address: 'Diagonal 61C #26-36, Bogotá', latitude: 4.6494, longitude: -74.0783 },
  { key: 'corferias', name: 'Corferias', type: 'venue', address: 'Carrera 37 #24-67, Bogotá', latitude: 4.6320, longitude: -74.0840 },
  { key: 'fontibonDepot', name: 'Base de operaciones Fontibón', type: 'depot', address: 'Calle 17 #96-50, Fontibón, Bogotá', latitude: 4.6790, longitude: -74.1460 },
];

type Value = typeof eventFieldValueValidator.type;

const text = (value: string): Value => ({ kind: 'text', value });
const longText = (value: string): Value => ({ kind: 'longText', value });
const count = (value: number): Value => ({ kind: 'number', value });

/**
 * Each service names the starter recipe it is created from, and supplies a value
 * for exactly the built-in fields that recipe composes — a value for a field the
 * version does not contain is rejected by the event model, as it should be.
 */
type ServiceStatus = 'draft' | 'planned' | 'confirmed' | 'active' | 'completed' | 'cancelled';

/**
 * The lifecycle is one step at a time (draft→planned→confirmed→active→completed,
 * or cancelled from any non-terminal state), and the model refuses a jump. A
 * seeded service therefore *walks* to its status through the same transitions an
 * operator would use, rather than being written straight into it — which also
 * means the audit log reads like real operational history.
 */
const advanceOrder: readonly ServiceStatus[] = ['planned', 'confirmed', 'active', 'completed'];

function transitionsTo(target: ServiceStatus): readonly ServiceStatus[] {
  if (target === 'draft') return [];
  if (target === 'cancelled') return ['cancelled'];
  return advanceOrder.slice(0, advanceOrder.indexOf(target) + 1);
}

const services: readonly {
  recipeKey: string;
  name: string;
  startsAt: number;
  endsAt?: number;
  status: ServiceStatus;
  pickup: LocationKey;
  destination: LocationKey;
  values: Partial<Record<Exclude<BuiltinFieldKey, 'pickupLocation' | 'destination'>, Value>>;
}[] = [
  {
    recipeKey: 'airportArrivalTransfer',
    name: 'Llegada AV205 — artista principal',
    startsAt: bogota(2026, 8, 16, 14, 20),
    endsAt: bogota(2026, 8, 16, 15, 40),
    status: 'confirmed',
    pickup: 'eldoradoT1',
    destination: 'grandHyatt',
    values: {
      passengerCount: count(6),
      flightNumber: text('AV205'),
      terminal: text('T1 — Muelle internacional'),
      luggageCount: count(14),
      wheelchairCount: count(0),
      contactPerson: text('María Fernanda Rojas'),
      notes: longText('Recibir en la puerta de llegadas internacionales con aviso de nombre. Dos maletas de instrumentos viajan en sobrepeso.'),
    },
  },
  {
    recipeKey: 'airportArrivalTransfer',
    name: 'Llegada LA4080 — banda de soporte',
    startsAt: bogota(2026, 8, 16, 18, 45),
    endsAt: bogota(2026, 8, 16, 20, 5),
    status: 'confirmed',
    pickup: 'eldoradoT1',
    destination: 'dannCarlton',
    values: {
      passengerCount: count(9),
      flightNumber: text('LA4080'),
      terminal: text('T1 — Muelle internacional'),
      luggageCount: count(21),
      wheelchairCount: count(1),
      contactPerson: text('Andrés Camilo Peña'),
      notes: longText('Un integrante viaja con silla de ruedas; se requiere vehículo con acceso.'),
    },
  },
  {
    recipeKey: 'shuttleService',
    name: 'Shuttle hotel → Simón Bolívar (día 1)',
    startsAt: bogota(2026, 8, 17, 15, 0),
    endsAt: bogota(2026, 8, 17, 16, 0),
    status: 'planned',
    pickup: 'grandHyatt',
    destination: 'simonBolivar',
    values: {
      passengerCount: count(24),
      notes: longText('Salida puntual desde el lobby. Acreditaciones se entregan a bordo.'),
    },
  },
  {
    recipeKey: 'shuttleService',
    name: 'Shuttle Simón Bolívar → hotel (cierre día 1)',
    startsAt: bogota(2026, 8, 18, 1, 30),
    endsAt: bogota(2026, 8, 18, 2, 40),
    status: 'planned',
    pickup: 'simonBolivar',
    destination: 'grandHyatt',
    values: {
      passengerCount: count(24),
      notes: longText('Después del cierre del escenario principal. Punto de encuentro en el parqueadero de producción.'),
    },
  },
  {
    recipeKey: 'pointToPointTransfer',
    name: 'Traslado prensa Corferias → Movistar Arena',
    startsAt: bogota(2026, 8, 18, 10, 0),
    endsAt: bogota(2026, 8, 18, 10, 45),
    status: 'cancelled',
    pickup: 'corferias',
    destination: 'movistarArena',
    values: {
      passengerCount: count(12),
      luggageCount: count(6),
      wheelchairCount: count(0),
      contactPerson: text('Laura Gómez — prensa'),
      notes: longText('Rueda de prensa a las 11:00; llegar con 30 minutos de margen.'),
    },
  },
  {
    recipeKey: 'airportDepartureTransfer',
    name: 'Salida AV8020 — equipo de producción',
    startsAt: bogota(2026, 8, 19, 9, 15),
    endsAt: bogota(2026, 8, 19, 10, 30),
    status: 'draft',
    pickup: 'dannCarlton',
    destination: 'eldoradoT2',
    values: {
      passengerCount: count(8),
      flightNumber: text('AV8020'),
      terminal: text('T2 — Puente Aéreo'),
      luggageCount: count(19),
      wheelchairCount: count(0),
      contactPerson: text('Andrés Camilo Peña'),
      notes: longText('Vuelo 12:05; salir con tres horas de anticipación por cierre parcial de la Av. El Dorado.'),
    },
  },
];

const defaultProject = {
  name: 'FEP',
  description: 'Festival Estéreo Picnic',
  startsAt: bogota(2026, 8, 15, 16, 0),
  endsAt: bogota(2026, 8, 19, 16, 0),
};

/**
 * Runs the seed as the organization's own owner, so every model below applies
 * its ordinary role and ownership checks instead of receiving an exception.
 */
function withOwnerIdentity(ctx: MutationCtx, issuer: string, subject: string): MutationCtx {
  const identity: UserIdentity = { tokenIdentifier: `${issuer}|${subject}`, issuer, subject };
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

export const seedBogotaOperations = internalMutation({
  args: { organizationSlug: v.string(), projectName: v.optional(v.string()) },
  returns: v.object({ locations: v.number(), services: v.number(), projectName: v.string() }),
  handler: async (ctx, args) => {
    assertSeedingEnabled();

    const organization = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', args.organizationSlug))
      .unique();
    if (organization === null) {
      return invalidInput('seedOrganizationMissing', `No organization has the slug ${args.organizationSlug}`);
    }

    const memberships = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organization._id))
      .collect();
    const ownerMembership = memberships.find((membership) => membership.role === 'owner');
    if (ownerMembership === undefined) {
      return invalidInput('seedOrganizationOwnerMissing', 'The organization has no owner to seed as');
    }
    const owner = await ctx.db.get(ownerMembership.userId);
    if (owner === null) return notFoundOrInaccessible();
    const seeded = withOwnerIdentity(ctx, owner.authProvider, owner.authSubject);

    // The catalogue and starter recipes are prerequisites, and both are
    // idempotent, so this doubles as the repair path after a reset.
    const fieldIds = await ensureBuiltinFieldDefinitions(ctx);
    await provisionStarterRecipes(seeded, organization._id, fieldIds);

    const locationIds = new Map<LocationKey, Id<'locations'>>();
    for (const location of locations) {
      locationIds.set(
        location.key,
        await createLocation(seeded, {
          organizationId: organization._id,
          name: location.name,
          type: location.type,
          address: location.address,
          latitude: location.latitude,
          longitude: location.longitude,
        }),
      );
    }

    const projectName = args.projectName ?? defaultProject.name;
    // Projects are bounded per organization at demo scale; reuse the developer's
    // existing project rather than creating a second one with the same name.
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('organizationId', organization._id))
      .collect();
    const existingProject = projects.find((project) => project.name === projectName);
    const projectId =
      existingProject?._id ??
      (await createProject(seeded, {
        organizationId: organization._id,
        name: projectName,
        description: defaultProject.description,
        startsAt: defaultProject.startsAt,
        endsAt: defaultProject.endsAt,
      }));

    function requireLocation(key: LocationKey): Id<'locations'> {
      const id = locationIds.get(key);
      if (id === undefined) return invalidInput('seedLocationMissing', `Seed location is missing: ${key}`);
      return id;
    }
    function requireField(key: BuiltinFieldKey): Id<'fieldDefinitions'> {
      const id = fieldIds.get(key);
      if (id === undefined) return invalidInput('seedBuiltinFieldMissing', `Seed built-in field is missing: ${key}`);
      return id;
    }

    for (const service of services) {
      const recipe = await ctx.db
        .query('eventRecipes')
        .withIndex('by_org_key', (q) => q.eq('organizationId', organization._id).eq('key', service.recipeKey))
        .unique();
      if (recipe === null) {
        return invalidInput('seedRecipeMissing', `Starter recipe is missing: ${service.recipeKey}`);
      }
      const version = await ctx.db
        .query('recipeVersions')
        .withIndex('by_recipe_status', (q) => q.eq('recipeId', recipe._id).eq('status', 'published'))
        .unique();
      if (version === null) {
        return invalidInput('seedRecipeVersionMissing', `Starter recipe has no published version: ${service.recipeKey}`);
      }

      const values: { fieldDefinitionId: Id<'fieldDefinitions'>; value: Value }[] = [
        { fieldDefinitionId: requireField('pickupLocation'), value: { kind: 'location', locationId: requireLocation(service.pickup) } },
        { fieldDefinitionId: requireField('destination'), value: { kind: 'location', locationId: requireLocation(service.destination) } },
      ];
      for (const [key, value] of Object.entries(service.values)) {
        if (value === undefined) continue;
        values.push({ fieldDefinitionId: requireField(key as BuiltinFieldKey), value });
      }

      const eventId = await createEventFromRecipe(seeded, {
        projectId,
        recipeVersionId: version._id,
        name: service.name,
        startsAt: service.startsAt,
        ...(service.endsAt === undefined ? {} : { endsAt: service.endsAt }),
        values,
      });
      for (const status of transitionsTo(service.status)) {
        await changeEventStatus(seeded, { eventId, status });
      }
    }

    return { locations: locations.length, services: services.length, projectName };
  },
});
