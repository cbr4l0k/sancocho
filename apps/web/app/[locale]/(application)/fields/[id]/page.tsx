import { redirect } from 'next/navigation';

export default function FieldDetailPage({ params }: { params: { locale: string } }) {
  redirect(`/${params.locale}/fields`);
}
