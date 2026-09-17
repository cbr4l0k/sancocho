import type { FunctionArgs } from 'convex/server';

import { api } from '@priamo/convex/api';

import { WorkbookImportSurface } from '@/components/import/workbook-import-surface';

export default async function WorkbookImportPage({ params }: {
  params: Promise<{ id: FunctionArgs<typeof api.events.queries.getEventDetail>['eventId'] }>;
}) {
  const { id: eventId } = await params;
  return <WorkbookImportSurface eventId={eventId} />;
}
