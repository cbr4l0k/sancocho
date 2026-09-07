import { ServiceKindDetailSurface } from '@/components/serviceKinds/service-kind-detail-surface';
import type { FunctionArgs } from 'convex/server';

import { api } from '@priamo/convex/api';

export default async function ServiceKindDetailPage({
  params,
}: {
  params: Promise<{ id: FunctionArgs<typeof api.serviceKinds.queries.getServiceKind>['serviceKindId'] }>;
}) {
  const { id: serviceKindId } = await params;
  return <ServiceKindDetailSurface serviceKindId={serviceKindId} />;
}
