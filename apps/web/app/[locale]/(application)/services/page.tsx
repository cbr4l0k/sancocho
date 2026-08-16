import { ServiceListSurface } from '@/components/services/service-list-surface';

export default async function ServicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ projectId?: string }>;
}) {
  const [{ locale }, { projectId }] = await Promise.all([params, searchParams]);
  return (
    <ServiceListSurface
      locale={locale}
      {...(projectId === undefined ? {} : { initialProjectId: projectId })}
    />
  );
}
