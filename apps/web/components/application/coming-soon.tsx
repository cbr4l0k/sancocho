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
    <div className="flex flex-col gap-8">
      <header className="flex max-w-2xl flex-col gap-2">
        <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
          {t('shell.comingSoonTitle')}
        </p>
        <h1 className="text-display font-extrabold tracking-[-0.025em] text-ink">
          {t(titleKeys[surface])}
        </h1>
        <p className="text-sm text-ink-2">{t('shell.comingSoonDescription')}</p>
      </header>
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
