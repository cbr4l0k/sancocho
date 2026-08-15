import type { FunctionArgs } from 'convex/server';

import { api } from '@sancocho/convex/api';

import { LocationDetailSurface } from '@/components/locations/locations-surface';

export default function LocationDetailPage({
  params,
}: {
  params: { id: FunctionArgs<typeof api.locations.queries.getLocation>['locationId'] };
}) {
  return <LocationDetailSurface locationId={params.id} />;
}
