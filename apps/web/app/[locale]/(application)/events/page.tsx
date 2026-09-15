import { EventsSurface } from '@/components/events/events-surface';

export default async function EventsPage({ params }: { params: Promise<{ locale: string }> }) {
  await params;
  return <EventsSurface />;
}
