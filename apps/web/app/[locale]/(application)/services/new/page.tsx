import { ServiceCreateSurface } from '@/components/services/service-create-surface';

export default async function NewServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ projectId?: string }>;
}) {
  await params;
  const { projectId } = await searchParams;
  return <ServiceCreateSurface {...(projectId === undefined ? {} : { initialProjectId: projectId })} />;
}
