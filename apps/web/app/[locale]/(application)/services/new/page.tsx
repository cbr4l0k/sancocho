import { ServiceCreateSurface } from '@/components/services/service-create-surface';

export default async function NewServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ projectId?: string }>;
}) {
  const [{ locale }, { projectId }] = await Promise.all([params, searchParams]);
  return (
    <ServiceCreateSurface
      locale={locale}
      {...(projectId === undefined ? {} : { initialProjectId: projectId })}
    />
  );
}
