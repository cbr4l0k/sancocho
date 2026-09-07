import { v } from 'convex/values';

import type { Id } from '../_generated/dataModel';
import { internalMutation } from '../_generated/server';
import { changeServiceStatus, createServiceFromServiceKind } from '../services/model';
import { ensureBuiltinFieldDefinitions, type BuiltinFieldKey } from '../fields/builtins';
import { createFieldDefinition, sameFieldConfig } from '../fields/model';
import { invalidInput } from '../lib/errors';
import { assertSeedingEnabled } from '../lib/seedGuard';
import { createLocation } from '../locations/model';
import { createProject } from '../projects/model';
import { addServiceKindField } from '../serviceKinds/fields/model';
import { createInitialDraftVersion, createServiceKind, publishServiceKindVersion } from '../serviceKinds/model';
import { createRelationship } from '../relationships/model';
import type { serviceFieldValueValidator, fieldConfigValidator, serviceStatusValidator } from '../validators';
import { resolveSeedOwnerContext } from './identity';

/**
 * Reproduces the operating vocabulary and representative line items from the
 * Cordillera 2026 ground-transport workbook inside an existing organization.
 * Organization fields and serviceKinds are independently idempotent by indexed key.
 * Locations, Services, and relationships are a clean-slate demonstration set:
 * once the named project contains any Service, a re-run treats it as complete
 * and skips those three sets instead of duplicating them.
 *
 * The mutation runs as the organization's own owner, so every write passes the
 * ordinary domain authorization, role, ownership, validation, audit, and
 * lifecycle gates. Colombia is UTC-5 year round; every Service timestamp below is
 * therefore an absolute instant derived from Bogotá wall clock with no DST.
 */

const bogotaUtcOffsetHours = -5;

function bogota(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - bogotaUtcOffsetHours, minute);
}

type FieldConfig = typeof fieldConfigValidator.type;
type Value = typeof serviceFieldValueValidator.type;
type ServiceStatus = typeof serviceStatusValidator.type;

const text = (value: string): Value => ({ kind: 'text', value });
const longText = (value: string): Value => ({ kind: 'longText', value });
const number = (value: number): Value => ({ kind: 'number', value });
const time = (value: string): Value => ({ kind: 'time', value });
const select = (optionId: string): Value => ({ kind: 'select', optionId });

type OrganizationFieldKey =
  | 'artist'
  | 'partyGroup'
  | 'stageName'
  | 'vehicleClass'
  | 'serviceModality'
  | 'vehicleQuantity'
  | 'unitRate'
  | 'notExecutedAmount'
  | 'additionalCharges'
  | 'additionalDetail'
  | 'billingParty'
  | 'driverName'
  | 'driverPhone'
  | 'vehiclePlate'
  | 'callTime'
  | 'flightTime'
  | 'cargoDetail'
  | 'supplierStatus';

type FieldKey = OrganizationFieldKey | BuiltinFieldKey;

type FieldSeed = { key: OrganizationFieldKey; label: string; config: FieldConfig };

const fieldDefinitions = [
  { key: 'artist', label: 'Artista', config: { kind: 'text' } },
  { key: 'partyGroup', label: 'Party', config: { kind: 'select', options: [
    { id: 'a', label: 'Party A' }, { id: 'b', label: 'Party B' }, { id: 'c', label: 'Party C' },
    { id: 'bc', label: 'Party B + C' }, { id: 'inv', label: 'Invitados' }, { id: 'crew', label: 'Crew completo' },
  ] } },
  { key: 'stageName', label: 'Escenario', config: { kind: 'select', options: [
    { id: 'stage3', label: 'Stage 3' }, { id: 'stage4', label: 'Stage 4' },
    { id: 'clubColombia', label: 'Club Colombia' }, { id: 'general', label: 'General' },
  ] } },
  { key: 'vehicleClass', label: 'Clase de vehículo', config: { kind: 'select', options: [
    { id: 'h1', label: 'H1' }, { id: 'sprinter', label: 'Sprinter' }, { id: 'sprinter18', label: 'Sprinter 18 pax' },
    { id: 'gamaMedia', label: 'Gama media' }, { id: 'suvGamaMedia', label: 'SUV gama media' },
    { id: 'suvConvencional', label: 'SUV convencional' }, { id: 'duster', label: 'Duster' },
    { id: 'cargoVan', label: 'Cargo van' }, { id: 'cargoTruck', label: 'Cargo truck' },
    { id: 'coordinador', label: 'Coordinador' },
  ] } },
  { key: 'serviceModality', label: 'Modalidad', config: { kind: 'select', options: [
    { id: 'trayecto', label: 'Trayecto' }, { id: 'disponibilidad12h', label: 'Disponibilidad 12 horas' },
    { id: 'ruta', label: 'Ruta' },
  ] } },
  { key: 'vehicleQuantity', label: 'Cantidad de vehículos', config: { kind: 'number', min: 1, integer: true } },
  { key: 'unitRate', label: 'Tarifa unitaria (COP)', config: { kind: 'number', min: 0 } },
  { key: 'notExecutedAmount', label: 'No ejecutados (COP)', config: { kind: 'number', min: 0 } },
  { key: 'additionalCharges', label: 'Adicionales (COP)', config: { kind: 'number', min: 0 } },
  { key: 'additionalDetail', label: 'Detalle de adicionales', config: { kind: 'longText' } },
  { key: 'billingParty', label: 'Socio / cuenta', config: { kind: 'select', options: [
    { id: 'paramo', label: 'Páramo Presenta' }, { id: 'ocesa', label: 'OCESA' },
    { id: 'promotoria', label: 'Promotoría' }, { id: 'clubColombia', label: 'Club Colombia' },
    { id: 'interno', label: 'Movimientos internos' }, { id: 'equipo', label: 'Equipo Páramo' },
  ] } },
  { key: 'driverName', label: 'Conductor', config: { kind: 'text' } },
  { key: 'driverPhone', label: 'Contacto conductor', config: { kind: 'text' } },
  { key: 'vehiclePlate', label: 'Placa', config: { kind: 'text' } },
  { key: 'callTime', label: 'Hora de llamado', config: { kind: 'time' } },
  { key: 'flightTime', label: 'Hora de vuelo', config: { kind: 'time' } },
  { key: 'cargoDetail', label: 'Detalle de carga', config: { kind: 'longText' } },
  { key: 'supplierStatus', label: 'Estado con el proveedor', config: { kind: 'select', options: [
    { id: 'pendiente', label: 'Pendiente' }, { id: 'asignado', label: 'Vehículo asignado' },
    { id: 'confirmado', label: 'Confirmado' }, { id: 'ejecutado', label: 'Ejecutado' },
    { id: 'noEjecutado', label: 'No ejecutado' },
  ] } },
] as const satisfies readonly FieldSeed[];

