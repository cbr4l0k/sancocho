import type { FunctionArgs } from 'convex/server';

import { api } from '@priamo/convex/api';

import { ServiceDetailSurface } from '@/components/services/service-detail-surface';

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ id: FunctionArgs<typeof api.services.queries.getService>['serviceId'] }>;
}) {
  const { id: serviceId } = await params;
  return <ServiceDetailSurface serviceId={serviceId} />;
}
