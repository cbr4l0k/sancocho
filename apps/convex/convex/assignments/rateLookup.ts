import { v } from 'convex/values';

import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { requireAuthenticatedUser, requirePrincipalForProject } from '../lib/access';
import { notFoundOrInaccessible } from '../lib/errors';
import { assertUsableProvider } from '../providers/model';
import { findRateForAssignment } from '../rateCards/model';
import { currencyValidator, rateModalityValidator } from '../validators';
import { assertUsableVehicleClass } from '../vehicles/classes';

type RateModality = typeof rateModalityValidator.type;

export const maxRateCardsPerRateLookup = 100;

const resolvedRateValidator = v.object({
  kind: v.literal('resolved'),
  rateCardId: v.id('rateCards'),
  rateCardName: v.string(),
  rateCardVersionId: v.id('rateCardVersions'),
  rateLineId: v.id('rateLines'),
  unitAmount: v.number(),
  currency: currencyValidator,
});

const ambiguousRateCandidateValidator = v.object({
  rateCardId: v.id('rateCards'),
  rateCardName: v.string(),
  rateCardVersionId: v.id('rateCardVersions'),
  unitAmount: v.number(),
  currency: currencyValidator,
});

export const assignmentRateLookupResultValidator = v.union(
  resolvedRateValidator,
  v.object({
    kind: v.literal('ambiguous'),
    candidates: v.array(ambiguousRateCandidateValidator),
  }),
  v.object({
    kind: v.literal('unpriceable'),
    reason: v.union(v.literal('noRateLine'), v.literal('rateCardLimitExceeded')),
  }),
);

type AssignmentRateLookupResult = typeof assignmentRateLookupResultValidator.type;

/**
 * Prices one prospective Assignment cell without exposing the Rate Card
 * catalogue. Missing pricing is a repairable configuration gap for a planner,
 * not a permission event, so pricing outcomes are returned as a closed union;
 * making absence exceptional would blur an expected outcome with an access
 * refusal. Authorization and invalid references still leave through the usual
 * generic error boundary.
 *
 * There is intentionally no second provider-arm check here:
 * `readAssignmentPricing` is not a Provider Capability, so the centralized
 * Project principal gate refuses Provider principals for this intent. Inlining
 * that policy would create a second principal resolver in violation of I1.
 *
 * This query is a planner-floor rate read, which every other public rate door
 * is not — see the `ProjectIntent` comment in `lib/access.ts` and the row in
 * `docs/authorization.md`. Because Providers and Vehicle Classes both list at
 * viewer floor and the modality union is closed, a planner issuing one call per
 * combination can reconstruct the organization's active published grid. That
 * consequence is accepted and recorded rather than mitigated: a planner already
 * learns each cell by assigning it, and refusing the read would only mean
 * pricing the Assignment blind.
 */
export async function resolveAssignmentRate(
  ctx: QueryCtx,
  args: {
    serviceId: Id<'services'>;
    providerId: Id<'providers'>;
    vehicleClassId: Id<'vehicleClasses'>;
    modality: RateModality;
  },
): Promise<AssignmentRateLookupResult> {
  await requireAuthenticatedUser(ctx);
  const service = await ctx.db.get(args.serviceId);
  if (service === null) return notFoundOrInaccessible();
  await requirePrincipalForProject(ctx, service.projectId, 'readAssignmentPricing');
  const project = await ctx.db.get(service.projectId);
  if (project === null || project.organizationId !== service.organizationId) {
    return notFoundOrInaccessible();
  }
  await assertUsableProvider(ctx, args.providerId, service.organizationId);
  await assertUsableVehicleClass(ctx, args.vehicleClassId, service.organizationId);

  const rateCards = await ctx.db
    .query('rateCards')
    .withIndex('by_org_provider', (q) =>
      q.eq('organizationId', service.organizationId).eq('providerId', args.providerId),
    )
    .take(maxRateCardsPerRateLookup + 1);
  if (rateCards.length > maxRateCardsPerRateLookup) {
    // A partial read cannot prove the cell is unambiguous. Returning a resolved
    // candidate here could let an unread card silently be the real price.
    return { kind: 'unpriceable', reason: 'rateCardLimitExceeded' };
  }

  const candidates: Array<{
    rateCardId: Id<'rateCards'>;
    rateCardName: string;
    rateCardVersionId: Id<'rateCardVersions'>;
    rateLineId: Id<'rateLines'>;
    unitAmount: number;
    currency: typeof currencyValidator.type;
  }> = [];
  for (const rateCard of rateCards) {
    if (rateCard.status !== 'active' || rateCard.currentPublishedVersionId === undefined) continue;
    const found = await findRateForAssignment(ctx, {
      rateCardVersionId: rateCard.currentPublishedVersionId,
      providerId: args.providerId,
      vehicleClassId: args.vehicleClassId,
      modality: args.modality,
    });
    if (found !== null) {
      candidates.push({
        rateCardId: rateCard._id,
        rateCardName: rateCard.name,
        rateCardVersionId: rateCard.currentPublishedVersionId,
        ...found,
      });
    }
  }

  const [first, ...rest] = candidates;
  // `first` is absent only when nothing matched. Deriving the empty case from
  // the destructure rather than testing `length` twice means the compiler's
  // index check and the domain's "no published Card prices this" answer are the
  // same branch — an earlier version satisfied the compiler with a second,
  // unreachable `noRateLine` return, which would have reported a priced cell as
  // unpriced had it ever been reached.
  if (first === undefined) return { kind: 'unpriceable', reason: 'noRateLine' };
  if (rest.length === 0) return { kind: 'resolved', ...first };
  return {
    kind: 'ambiguous',
    candidates: candidates.map(({ rateLineId: _rateLineId, ...candidate }) => candidate),
  };
}
