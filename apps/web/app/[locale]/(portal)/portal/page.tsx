import { EngagementsSurface } from '@/components/portal/engagements-surface';

export default async function PortalPage({ params }: { params: Promise<{ locale: string }> }) {
  await params;
  return <EngagementsSurface />;
}