/**
 * Service names are tenant-authored text an operator reads in the console, so
 * they must carry the option's LABEL ("Sprinter 18 pax"), never its stored
 * option id ("sprinter18"). Both lookups are derived from the field definitions
 * above rather than restated, so a renamed option can never leave a stale name
 * behind in a service title.
 */
function optionLabels(key: OrganizationFieldKey): ReadonlyMap<string, string> {
  const definition = fieldDefinitions.find((field) => field.key === key);
  if (definition === undefined || definition.config.kind !== 'select') return new Map();
  return new Map(definition.config.options.map((option) => [option.id, option.label]));
}

const vehicleLabels = optionLabels('vehicleClass');
const billingLabels = optionLabels('billingParty');

function vehicleLabel(vehicle: Vehicle): string {
  return vehicleLabels.get(vehicle) ?? vehicle;
}

function billingLabel(billing: string): string {
  return billingLabels.get(billing) ?? billing;
}

type ServiceKindSeed = {
  key: ServiceKindKey;
  name: string;
  description: string;
  composition: readonly { key: FieldKey; required: boolean }[];
};

type ServiceKindKey =
  | 'festivalArtistTransfer'
  | 'festivalArtistDisposition'
  | 'festivalInternalMovement'
  | 'festivalPartnerService'
  | 'festivalCrewShuttle'
  | 'festivalCoordination';

const artistComposition = [
  ['artist', true], ['stageName', true], ['billingParty', true], ['pickupLocation', true],
  ['destination', true], ['vehicleClass', true], ['serviceModality', true], ['vehicleQuantity', true],
  ['unitRate', true], ['partyGroup', false], ['passengerCount', false], ['flightNumber', false],
  ['flightTime', false], ['terminal', false], ['callTime', false], ['luggageCount', false],
  ['cargoDetail', false], ['contactPerson', false], ['supplierStatus', false], ['driverName', false],
  ['driverPhone', false], ['vehiclePlate', false], ['notExecutedAmount', false],
  ['additionalCharges', false], ['additionalDetail', false], ['notes', false],
] as const satisfies readonly (readonly [FieldKey, boolean])[];

function composition(entries: readonly (readonly [FieldKey, boolean])[]): readonly { key: FieldKey; required: boolean }[] {
  return entries.map(([key, required]) => ({ key, required }));
}

const serviceKinds = [
  { key: 'festivalArtistTransfer', name: 'Traslado de artista', description: 'Traslado puntual de un artista y su party entre aeropuerto, hotel y venue.', composition: composition(artistComposition) },
  { key: 'festivalArtistDisposition', name: 'Disponibilidad de artista', description: 'Vehículo a disposición de un artista durante la jornada de prueba de sonido y show.', composition: composition(artistComposition) },
  { key: 'festivalInternalMovement', name: 'Movimiento interno', description: 'Vehículo en disponibilidad para movimientos de producción dentro del venue.', composition: composition([
    ['stageName', true], ['billingParty', true], ['pickupLocation', true], ['destination', true],
    ['vehicleClass', true], ['serviceModality', true], ['vehicleQuantity', true], ['unitRate', true],
    ['cargoDetail', false], ['supplierStatus', false], ['driverName', false], ['driverPhone', false],
    ['vehiclePlate', false], ['notes', false],
  ]) },
  { key: 'festivalPartnerService', name: 'Servicio a socio', description: 'Vehículo asignado a un socio comercial del festival (OCESA, Promotoría, Club Colombia).', composition: composition([
    ['billingParty', true], ['pickupLocation', true], ['destination', true], ['vehicleClass', true],
    ['serviceModality', true], ['vehicleQuantity', true], ['unitRate', true], ['stageName', false],
    ['passengerCount', false], ['contactPerson', false], ['supplierStatus', false], ['driverName', false],
    ['driverPhone', false], ['vehiclePlate', false], ['notes', false],
  ]) },
  { key: 'festivalCrewShuttle', name: 'Ruta de equipo', description: 'Ruta de recogida del equipo de producción en distintos puntos de la ciudad con destino al venue.', composition: composition([
    ['billingParty', true], ['pickupLocation', true], ['destination', true], ['vehicleClass', true],
    ['serviceModality', true], ['vehicleQuantity', true], ['unitRate', true], ['passengerCount', false],
    ['callTime', false], ['supplierStatus', false], ['driverName', false], ['driverPhone', false],
    ['vehiclePlate', false], ['notes', false],
  ]) },
  { key: 'festivalCoordination', name: 'Coordinación en sitio', description: 'Coordinador de transporte en venue o aeropuerto durante una jornada de 12 horas.', composition: composition([
    ['stageName', true], ['billingParty', true], ['destination', true], ['serviceModality', true],
    ['vehicleQuantity', true], ['unitRate', true], ['callTime', false], ['contactPerson', false],
    ['supplierStatus', false], ['driverName', false], ['driverPhone', false], ['notes', false],
  ]) },
] as const satisfies readonly ServiceKindSeed[];

type LocationKey =
  | 'eldoradoT1' | 'eldoradoT2' | 'simonBolivar' | 'clubColombiaStage' | 'wyndham'
  | 'bhLaQuinta' | 'marriottBogota' | 'grandHyatt' | 'paramoOffice' | 'fontibonDepot';

const locations: readonly {
  key: LocationKey; name: string; type: 'airport' | 'venue' | 'hotel' | 'office' | 'depot';
  address: string; latitude: number; longitude: number;
}[] = [
  { key: 'eldoradoT1', name: 'El Dorado T1 — Llegadas internacionales', type: 'airport', address: 'Av. El Dorado #103-9, Fontibón, Bogotá', latitude: 4.7016, longitude: -74.1469 },
  { key: 'eldoradoT2', name: 'El Dorado T2 — Puente Aéreo', type: 'airport', address: 'Av. El Dorado #106-39, Fontibón, Bogotá', latitude: 4.7106, longitude: -74.1441 },
  { key: 'simonBolivar', name: 'Parque Simón Bolívar — Cordillera', type: 'venue', address: 'Av. Calle 63 #59-05, Bogotá', latitude: 4.6580, longitude: -74.0930 },
  { key: 'clubColombiaStage', name: 'Escenario Club Colombia', type: 'venue', address: 'Av. Calle 63 #59-05, Bogotá', latitude: 4.6586, longitude: -74.0941 },
  { key: 'wyndham', name: 'Wyndham Bogotá Art', type: 'hotel', address: 'Calle 93 #11-45, Bogotá', latitude: 4.6773, longitude: -74.0487 },
  { key: 'bhLaQuinta', name: 'BH La Quinta', type: 'hotel', address: 'Carrera 5 #74-52, Bogotá', latitude: 4.6588, longitude: -74.0553 },
  { key: 'marriottBogota', name: 'Marriott Bogotá', type: 'hotel', address: 'Av. El Dorado #69B-53, Bogotá', latitude: 4.6788, longitude: -74.1080 },
  { key: 'grandHyatt', name: 'Grand Hyatt Bogotá', type: 'hotel', address: 'Calle 24A #57-60, Bogotá', latitude: 4.6503, longitude: -74.1057 },
  { key: 'paramoOffice', name: 'Oficina Páramo Presenta', type: 'office', address: 'Carrera 13 #85-32, Bogotá', latitude: 4.6690, longitude: -74.0530 },
  { key: 'fontibonDepot', name: 'Patio de vehículos Fontibón', type: 'depot', address: 'Calle 17 #96-50, Fontibón, Bogotá', latitude: 4.6790, longitude: -74.1460 },
];

