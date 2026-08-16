import type { FunctionArgs } from 'convex/server';

import { api } from '@sancocho/convex/api';

import { LocationDetailSurface } from '@/components/locations/locations-surface';

export default async function LocationDetailPage({
  params,
}: {
  params: Promise<{ id: FunctionArgs<typeof api.locations.queries.getLocation>['locationId'] }>;
}) {
  const { id: locationId } = await params;
  return <LocationDetailSurface locationId={locationId} />;
}
