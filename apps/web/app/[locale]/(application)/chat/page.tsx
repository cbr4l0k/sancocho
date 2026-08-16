'use client';

import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody } from '@/components/ui/panel';

export default function ChatPage() {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t('chat.title')} />
      <Panel>
        <PanelBody>
          <EmptyState title={t('shell.comingSoonTitle')} description={t('shell.comingSoonBody')} />
        </PanelBody>
      </Panel>
    </div>
  );
}
