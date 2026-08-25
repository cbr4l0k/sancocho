import type { FunctionArgs } from 'convex/server';

import { api } from '@priamo/convex/api';

import { ProjectDetailSurface } from '@/components/projects/project-detail-surface';

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: FunctionArgs<typeof api.projects.queries.getProject>['projectId'] }>;
}) {
  const { id: projectId } = await params;
  return <ProjectDetailSurface projectId={projectId} />;
}
