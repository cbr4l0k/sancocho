'use client';

import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/ui/empty-state';
import {
  Panel,
  PanelBody,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/ui/panel';

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
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>{t(titleKeys[surface])}</PanelTitle>
          <PanelDescription>{t('shell.comingSoonDescription')}</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody>
        <EmptyState
          title={t('shell.comingSoonTitle')}
          description={t('shell.comingSoonBody')}
        />
      </PanelBody>
    </Panel>
  );
}
