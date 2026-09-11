import type { FunctionReturnType } from 'convex/server';

import { api } from '@priamo/convex/api';

import { AssignmentDetailSurface } from '@/components/portal/assignment-detail-surface';

type AssignmentDetail = FunctionReturnType<typeof api.assignments.queries.getAssignmentDetail>;

export default async function AssignmentPage({
  params,
}: {
  params: Promise<{ locale: string; assignmentId: AssignmentDetail['assignment']['_id'] }>;
}) {
  const { assignmentId } = await params;
  return <AssignmentDetailSurface assignmentId={assignmentId} />;
}
