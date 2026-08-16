import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { createBuiltinFieldDefinition } from './model';
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
 * fields/model.ts `assertKeyAvailable`), and once a version is published
 * `isReferencedByPublishedVersion` freezes each key, semanticType and config
 * for good (I2/I3). A typo shipped once can never be corrected in place — so
 * this array must be read against the issue's table, not adjusted casually.
 *
 * DECLARATION ORDER IS NOT COMPOSITION ORDER: starter recipes state their own
 * field order and required flags in recipes/builtins.ts.
 */
export const builtinFields = [
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

export type BuiltinFieldKey = (typeof builtinFields)[number]['key'];

/**
 * Product bootstrap deliberately does not assert `SANCOCHO_ENABLE_SEED`: every
 * deployment needs this catalogue before its first organization can operate.
 * The guard remains on the two doors that create arbitrary built-ins
 * (`fields/mutations.ts:createBuiltinFieldDefinition`) and demonstration tenant
 * data (`seed/mutations.ts`), whose irreversible effects are administrator
 * choices rather than a product guarantee.
 */
export async function ensureBuiltinFieldDefinitions(
  ctx: MutationCtx,
): Promise<ReadonlyMap<BuiltinFieldKey, Id<'fieldDefinitions'>>> {
  const ids = new Map<BuiltinFieldKey, Id<'fieldDefinitions'>>();
  for (const field of builtinFields) {
    const existing = await ctx.db
      .query('fieldDefinitions')
      .withIndex('by_org_key', (q) => q.eq('organizationId', undefined).eq('key', field.key))
      .unique();
    ids.set(field.key, existing === null ? await createBuiltinFieldDefinition(ctx, field) : existing._id);
  }
  return ids;
}
