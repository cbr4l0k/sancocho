import type { FunctionArgs } from 'convex/server';

import { api } from '@priamo/convex/api';

import { EventDetailSurface } from '@/components/events/event-detail-surface';

export default async function EventDetailPage({ params }: {
  params: Promise<{ id: FunctionArgs<typeof api.events.queries.getEventDetail>['eventId'] }>;
}) {
  const { id: eventId } = await params;
  return <EventDetailSurface eventId={eventId} />;
}
