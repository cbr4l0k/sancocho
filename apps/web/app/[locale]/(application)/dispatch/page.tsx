import { DispatchBoard } from '@/components/dispatch/dispatch-board';

export default async function DispatchPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ day?: string | string[] | undefined }>;
}) {
  await params;
  const { day } = await searchParams;
  return <DispatchBoard initialDayKey={typeof day === 'string' ? day : undefined} />;
}
