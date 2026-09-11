import type { FunctionReturnType } from 'convex/server';

import { api } from '@priamo/convex/api';

import { AssignmentsSurface } from '@/components/portal/assignments-surface';

type Engagement = FunctionReturnType<typeof api.providers.queries.listMyProviderEngagements>['page'][number];

/**
 * Keyed on the PROJECT, not the grant.
 *
 * An engagement is the (Project, Provider) pair, and `listProjectAssignments`
 * already resolves the Provider arm from the caller. Keying the URL on the grant
 * id meant a deep link had to find that grant by scanning the engagement list —
 * which paged the whole list client-side on every visit, defeating exactly the
 * pagination it was reading. The Project id is something the Provider already
 * holds from its own engagement row, so it costs no disclosure and no lookup.
 */
export default async function EngagementPage({
  params,
}: {
  params: Promise<{ locale: string; projectId: Engagement['projectId'] }>;
}) {
  const { projectId } = await params;
  return <AssignmentsSurface projectId={projectId} />;
}
