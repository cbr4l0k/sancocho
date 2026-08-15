import type { FunctionArgs } from 'convex/server';

import { api } from '@sancocho/convex/api';

import { ProjectDetailSurface } from '@/components/projects/project-detail-surface';

export default function ProjectDetailPage({
  params,
}: {
  params: { id: FunctionArgs<typeof api.projects.queries.getProject>['projectId'] };
}) {
  return <ProjectDetailSurface projectId={params.id} />;
}