type FieldValue = { key: FieldKey; value: Value };
type Service = {
  seedKey: string;
  serviceKindKey: ServiceKindKey;
  name: string;
  startsAt: number;
  endsAt?: number;
  status: ServiceStatus;
  pickup?: LocationKey;
  destination: LocationKey;
  values: readonly FieldValue[];
};

type Vehicle = 'h1' | 'sprinter' | 'sprinter18' | 'gamaMedia' | 'suvGamaMedia' | 'suvConvencional' | 'duster' | 'cargoVan' | 'cargoTruck';
type Stage = 'stage3' | 'stage4';

const driverNames = ['Carlos Rincón', 'Diana Muñoz', 'Julián Pardo', 'Mónica Salazar', 'Sergio Bernal', 'Paula Castaño'] as const;
const driverPhones = ['310 5550101', '311 5550102', '312 5550103', '315 5550104', '316 5550105', '320 5550106'] as const;
const plates = ['KLM482', 'RZU19D', 'JPN735', 'TQS42F', 'VXM906', 'LHR63E'] as const;

function operationalValues(status: ServiceStatus, index: number): readonly FieldValue[] {
  if (status === 'draft' || status === 'planned') return [];
  const slot = index % driverNames.length;
  return [
    { key: 'supplierStatus', value: select(status === 'completed' ? 'ejecutado' : status === 'cancelled' ? 'noEjecutado' : 'confirmado') },
    { key: 'driverName', value: text(driverNames[slot] ?? 'Carlos Rincón') },
    { key: 'driverPhone', value: text(driverPhones[slot] ?? '310 5550101') },
    { key: 'vehiclePlate', value: text(plates[slot] ?? 'KLM482') },
  ];
}

function commonValues(args: {
  stage?: Stage | 'clubColombia' | 'general'; billing: 'paramo' | 'ocesa' | 'promotoria' | 'clubColombia' | 'interno' | 'equipo';
  vehicle: Vehicle; modality: 'trayecto' | 'disponibilidad12h' | 'ruta'; quantity?: number; rate: number;
}): FieldValue[] {
  return [
    ...(args.stage === undefined ? [] : [{ key: 'stageName' as const, value: select(args.stage) }]),
    { key: 'billingParty', value: select(args.billing) },
    { key: 'vehicleClass', value: select(args.vehicle) },
    { key: 'serviceModality', value: select(args.modality) },
    { key: 'vehicleQuantity', value: number(args.quantity ?? 1) },
    { key: 'unitRate', value: number(args.rate) },
  ];
}

type ArtistChain = {
  key: string; artist: string; stage: Stage; hotel: LocationKey; vehicle: Vehicle; transferRate: number; dispositionRate: number;
  passengers: number; arrival: readonly [number, number, number]; show: readonly [number, number, number]; departure: readonly [number, number, number];
  party?: 'a' | 'b' | 'c' | 'bc' | 'inv'; hotelNote?: string;
};

const artistChains: readonly ArtistChain[] = [
  { key: 'latin', artist: 'Latin Brothers', stage: 'stage3', hotel: 'wyndham', vehicle: 'h1', transferRate: 185000, dispositionRate: 640000, passengers: 4, arrival: [11, 11, 0], show: [12, 13, 0], departure: [13, 10, 0] },
  { key: 'emmanuel', artist: 'Emmanuel Horvilleur', stage: 'stage3', hotel: 'bhLaQuinta', vehicle: 'suvGamaMedia', transferRate: 420000, dispositionRate: 1200000, passengers: 13, party: 'a', arrival: [11, 14, 0], show: [12, 14, 30], departure: [13, 11, 0] },
  { key: 'ke', artist: 'Ke Personajes', stage: 'stage3', hotel: 'grandHyatt', vehicle: 'sprinter18', transferRate: 220000, dispositionRate: 810000, passengers: 12, arrival: [11, 16, 0], show: [12, 15, 0], departure: [13, 12, 0] },
  { key: 'meme', artist: 'Meme del Real', stage: 'stage3', hotel: 'wyndham', vehicle: 'h1', transferRate: 185000, dispositionRate: 640000, passengers: 4, party: 'a', arrival: [11, 17, 0], show: [12, 16, 0], departure: [13, 13, 0] },
  { key: 'miguel', artist: 'Miguel Mateos', stage: 'stage3', hotel: 'marriottBogota', vehicle: 'sprinter', transferRate: 220000, dispositionRate: 810000, passengers: 12, arrival: [11, 18, 0], show: [12, 17, 0], departure: [13, 14, 0] },
  { key: 'adentro', artist: 'Los de Adentro', stage: 'stage3', hotel: 'bhLaQuinta', vehicle: 'sprinter', transferRate: 220000, dispositionRate: 810000, passengers: 13, arrival: [12, 10, 0], show: [13, 15, 0], departure: [14, 9, 0] },
  { key: 'dante', artist: 'Dante Spinetta', stage: 'stage3', hotel: 'grandHyatt', vehicle: 'sprinter18', transferRate: 220000, dispositionRate: 810000, passengers: 14, arrival: [12, 11, 0], show: [13, 16, 0], departure: [14, 10, 0] },
  { key: 'krapula', artist: 'Doctor Krápula', stage: 'stage3', hotel: 'wyndham', vehicle: 'sprinter', transferRate: 220000, dispositionRate: 810000, passengers: 12, arrival: [12, 12, 0], show: [13, 1, 0], departure: [14, 11, 0] },
  { key: 'kapanga', artist: 'Kapanga', stage: 'stage4', hotel: 'wyndham', vehicle: 'sprinter', transferRate: 220000, dispositionRate: 810000, passengers: 12, arrival: [11, 13, 0], show: [12, 14, 30], departure: [13, 14, 0] },
  { key: 'poligamia', artist: 'Poligamia', stage: 'stage4', hotel: 'bhLaQuinta', vehicle: 'duster', transferRate: 95000, dispositionRate: 525000, passengers: 4, arrival: [11, 15, 0], show: [12, 15, 45], departure: [13, 15, 0] },
  { key: 'virus', artist: 'Virus', stage: 'stage4', hotel: 'marriottBogota', vehicle: 'sprinter', transferRate: 220000, dispositionRate: 810000, passengers: 12, arrival: [11, 11, 50], show: [12, 17, 30], departure: [13, 14, 0] },
  { key: 'lido', artist: 'Lido Pimienta', stage: 'stage4', hotel: 'bhLaQuinta', vehicle: 'sprinter', transferRate: 220000, dispositionRate: 810000, passengers: 12, arrival: [11, 16, 0], show: [12, 20, 15], departure: [13, 16, 0] },
  { key: 'jarabe', artist: 'Jarabe de Palo', stage: 'stage4', hotel: 'grandHyatt', vehicle: 'sprinter', transferRate: 220000, dispositionRate: 810000, passengers: 12, arrival: [12, 13, 0], show: [13, 6, 45], departure: [14, 8, 0], hotelNote: 'Hotel TBC en la hoja; se usa Grand Hyatt Bogotá como hotel plausible.' },
  { key: 'diamante', artist: 'Diamante Eléctrico', stage: 'stage4', hotel: 'grandHyatt', vehicle: 'duster', transferRate: 95000, dispositionRate: 525000, passengers: 4, party: 'b', arrival: [12, 14, 0], show: [13, 8, 30], departure: [14, 12, 0], hotelNote: 'HOTEL/TBC en la hoja; se usa Grand Hyatt Bogotá como hotel plausible.' },
  { key: 'amigos', artist: 'Los Amigos Invisibles', stage: 'stage4', hotel: 'wyndham', vehicle: 'sprinter', transferRate: 220000, dispositionRate: 810000, passengers: 12, party: 'a', arrival: [12, 15, 0], show: [13, 19, 45], departure: [14, 13, 0], hotelNote: 'HOTEL/TBC en la hoja; se usa Wyndham Bogotá Art como hotel plausible.' },
];

