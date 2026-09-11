'use client';

import { usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { TableLoadMore } from '@/components/ui/table';
import { LocaleLink } from '@/i18n/locale-link';
import { AssignmentsSurface } from '@/components/portal/assignments-surface';
import { engagementDisplayNumber } from '@/lib/portal-engagement';

type Engagement = FunctionReturnType<typeof api.providers.queries.listMyProviderEngagements>['page'][number];

export function EngagementsSurface() {
  const { currentOrganization } = useCurrentOrganization();
  const t = useTranslations('portal');
  const engagements = usePaginatedQuery(
    api.providers.queries.listMyProviderEngagements,
    currentOrganization === null
      ? 'skip'
      : { providerOrganizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );

  if (currentOrganization === null) return null;

  /*
   * A chooser between things that cannot be named is not a useful landing page,
   * and one firm working one project for one coordinator is the ordinary case.
   * So the list appears only when there is something to choose BETWEEN: with a
   * single engagement the portal opens on the work itself, which is the first
   * screen carrying any real content.
   *
   * The list is not improvable by fetching more, either — the Project, the
   * coordinator Organization and the firm's own directory row are all refused
   * by design, and a count would be an aggregate, which may-not-see #10 forbids
   * outright. Anonymity here is the specification, not a gap to paper over.
   */
  if (engagements.status === 'Exhausted' && engagements.results.length === 1) {
    const only = engagements.results[0];
    if (only !== undefined) return <AssignmentsSurface projectId={only.projectId} showBackLink={false} />;
  }

  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>{t('engagementsTitle')}</PanelTitle>
          <PanelDescription>{t('engagementsDescription')}</PanelDescription>
        </div>
      </PanelHeader>
      {engagements.status === 'Exhausted' && engagements.results.length === 0 ? (
        <PanelBody>
          <EmptyState title={t('engagementsEmpty')} description={t('engagementsEmptyBody')} />
        </PanelBody>
      ) : (
        <div className="flex flex-col" aria-busy={engagements.status === 'LoadingFirstPage'}>
          {engagements.status === 'LoadingFirstPage' ? (
            <div className="flex flex-col gap-3 px-5 py-5 sm:px-6">
              {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-16 w-full" />)}
            </div>
          ) : (
            <ol className="divide-y divide-line border-t border-line">
              {engagements.results.map((engagement, index) => (
                <EngagementRow key={engagement._id} engagement={engagement} loadedIndex={index} />
              ))}
            </ol>
          )}
          <TableLoadMore
            loadedCount={engagements.results.length}
            status={engagements.status}
            onLoadMore={engagements.loadMore}
          />
        </div>
      )}
    </Panel>
  );
}

function EngagementRow({ engagement, loadedIndex }: { engagement: Engagement; loadedIndex: number }) {
  const t = useTranslations('portal');
  return (
    <li className="flex flex-wrap items-center gap-4 px-5 py-4 transition-colors duration-150 hover:bg-ground-2 sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span aria-hidden="true" className="size-2 rounded-full border border-line-strong" />
        <div>
          <p className="font-medium text-ink">{t('engagementLabel', { number: engagementDisplayNumber(loadedIndex) })}</p>
          <p className="text-xs text-ink-3">{t('engagementHint')}</p>
        </div>
      </div>
      <Button variant="secondary" size="sm" render={<LocaleLink to={`/portal/engagements/${engagement.projectId}`} />}>
        {t('openAssignments')}
      </Button>
    </li>
  );
}
