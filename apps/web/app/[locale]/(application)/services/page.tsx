import { ServiceListSurface } from '@/components/services/service-list-surface';

export default async function ServicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ projectId?: string }>;
}) {
  await params;
  const { projectId } = await searchParams;
  return <ServiceListSurface {...(projectId === undefined ? {} : { initialProjectId: projectId })} />;
}