function artistStatus(index: number, leg: 'arrival' | 'show' | 'departure', day: number): ServiceStatus {
  if ((index === 2 && leg === 'departure') || (index === 6 && leg === 'arrival') || (index === 12 && leg === 'show')) return 'cancelled';
  if (leg === 'arrival' && day === 11) return 'completed';
  if (leg === 'arrival') return 'confirmed';
  if (leg === 'show') return index % 2 === 0 ? 'active' : 'confirmed';
  return day === 14 ? 'planned' : 'confirmed';
}

function at(tuple: readonly [number, number, number]): number {
  return bogota(2026, 9, tuple[0], tuple[1], tuple[2]);
}

function artistServices(): Service[] {
  const result: Service[] = [];
  for (const [index, artist] of artistChains.entries()) {
    const base: FieldValue[] = [
      { key: 'artist', value: text(artist.artist) },
      { key: 'stageName', value: select(artist.stage) },
      { key: 'billingParty', value: select('paramo') },
      { key: 'vehicleClass', value: select(artist.vehicle) },
      { key: 'vehicleQuantity', value: number(1) },
      { key: 'passengerCount', value: number(artist.passengers) },
      ...(artist.party === undefined ? [] : [{ key: 'partyGroup' as const, value: select(artist.party) }]),
    ];
    const arrivalStatus = artistStatus(index, 'arrival', artist.arrival[0]);
    const showStatus = artistStatus(index, 'show', artist.show[0]);
    const departureStatus = artistStatus(index, 'departure', artist.departure[0]);
    result.push({
      seedKey: `${artist.key}-arrival`, serviceKindKey: 'festivalArtistTransfer',
      name: `Llegada aeropuerto — ${artist.artist} (${vehicleLabel(artist.vehicle)})`, startsAt: at(artist.arrival),
      endsAt: at([artist.arrival[0], artist.arrival[1] + 1, artist.arrival[2]]), status: arrivalStatus,
      pickup: 'eldoradoT1', destination: artist.hotel,
      values: [...base, { key: 'serviceModality', value: select('trayecto') }, { key: 'unitRate', value: number(artist.transferRate) },
        { key: 'terminal', value: text('T1 — Llegadas internacionales') },
        ...(arrivalStatus === 'cancelled' ? [{ key: 'notExecutedAmount' as const, value: number(artist.transferRate) }] : []),
        ...(artist.hotelNote === undefined && arrivalStatus !== 'cancelled' ? [] : [{ key: 'notes' as const, value: longText([artist.hotelNote, arrivalStatus === 'cancelled' ? 'Servicio no ejecutado, registrado en la columna NO EJECUTADOS.' : undefined].filter((note) => note !== undefined).join(' ')) }]),
        ...operationalValues(arrivalStatus, index)],
    });
    result.push({
      seedKey: `${artist.key}-show`, serviceKindKey: 'festivalArtistDisposition',
      name: `Disponibilidad show — ${artist.artist} (${vehicleLabel(artist.vehicle)})`, startsAt: at(artist.show),
      endsAt: at([artist.show[0], artist.show[1] + 12, artist.show[2]]), status: showStatus,
      pickup: artist.hotel, destination: 'simonBolivar',
      values: [...base, { key: 'serviceModality', value: select('disponibilidad12h') }, { key: 'unitRate', value: number(artist.dispositionRate) },
        { key: 'callTime', value: time(`${String(artist.show[1]).padStart(2, '0')}:${String(artist.show[2]).padStart(2, '0')}`) },
        ...(showStatus === 'cancelled' ? [{ key: 'notExecutedAmount' as const, value: number(artist.dispositionRate) }] : []),
        ...(artist.hotelNote === undefined && showStatus !== 'cancelled' ? [] : [{ key: 'notes' as const, value: longText([artist.hotelNote, showStatus === 'cancelled' ? 'Disponibilidad no ejecutada, registrada en la columna NO EJECUTADOS.' : undefined].filter((note) => note !== undefined).join(' ')) }]),
        ...operationalValues(showStatus, index + 1)],
    });
    result.push({
      seedKey: `${artist.key}-departure`, serviceKindKey: 'festivalArtistTransfer',
      name: `Salida aeropuerto — ${artist.artist} (${vehicleLabel(artist.vehicle)})`, startsAt: at(artist.departure),
      endsAt: at([artist.departure[0], artist.departure[1] + 1, artist.departure[2]]), status: departureStatus,
      pickup: artist.hotel, destination: 'eldoradoT1',
      values: [...base, { key: 'serviceModality', value: select('trayecto') }, { key: 'unitRate', value: number(artist.transferRate) },
        { key: 'terminal', value: text('T1 — Salidas') },
        ...(departureStatus === 'cancelled' ? [{ key: 'notExecutedAmount' as const, value: number(artist.transferRate) }] : []),
        ...(artist.hotelNote === undefined && departureStatus !== 'cancelled' ? [] : [{ key: 'notes' as const, value: longText([artist.hotelNote, departureStatus === 'cancelled' ? 'Salida no ejecutada, registrada en la columna NO EJECUTADOS.' : undefined].filter((note) => note !== undefined).join(' ')) }]),
        ...operationalValues(departureStatus, index + 2)],
    });
  }
  return result;
}

