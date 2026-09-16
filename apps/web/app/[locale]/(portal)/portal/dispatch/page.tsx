import { ProviderDispatchBoard } from '@/components/dispatch/provider-dispatch-board';

export default async function ProviderDispatchPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ day?: string | string[] | undefined }>;
}) {
  await params;
  const { day } = await searchParams;
  return <ProviderDispatchBoard initialDayKey={typeof day === 'string' ? day : undefined} />;
}
