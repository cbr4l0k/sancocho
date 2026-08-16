'use client';

import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody } from '@/components/ui/panel';

export type ComingSoonSurface =
  | 'chat'
  | 'recipes'
  | 'services'
  | 'projects'
  | 'locations'
  | 'fields'
  | 'statistics';

const titleKeys: Record<
  ComingSoonSurface,
  | 'nav.chat'
  | 'nav.recipes'
  | 'nav.services'
  | 'nav.projects'
  | 'nav.locations'
  | 'nav.fields'
  | 'nav.statistics'
> = {
  chat: 'nav.chat',
  recipes: 'nav.recipes',
  services: 'nav.services',
  projects: 'nav.projects',
  locations: 'nav.locations',
  fields: 'nav.fields',
  statistics: 'nav.statistics',
};

export function ComingSoon({ surface }: { surface: ComingSoonSurface }) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(titleKeys[surface])} />
      <Panel>
        <PanelBody>
          <EmptyState
            title={t('shell.comingSoonTitle')}
            description={t('shell.comingSoonBody')}
          />
        </PanelBody>
      </Panel>
    </div>
  );
}