const standaloneArtists: readonly {
  key: string; artist: string; stage: Stage; vehicle: Vehicle; rate: number; day: number; hour: number; minute: number; passengers?: number; party?: string; notes?: string;
}[] = [
  { key: 'arbol-show', artist: 'Árbol de Ojos', stage: 'stage3', vehicle: 'sprinter18', rate: 810000, day: 13, hour: 13, minute: 30, passengers: 17 },
  { key: 'vicente-show', artist: 'Vicente García', stage: 'stage3', vehicle: 'sprinter', rate: 810000, day: 13, hour: 18, minute: 0 },
  { key: 'kei-show', artist: 'Kei Linch', stage: 'stage4', vehicle: 'sprinter', rate: 810000, day: 12, hour: 10, minute: 20 },
  { key: 'flor-show', artist: 'Flor de Lava', stage: 'stage4', vehicle: 'h1', rate: 640000, day: 13, hour: 14, minute: 45, notes: 'La hora de recogida 14.45 es un error de captura; se omite Hora de llamado.' },
  { key: 'bonka-show', artist: 'Bonka', stage: 'stage4', vehicle: 'sprinter', rate: 810000, day: 13, hour: 5, minute: 30, party: 'a' },
];

function standaloneServices(): Service[] {
  return standaloneArtists.map((artist, index) => ({
    seedKey: artist.key,
    serviceKindKey: 'festivalArtistDisposition',
    name: `Disponibilidad show — ${artist.artist} (${vehicleLabel(artist.vehicle)})`,
    startsAt: bogota(2026, 9, artist.day, artist.hour, artist.minute),
    endsAt: bogota(2026, 9, artist.day, artist.hour + 12, artist.minute),
    status: index % 2 === 0 ? 'active' : 'confirmed',
    pickup: artist.stage === 'stage3' ? 'bhLaQuinta' : 'grandHyatt',
    destination: 'simonBolivar',
    values: [
      { key: 'artist', value: text(artist.artist) },
      ...commonValues({ stage: artist.stage, billing: 'paramo', vehicle: artist.vehicle, modality: 'disponibilidad12h', rate: artist.rate }),
      ...(artist.passengers === undefined ? [] : [{ key: 'passengerCount' as const, value: number(artist.passengers) }]),
      ...(artist.party === undefined ? [] : [{ key: 'partyGroup' as const, value: select(artist.party) }]),
      ...(artist.notes === undefined ? [{ key: 'callTime' as const, value: time(`${String(artist.hour).padStart(2, '0')}:${String(artist.minute).padStart(2, '0')}`) }] : [{ key: 'notes' as const, value: longText(artist.notes) }]),
      ...operationalValues(index % 2 === 0 ? 'active' : 'confirmed', index + 30),
    ],
  }));
}

const cargoRows: readonly { key: string; artist: string; stage: Stage; vehicle: 'cargoVan' | 'cargoTruck'; rate: number; day: number; hour: number; target: string; detail: string }[] = [
  { key: 'latin-cargo', artist: 'Latin Brothers', stage: 'stage3', vehicle: 'cargoTruck', rate: 280000, day: 11, hour: 11, target: 'latin-arrival', detail: 'Confirmar cantidad de carga.' },
  { key: 'emmanuel-cargo', artist: 'Emmanuel Horvilleur', stage: 'stage3', vehicle: 'cargoVan', rate: 280000, day: 11, hour: 14, target: 'emmanuel-arrival', detail: '14 equipajes pequeños, 4 grandes, 5 instrumentos y 6 cases.' },
  { key: 'ke-cargo', artist: 'Ke Personajes', stage: 'stage3', vehicle: 'cargoTruck', rate: 280000, day: 11, hour: 16, target: 'ke-arrival', detail: '22 equipajes pequeños y 20 equipajes grandes.' },
  { key: 'miguel-cargo', artist: 'Miguel Mateos', stage: 'stage3', vehicle: 'cargoTruck', rate: 980000, day: 12, hour: 13, target: 'miguel-show', detail: 'Confirmar cases e instrumentos y modalidad final.' },
  { key: 'adentro-cargo', artist: 'Los de Adentro', stage: 'stage3', vehicle: 'cargoVan', rate: 280000, day: 12, hour: 10, target: 'adentro-arrival', detail: '14 maletas de viaje, bajo, guitarra, pedales y platos.' },
  { key: 'dante-cargo', artist: 'Dante Spinetta', stage: 'stage3', vehicle: 'cargoTruck', rate: 980000, day: 13, hour: 16, target: 'dante-show', detail: '20 bultos de aproximadamente 15 kilos entre maletas e instrumentos.' },
  { key: 'virus-cargo', artist: 'Virus', stage: 'stage4', vehicle: 'cargoVan', rate: 280000, day: 11, hour: 11, target: 'virus-arrival', detail: 'Carga de instrumentos asociada al vuelo AV0154.' },
];

function cargoServices(): Service[] {
  return cargoRows.map((row, index) => ({
    seedKey: row.key, serviceKindKey: row.rate === 980000 ? 'festivalArtistDisposition' : 'festivalArtistTransfer',
    name: `${row.rate === 980000 ? 'Disponibilidad' : 'Llegada'} carga — ${row.artist} (${vehicleLabel(row.vehicle)})`,
    startsAt: bogota(2026, 9, row.day, row.hour, 0),
    endsAt: bogota(2026, 9, row.day, row.hour + (row.rate === 980000 ? 12 : 2), 0),
    status: row.day === 11 ? 'completed' : 'confirmed', pickup: row.day === 11 ? 'eldoradoT1' : 'grandHyatt', destination: 'simonBolivar',
    values: [
      { key: 'artist', value: text(row.artist) },
      ...commonValues({ stage: row.stage, billing: 'paramo', vehicle: row.vehicle, modality: row.rate === 980000 ? 'disponibilidad12h' : 'trayecto', rate: row.rate }),
      { key: 'cargoDetail', value: longText(row.detail) },
      ...operationalValues(row.day === 11 ? 'completed' : 'confirmed', index + 40),
    ],
  }));
}

