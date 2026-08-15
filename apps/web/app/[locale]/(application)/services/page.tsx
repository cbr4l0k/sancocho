import { ServiceListSurface } from '@/components/services/service-list-surface';

export default function ServicesPage({
  params,
  searchParams,
}: {
  params: { locale: string };
  searchParams: { projectId?: string };
}) {
  return (
    <ServiceListSurface
      locale={params.locale}
      {...(searchParams.projectId === undefined ? {} : { initialProjectId: searchParams.projectId })}
    />
  );
}
