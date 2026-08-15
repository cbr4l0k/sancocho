import type { FunctionArgs } from 'convex/server';

import { api } from '@sancocho/convex/api';

import { ServiceDetailSurface } from '@/components/services/service-detail-surface';

export default function ServiceDetailPage({
  params,
}: {
  params: { id: FunctionArgs<typeof api.events.queries.getEvent>['eventId'] };
}) {
  return <ServiceDetailSurface eventId={params.id} />;
}