function partnerServices(): Service[] {
  const result: Service[] = [];
  for (const day of [12, 13] as const) {
    for (let vehicle = 1; vehicle <= 6; vehicle += 1) {
      result.push({
        seedKey: `club-${day}-${vehicle}`, serviceKindKey: 'festivalPartnerService',
        name: `Sprinter ${vehicle} Club Colombia — ${day}/09`, startsAt: bogota(2026, 9, day, 12, 0),
        endsAt: bogota(2026, 9, day + 1, 0, 0), status: day === 12 ? 'active' : 'confirmed',
        pickup: 'clubColombiaStage', destination: 'clubColombiaStage',
        values: [...commonValues({ stage: 'clubColombia', billing: 'clubColombia', vehicle: 'sprinter', modality: 'disponibilidad12h', rate: 810000 }),
          ...operationalValues(day === 12 ? 'active' : 'confirmed', vehicle + day)],
      });
    }
  }
  const partnerRows = [
    { key: 'ocesa-11-a', billing: 'ocesa' as const, vehicle: 'duster' as const, modality: 'trayecto' as const, rate: 95000, day: 11, hour: 9 },
    { key: 'ocesa-12', billing: 'ocesa' as const, vehicle: 'duster' as const, modality: 'disponibilidad12h' as const, rate: 525000, day: 12, hour: 8 },
    { key: 'ocesa-13', billing: 'ocesa' as const, vehicle: 'duster' as const, modality: 'disponibilidad12h' as const, rate: 525000, day: 13, hour: 8 },
    { key: 'promotoria-12', billing: 'promotoria' as const, vehicle: 'h1' as const, modality: 'disponibilidad12h' as const, rate: 640000, day: 12, hour: 9 },
    { key: 'promotoria-13', billing: 'promotoria' as const, vehicle: 'h1' as const, modality: 'disponibilidad12h' as const, rate: 640000, day: 13, hour: 9 },
  ];
  for (const [index, row] of partnerRows.entries()) {
    const duration = row.modality === 'trayecto' ? 2 : 12;
    const status: ServiceStatus = row.day === 11 ? 'completed' : row.day === 12 ? 'active' : 'confirmed';
    result.push({ seedKey: row.key, serviceKindKey: 'festivalPartnerService', name: `Servicio ${billingLabel(row.billing)} — ${row.day}/09 (${vehicleLabel(row.vehicle)})`,
      startsAt: bogota(2026, 9, row.day, row.hour, 0), endsAt: bogota(2026, 9, row.day, row.hour + duration, 0), status,
      pickup: 'paramoOffice', destination: 'simonBolivar', values: [...commonValues({ billing: row.billing, vehicle: row.vehicle, modality: row.modality, rate: row.rate }), ...operationalValues(status, index + 50)] });
  }
  return result;
}

function internalServices(): Service[] {
  const rows = [
    { day: 12, vehicle: 'sprinter' as const, rate: 810000 }, { day: 12, vehicle: 'cargoVan' as const, rate: 980000 },
    { day: 13, vehicle: 'sprinter' as const, rate: 810000 }, { day: 13, vehicle: 'cargoTruck' as const, rate: 980000 },
  ];
  return rows.map((row, index) => ({
    seedKey: `internal-${index}`, serviceKindKey: 'festivalInternalMovement', name: `Movimiento interno ${vehicleLabel(row.vehicle)} — ${row.day}/09`,
    startsAt: bogota(2026, 9, row.day, 8, 0), endsAt: bogota(2026, 9, row.day, 20, 0), status: row.day === 12 ? 'active' : 'confirmed',
    pickup: 'simonBolivar', destination: 'clubColombiaStage',
    values: [...commonValues({ stage: 'general', billing: 'interno', vehicle: row.vehicle, modality: 'disponibilidad12h', rate: row.rate }),
      { key: 'cargoDetail', value: longText(row.vehicle.startsWith('cargo') ? 'Carga de producción dentro del venue.' : 'Pasajeros de producción dentro del venue.') },
      ...operationalValues(row.day === 12 ? 'active' : 'confirmed', index + 60)],
  }));
}

function crewServices(): Service[] {
  const rows = [
    { day: 9, shift: 'Jornada', modality: 'disponibilidad12h' as const, hour: 8, status: 'completed' as const },
    { day: 10, shift: 'Jornada', modality: 'disponibilidad12h' as const, hour: 8, status: 'completed' as const },
    { day: 11, shift: 'Jornada', modality: 'disponibilidad12h' as const, hour: 8, status: 'completed' as const },
    { day: 12, shift: 'AM', modality: 'ruta' as const, hour: 6, status: 'active' as const },
    { day: 12, shift: 'PM', modality: 'ruta' as const, hour: 17, status: 'confirmed' as const },
    { day: 13, shift: 'AM', modality: 'ruta' as const, hour: 6, status: 'confirmed' as const },
    { day: 13, shift: 'PM', modality: 'ruta' as const, hour: 17, status: 'confirmed' as const },
    { day: 14, shift: 'Cierre', modality: 'trayecto' as const, hour: 8, status: 'draft' as const },
  ];
  return rows.map((row, index) => {
    const duration = row.modality === 'ruta' ? 3 : row.modality === 'trayecto' ? 2 : 12;
    return { seedKey: `crew-${row.day}-${row.shift}`, serviceKindKey: 'festivalCrewShuttle', name: `${row.modality === 'ruta' ? `Ruta ${row.shift}` : row.shift} equipo Páramo — ${row.day}/09`,
      startsAt: bogota(2026, 9, row.day, row.hour, 0), endsAt: bogota(2026, 9, row.day, row.hour + duration, 0), status: row.status,
      pickup: row.modality === 'ruta' ? 'paramoOffice' : 'fontibonDepot', destination: 'simonBolivar',
      values: [...commonValues({ billing: 'equipo', vehicle: 'h1', modality: row.modality, rate: 640000 }),
        { key: 'callTime', value: time(`${String(row.hour).padStart(2, '0')}:00`) },
        { key: 'notes', value: longText(row.modality === 'ruta' ? 'Diferentes puntos de la ciudad con destino al venue.' : 'Vehículo de equipo a disposición del festival.') },
        ...operationalValues(row.status, index + 70)] };
  });
}

