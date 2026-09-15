import { EventForm } from '@/components/events/event-form';

export default async function NewEventPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ projectId?: string }>;
}) {
  await params;
  const { projectId } = await searchParams;
  return <EventForm {...(projectId === undefined ? {} : { initialProjectId: projectId })} />;
}
