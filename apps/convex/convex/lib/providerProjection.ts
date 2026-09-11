import { v } from 'convex/values';

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { getVersionFields } from '../serviceKinds/model';
import { locationNameOf } from '../services/model';
import { serviceFieldValueValidator, type SemanticType } from '../validators';
import { notFoundOrInaccessible } from './errors';

type ServiceFieldValue = typeof serviceFieldValueValidator.type;

const providerSemanticTypes = [
  'serviceName',
  'serviceDate',
  'serviceTime',
  'serviceLocation',
  'transport.origin',
  'transport.destination',
  'passenger.count',
  'aviation.flightNumber',
  'aviation.terminal',
  'contact.primary',
  'general.notes',
] as const satisfies readonly SemanticType[];

const excludedSemanticTypes = [
  'serviceDescription',
  'luggage.count',
  'accessibility.wheelchairCount',
] as const satisfies readonly SemanticType[];

type ClassifiedSemanticType =
  | (typeof providerSemanticTypes)[number]
  | (typeof excludedSemanticTypes)[number];

// Adding a registry member makes this assignment fail until it is explicitly
// placed in the projected or excluded list. Exclusion is therefore the default
// security decision, but never a silent one.
const semanticClassificationIsExhaustive: Exclude<
  SemanticType,
  ClassifiedSemanticType
> extends never ? true : never = true;
void semanticClassificationIsExhaustive;

const projectedSemantics: ReadonlySet<SemanticType> = new Set(providerSemanticTypes);

type ProjectedSemanticType = (typeof providerSemanticTypes)[number];

/**
 * The PUBLISHED contract, stated here rather than in `validators/index.ts` so
 * that this file remains the single owner of the closed list. Narrowing it to
 * the eleven (rather than reusing `semanticTypeValidator`) makes the runtime
 * `returns` check a second, independent enforcement point: if the membership
 * test in the loop below is ever weakened, an excluded semantic is rejected on
 * the way out instead of reaching a Provider.
 */
export const providerSemanticTypeValidator = v.union(
  v.literal('serviceName'),
  v.literal('serviceDate'),
  v.literal('serviceTime'),
  v.literal('serviceLocation'),
  v.literal('transport.origin'),
  v.literal('transport.destination'),
  v.literal('passenger.count'),
  v.literal('aviation.flightNumber'),
  v.literal('aviation.terminal'),
  v.literal('contact.primary'),
  v.literal('general.notes'),
);

// The validator and the array above must stay exactly the same set; the two
// exist separately only because one is a runtime value and the other a type.
type ValidatorMatchesList = typeof providerSemanticTypeValidator.type extends ProjectedSemanticType
  ? ProjectedSemanticType extends typeof providerSemanticTypeValidator.type
    ? true
    : never
  : never;
const _providerSemanticsInSync: ValidatorMatchesList = true;
void _providerSemanticsInSync;

export const providerServiceProjectionEntryValidator = v.object({
  semanticType: providerSemanticTypeValidator,
  label: v.string(),
  value: serviceFieldValueValidator,
  locationName: v.optional(v.string()),
});

type ProviderServiceProjectionEntry = {
  semanticType: ProjectedSemanticType;
  label: string;
  value: ServiceFieldValue;
  locationName?: string;
};

/**
 * A type guard rather than a bare `.has()` so the narrowing the check performs
 * at runtime is the same narrowing TypeScript applies: the pushed entry is
 * typed as one of the eleven, and cannot be widened back without a compile
 * error here.
 */
function isProjected(semanticType: SemanticType): semanticType is ProjectedSemanticType {
  return projectedSemantics.has(semanticType);
}

/**
 * Builds the complete, code-owned Provider view of one already-authorized
 * Service. Selection reads only the Field Definition's semantic discriminator;
 * labels are output text and visibility is intentionally irrelevant.
 *
 * CROSS-MODULE COUPLING — read with `historicalMeaningFields` in fields/model.ts.
 * Selection reads the LIVE `fieldDefinitions.semanticType`, not a copy frozen
 * into the Service Kind Version. That is safe only because `semanticType` is one
 * of the three columns that module refuses to change once a definition is
 * referenced by a published or retired version. If it were ever dropped from
 * that list, a coordinator could re-point an existing field at `general.notes`
 * and retroactively widen disclosure on every historical Service under every
 * version referencing it — precisely the "a tenant cannot widen disclosure by
 * misconfiguration" property docs/provider-access.md promises. `label` is live
 * BY DESIGN and is the deliberate exception: it is a display string with no
 * identity meaning, and a test pins that it follows a rename.
 */
export async function providerServiceProjection(
  ctx: QueryCtx,
  service: Doc<'services'>,
): Promise<ProviderServiceProjectionEntry[]> {
  const storedValues = await ctx.db
    .query('serviceFieldValues')
    .withIndex('by_service_field', (q) => q.eq('serviceId', service._id))
    .collect();
  const storedByDefinition = new Map(storedValues.map((value) => [value.fieldDefinitionId, value]));
  const locations = new Map<Id<'locations'>, Doc<'locations'> | null>();
  const projection: ProviderServiceProjectionEntry[] = [];

  for (const serviceKindField of await getVersionFields(ctx, service.serviceKindVersionId)) {
    const stored = storedByDefinition.get(serviceKindField.fieldDefinitionId);
    if (stored === undefined) continue;
    if (stored.serviceKindFieldId !== serviceKindField._id) return notFoundOrInaccessible();
    const definition = await ctx.db.get(serviceKindField.fieldDefinitionId);
    if (definition === null) return notFoundOrInaccessible();
    const semanticType = definition.semanticType;
    if (semanticType === undefined || !isProjected(semanticType)) continue;
    projection.push({
      semanticType,
      label: definition.label,
      value: stored.value,
      ...(await locationNameOf(ctx, locations, service.organizationId, stored.value)),
    });
  }
  return projection;
}