const coordinationServices: readonly Service[] = [
  // Every person in this seed is invented and every number is in the reserved
  // 555 range: the source workbook names real coordinators and drivers, and a
  // demonstration dataset in an open repository must never carry them.
  { seedKey: 'coord-airport', serviceKindKey: 'festivalCoordination', name: 'Coordinación aeropuerto', startsAt: bogota(2026, 9, 12, 7, 0), endsAt: bogota(2026, 9, 12, 19, 0), status: 'active', destination: 'eldoradoT1', values: [
    { key: 'stageName', value: select('general') }, { key: 'billingParty', value: select('paramo') }, { key: 'serviceModality', value: select('disponibilidad12h') },
    { key: 'vehicleQuantity', value: number(1) }, { key: 'unitRate', value: number(0) }, { key: 'callTime', value: time('07:00') },
    { key: 'contactPerson', value: text('Andrés Villalba — 317 5550107') }, { key: 'supplierStatus', value: select('confirmado') },
    { key: 'driverName', value: text('Andrés Villalba') }, { key: 'driverPhone', value: text('317 5550107') },
  ] },
  { seedKey: 'coord-venue-stage3', serviceKindKey: 'festivalCoordination', name: 'Coordinación venue AM — Stage 3', startsAt: bogota(2026, 9, 12, 7, 0), endsAt: bogota(2026, 9, 12, 19, 0), status: 'active', destination: 'simonBolivar', values: [
    { key: 'stageName', value: select('stage3') }, { key: 'billingParty', value: select('paramo') }, { key: 'serviceModality', value: select('disponibilidad12h') },
    { key: 'vehicleQuantity', value: number(1) }, { key: 'unitRate', value: number(490000) }, { key: 'callTime', value: time('07:00') },
    { key: 'supplierStatus', value: select('confirmado') }, { key: 'driverName', value: text('Mónica Salazar') }, { key: 'driverPhone', value: text('315 5550104') },
  ] },
  { seedKey: 'coord-venue-stage4', serviceKindKey: 'festivalCoordination', name: 'Coordinación venue PM — Stage 4', startsAt: bogota(2026, 9, 13, 14, 0), endsAt: bogota(2026, 9, 14, 2, 0), status: 'confirmed', destination: 'simonBolivar', values: [
    { key: 'stageName', value: select('stage4') }, { key: 'billingParty', value: select('paramo') }, { key: 'serviceModality', value: select('disponibilidad12h') },
    { key: 'vehicleQuantity', value: number(1) }, { key: 'unitRate', value: number(490000) }, { key: 'callTime', value: time('14:00') },
    { key: 'supplierStatus', value: select('confirmado') }, { key: 'driverName', value: text('Sergio Bernal') }, { key: 'driverPhone', value: text('316 5550105') },
  ] },
  { seedKey: 'marking', serviceKindKey: 'festivalCoordination', name: 'Marcación de vehículos', startsAt: bogota(2026, 9, 12, 8, 0), endsAt: bogota(2026, 9, 12, 10, 0), status: 'confirmed', destination: 'simonBolivar', values: [
    { key: 'stageName', value: select('general') }, { key: 'billingParty', value: select('paramo') }, { key: 'serviceModality', value: select('trayecto') },
    { key: 'vehicleQuantity', value: number(1) }, { key: 'unitRate', value: number(300000) },
    { key: 'notes', value: longText('Marcación plastificada, 2 piezas por vehículo el día del show.') },
    { key: 'supplierStatus', value: select('confirmado') }, { key: 'driverName', value: text('Paula Castaño') }, { key: 'driverPhone', value: text('320 5550106') },
  ] },
];

const services: readonly Service[] = [
  ...artistServices(), ...standaloneServices(), ...cargoServices(), ...coordinationServices,
  ...partnerServices(), ...internalServices(), ...crewServices(),
];

type RelationshipSeed = { source: string; target: string; type: 'follows' | 'relatedTo' };

const relationships: readonly RelationshipSeed[] = [
  ...artistChains.flatMap((artist) => [
    { source: `${artist.key}-arrival`, target: `${artist.key}-show`, type: 'follows' as const },
    { source: `${artist.key}-show`, target: `${artist.key}-departure`, type: 'follows' as const },
  ]),
  ...cargoRows.map((row) => ({ source: row.key, target: row.target, type: 'relatedTo' as const })),
];

const defaultProject = {
  name: 'Cordillera 2026',
  description: 'Festival Cordillera — Parque Simón Bolívar, Bogotá',
  startsAt: bogota(2026, 9, 9, 8, 0),
  endsAt: bogota(2026, 9, 14, 23, 59),
};

const advanceOrder: readonly ServiceStatus[] = ['planned', 'confirmed', 'active', 'completed'];

function transitionsTo(target: ServiceStatus): readonly ServiceStatus[] {
  if (target === 'draft') return [];
  // Cancelled rows first become real planned/confirmed work, leaving the same
  // intermediate audit trail as an operator cancellation after assignment.
  if (target === 'cancelled') return ['planned', 'confirmed', 'cancelled'];
  return advanceOrder.slice(0, advanceOrder.indexOf(target) + 1);
}

