import { DraftServiceKindEditorSurface } from '@/components/serviceKinds/draft-service-kind-editor-surface';
import type { FunctionArgs } from 'convex/server';

import { api } from '@priamo/convex/api';

export default async function DraftServiceKindPage({
  params,
}: {
  params: Promise<{ id: FunctionArgs<typeof api.serviceKinds.queries.getServiceKind>['serviceKindId'] }>;
}) {
  const { id: serviceKindId } = await params;
  return <DraftServiceKindEditorSurface serviceKindId={serviceKindId} />;
}
