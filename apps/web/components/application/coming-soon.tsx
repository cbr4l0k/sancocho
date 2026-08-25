'use client';

import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody } from '@/components/ui/panel';

/**
 * Placeholder for a nav destination whose surface has not been built yet. It
 * used to name the surface in a page title; the nav already does that, so what
 * is left is the same empty state for every one of them.
 */
export function ComingSoon() {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-6">
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