export const seedCordilleraOperations = internalMutation({
  args: { organizationSlug: v.string(), projectName: v.optional(v.string()) },
  returns: v.object({
    fieldDefinitions: v.number(), serviceKinds: v.number(), locations: v.number(),
    services: v.number(), relationships: v.number(), projectName: v.string(),
  }),
  handler: async (ctx, args) => {
    assertSeedingEnabled();

    const { organization, seeded } = await resolveSeedOwnerContext(ctx, args.organizationSlug);

    const allFieldIds = new Map<FieldKey, Id<'fieldDefinitions'>>();
    const builtinIds = await ensureBuiltinFieldDefinitions(ctx);
    for (const [key, id] of builtinIds) allFieldIds.set(key, id);
    // Reuse is by key AND by config: several of these keys (`driverName`,
    // `vehiclePlate`, `callTime`, `artist`) are ones a real tenant plausibly
    // already owns, and adopting one would be irreversible. Publishing a seed
    // serviceKind against a tenant's own field permanently freezes that definition's
    // key, semanticType and config (I2/I3), because a published version is never
    // hard-deleted. So the seed reuses only a field it would itself have
    // created, and otherwise refuses rather than quietly taking ownership.
    for (const field of fieldDefinitions) {
      const existing = await ctx.db.query('fieldDefinitions').withIndex('by_org_key', (q) => q.eq('organizationId', organization._id).eq('key', field.key)).unique();
      if (existing !== null && (existing.status !== 'active' || !sameFieldConfig(existing.config, field.config))) {
        return invalidInput('seedFieldConflict', `The organization already owns a different field definition keyed ${field.key}`);
      }
      const id = existing?._id ?? await createFieldDefinition(seeded, { organizationId: organization._id, key: field.key, label: field.label, config: field.config });
      allFieldIds.set(field.key, id);
    }

    function requireField(key: FieldKey): Id<'fieldDefinitions'> {
      const id = allFieldIds.get(key);
      if (id === undefined) return invalidInput('seedBuiltinFieldMissing', `Seed field is missing: ${key}`);
      return id;
    }

    const serviceKindIds = new Map<ServiceKindKey, Id<'serviceKinds'>>();
    for (const serviceKind of serviceKinds) {
      const existing = await ctx.db.query('serviceKinds').withIndex('by_org_key', (q) => q.eq('organizationId', organization._id).eq('key', serviceKind.key)).unique();
      if (existing !== null) {
        // Same reasoning as the fields above, with a heavier consequence: the
        // seed would otherwise attach 90 permanently undeletable Services to a
        // serviceKind version the tenant — not the seed — authored. Reuse requires
        // an active serviceKind whose published version composes exactly this
        // serviceKind's fields, in this order.
        const published = await ctx.db.query('serviceKindVersions').withIndex('by_serviceKind_status', (q) => q.eq('serviceKindId', existing._id).eq('status', 'published')).unique();
        if (existing.status !== 'active' || published === null) {
          return invalidInput('seedServiceKindConflict', `The organization already owns a different serviceKind keyed ${serviceKind.key}`);
        }
        const composed = await ctx.db.query('serviceKindFields').withIndex('by_version', (q) => q.eq('serviceKindVersionId', published._id)).collect();
        const actual = [...composed].sort((left, right) => left.position - right.position).map((field) => field.fieldDefinitionId);
        const expected = serviceKind.composition.map((entry) => requireField(entry.key));
        if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
          return invalidInput('seedServiceKindConflict', `The organization already owns a different serviceKind keyed ${serviceKind.key}`);
        }
        serviceKindIds.set(serviceKind.key, existing._id);
        continue;
      }
      const serviceKindId = await createServiceKind(seeded, { organizationId: organization._id, key: serviceKind.key, name: serviceKind.name, description: serviceKind.description });
      const versionId = await createInitialDraftVersion(seeded, serviceKindId);
      for (const [position, entry] of serviceKind.composition.entries()) {
        await addServiceKindField(seeded, { serviceKindVersionId: versionId, fieldDefinitionId: requireField(entry.key), required: entry.required, visible: true, position });
      }
      await publishServiceKindVersion(seeded, versionId);
      serviceKindIds.set(serviceKind.key, serviceKindId);
    }

    const projectName = args.projectName ?? defaultProject.name;
    const projects = await ctx.db.query('projects').withIndex('by_org', (q) => q.eq('organizationId', organization._id)).collect();
    const existingProject = projects.find((project) => project.name === projectName);
    const projectId = existingProject?._id ?? await createProject(seeded, {
      organizationId: organization._id, name: projectName, description: defaultProject.description,
      startsAt: defaultProject.startsAt, endsAt: defaultProject.endsAt,
    });
    const existingService = await ctx.db.query('services').withIndex('by_project', (q) => q.eq('projectId', projectId)).first();
    if (existingService !== null) {
      return { fieldDefinitions: fieldDefinitions.length, serviceKinds: serviceKinds.length, locations: locations.length, services: services.length, relationships: relationships.length, projectName };
    }

    // Locations carry no per-organization name uniqueness constraint, and are
    // archivable but never deletable — so a second run under a different
    // `projectName` (which skips the clean-slate guard above) would otherwise
    // leave a permanently duplicated catalogue behind. Reuse by name instead.
    const existingLocations = await ctx.db
      .query('locations')
      .withIndex('by_org', (q) => q.eq('organizationId', organization._id))
      .collect();
    const locationsByName = new Map(existingLocations.map((location) => [location.name, location]));
    const locationIds = new Map<LocationKey, Id<'locations'>>();
    for (const location of locations) {
      const existing = locationsByName.get(location.name);
      if (existing !== undefined && existing.status === 'active') {
        locationIds.set(location.key, existing._id);
        continue;
      }
      locationIds.set(location.key, await createLocation(seeded, {
        organizationId: organization._id, name: location.name, type: location.type, address: location.address,
        latitude: location.latitude, longitude: location.longitude,
      }));
    }
    function requireLocation(key: LocationKey): Id<'locations'> {
      const id = locationIds.get(key);
      if (id === undefined) return invalidInput('seedLocationMissing', `Seed location is missing: ${key}`);
      return id;
    }
    function requireServiceKind(key: ServiceKindKey): Id<'serviceKinds'> {
      const id = serviceKindIds.get(key);
      if (id === undefined) return invalidInput('seedServiceKindMissing', `Seed serviceKind is missing: ${key}`);
      return id;
    }

    const publishedVersions = new Map<ServiceKindKey, Id<'serviceKindVersions'>>();
    for (const serviceKind of serviceKinds) {
      const version = await ctx.db.query('serviceKindVersions').withIndex('by_serviceKind_status', (q) => q.eq('serviceKindId', requireServiceKind(serviceKind.key)).eq('status', 'published')).unique();
      if (version === null) return invalidInput('seedServiceKindVersionMissing', `Seed serviceKind has no published version: ${serviceKind.key}`);
      publishedVersions.set(serviceKind.key, version._id);
    }
    function requireVersion(key: ServiceKindKey): Id<'serviceKindVersions'> {
      const id = publishedVersions.get(key);
      if (id === undefined) return invalidInput('seedServiceKindVersionMissing', `Seed serviceKind has no published version: ${key}`);
      return id;
    }

    const serviceIds = new Map<string, Id<'services'>>();
    for (const service of services) {
      const values: { fieldDefinitionId: Id<'fieldDefinitions'>; value: Value }[] = [];
      if (service.pickup !== undefined) values.push({ fieldDefinitionId: requireField('pickupLocation'), value: { kind: 'location', locationId: requireLocation(service.pickup) } });
      values.push({ fieldDefinitionId: requireField('destination'), value: { kind: 'location', locationId: requireLocation(service.destination) } });
      for (const entry of service.values) values.push({ fieldDefinitionId: requireField(entry.key), value: entry.value });
      const serviceId = await createServiceFromServiceKind(seeded, {
        projectId, serviceKindVersionId: requireVersion(service.serviceKindKey), name: service.name, startsAt: service.startsAt,
        ...(service.endsAt === undefined ? {} : { endsAt: service.endsAt }), values,
      });
      serviceIds.set(service.seedKey, serviceId);
    }

    function requireService(key: string): Id<'services'> {
      const id = serviceIds.get(key);
      if (id === undefined) return invalidInput('seedServiceMissing', `Seed service is missing: ${key}`);
      return id;
    }
    for (const relationship of relationships) {
      await createRelationship(seeded, { sourceServiceId: requireService(relationship.source), targetServiceId: requireService(relationship.target), type: relationship.type });
    }
    for (const service of services) {
      const serviceId = requireService(service.seedKey);
      for (const status of transitionsTo(service.status)) await changeServiceStatus(seeded, { serviceId, status });
    }

    return { fieldDefinitions: fieldDefinitions.length, serviceKinds: serviceKinds.length, locations: locations.length, services: services.length, relationships: relationships.length, projectName };
  },
});
