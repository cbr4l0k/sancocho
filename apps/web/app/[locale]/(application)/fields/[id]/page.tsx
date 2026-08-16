import { redirect } from 'next/navigation';

export default async function FieldDetailPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/fields`);
}
