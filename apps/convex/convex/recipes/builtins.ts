import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import type { BuiltinFieldKey } from '../fields/builtins';
import { conflict } from '../lib/errors';
import { addRecipeField } from './fields/model';
import { createInitialDraftVersion, createRecipe, publishRecipeVersion } from './model';

type StarterRecipe = {
  key: string;
  name: string;
  description: string;
  composition: readonly { key: BuiltinFieldKey; required: boolean }[];
};

/**
 * Position is each composition array's index. Catalogue declaration order is
 * intentionally irrelevant: these required flags and positions freeze when the
 * initial version publishes (I2), so each recipe owns its explicit contract.
 */
export const starterRecipes = [
  {
    key: 'airportArrivalTransfer', name: 'Airport Arrival Transfer', description: 'Collect arriving passengers and transfer them to their destination.',
    composition: [
      { key: 'pickupLocation', required: true }, { key: 'destination', required: true }, { key: 'passengerCount', required: true }, { key: 'flightNumber', required: true }, { key: 'terminal', required: false }, { key: 'luggageCount', required: false }, { key: 'wheelchairCount', required: false }, { key: 'contactPerson', required: false }, { key: 'notes', required: false },
    ],
  },
  {
    key: 'airportDepartureTransfer', name: 'Airport Departure Transfer', description: 'Transfer departing passengers from pickup to their airport terminal.',
    composition: [
      { key: 'pickupLocation', required: true }, { key: 'destination', required: true }, { key: 'passengerCount', required: true }, { key: 'flightNumber', required: true }, { key: 'terminal', required: false }, { key: 'luggageCount', required: false }, { key: 'wheelchairCount', required: false }, { key: 'contactPerson', required: false }, { key: 'notes', required: false },
    ],
  },
  {
    key: 'pointToPointTransfer', name: 'Point to Point Transfer', description: 'Move passengers directly between a pickup and destination.',
    composition: [
      { key: 'pickupLocation', required: true }, { key: 'destination', required: true }, { key: 'passengerCount', required: true }, { key: 'luggageCount', required: false }, { key: 'wheelchairCount', required: false }, { key: 'contactPerson', required: false }, { key: 'notes', required: false },
    ],
  },
  {
    key: 'shuttleService', name: 'Shuttle Service', description: 'Run a shared shuttle service between its pickup and destination.',
    composition: [
      { key: 'pickupLocation', required: true }, { key: 'destination', required: true }, { key: 'passengerCount', required: true }, { key: 'notes', required: false },
    ],
  },
] as const satisfies readonly StarterRecipe[];

function requireBuiltinFieldId(
  fieldIds: ReadonlyMap<BuiltinFieldKey, Id<'fieldDefinitions'>>,
  key: BuiltinFieldKey,
): Id<'fieldDefinitions'> {
  const fieldId = fieldIds.get(key);
  // The catalogue and every blueprint are compile-time linked; reaching this
  // branch means deployment state was externally corrupted, never user input.
  if (fieldId === undefined) return conflict();
  return fieldId;
}

/** Creates each initial immutable recipe version only when its key is absent. */
export async function provisionStarterRecipes(
  ctx: MutationCtx,
  organizationId: Id<'organizations'>,
  fieldIds: ReadonlyMap<BuiltinFieldKey, Id<'fieldDefinitions'>>,
): Promise<void> {
  for (const starter of starterRecipes) {
    const existing = await ctx.db
      .query('eventRecipes')
      .withIndex('by_org_key', (q) => q.eq('organizationId', organizationId).eq('key', starter.key))
      .unique();
    if (existing !== null) continue;
    const recipeId = await createRecipe(ctx, { organizationId, key: starter.key, name: starter.name, description: starter.description });
    const recipeVersionId = await createInitialDraftVersion(ctx, recipeId);
    for (const [position, entry] of starter.composition.entries()) {
      await addRecipeField(ctx, { recipeVersionId, fieldDefinitionId: requireBuiltinFieldId(fieldIds, entry.key), required: entry.required, visible: true, position });
    }
    await publishRecipeVersion(ctx, recipeVersionId);
  }
}
