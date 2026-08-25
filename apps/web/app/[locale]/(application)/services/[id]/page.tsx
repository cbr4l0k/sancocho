import type { FunctionArgs } from 'convex/server';

import { api } from '@priamo/convex/api';

import { ServiceDetailSurface } from '@/components/services/service-detail-surface';

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ id: FunctionArgs<typeof api.events.queries.getEvent>['eventId'] }>;
}) {
  const { id: eventId } = await params;
  return <ServiceDetailSurface eventId={eventId} />;
}
