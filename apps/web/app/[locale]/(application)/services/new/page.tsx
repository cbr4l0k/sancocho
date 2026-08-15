import { ServiceCreateSurface } from '@/components/services/service-create-surface';

export default function NewServicePage({
  params,
  searchParams,
}: {
  params: { locale: string };
  searchParams: { projectId?: string };
}) {
  return (
    <ServiceCreateSurface
      locale={params.locale}
      {...(searchParams.projectId === undefined ? {} : { initialProjectId: searchParams.projectId })}
    />
  );
}
