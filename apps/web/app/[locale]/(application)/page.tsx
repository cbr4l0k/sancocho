'use client';

import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBody } from '@/components/ui/panel';

export default function ChatPage() {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex max-w-2xl flex-col gap-2">
        <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
          {t('chat.eyebrow')}
        </p>
        <h1 className="text-display font-extrabold tracking-[-0.025em] text-ink">
          {t('chat.title')}
        </h1>
        <p className="text-sm text-ink-2">{t('chat.description')}</p>
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
