import type { FunctionArgs } from 'convex/server';

import { api } from '@priamo/convex/api';

import { RateCardDetailSurface } from '@/components/rateCards/rate-card-detail-surface';

export default async function RateCardDetailPage({
  params,
}: {
  params: Promise<{ id: FunctionArgs<typeof api.rateCards.queries.getRateCard>['rateCardId'] }>;
}) {
  const { id: rateCardId } = await params;
  return <RateCardDetailSurface rateCardId={rateCardId} />;
}
