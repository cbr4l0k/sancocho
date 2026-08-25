import { StatisticsSurface } from '@/components/statistics/statistics-surface';

export default async function StatisticsPage({ params }: { params: Promise<{ locale: string }> }) {
  await params;
  return <StatisticsSurface />;
}
