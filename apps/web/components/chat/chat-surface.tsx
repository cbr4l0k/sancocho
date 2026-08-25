'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Panel } from '@/components/ui/panel';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { createStubChatBackend, type ChatBackend } from '@/lib/chat-backend';

import { ChatComposer } from './chat-composer';
import { ChatInFlightIndicator } from './chat-in-flight-indicator';
import { ChatMessageItem } from './chat-message-item';
import { useChatConversation } from './use-chat-conversation';

/**
 * The chat surface (#32), reached from the nav at `/{locale}/chat`. `backend` is the
 * seam a later integration issue fills with a real model — every component
 * here, including this one, depends on the `ChatBackend` interface only, so
 * swapping the stub for a real implementation means passing a different
 * `backend` prop, not editing this file.
 *
 * The outer wrapper takes the viewport height minus the shell's fixed chrome
 * (`h-16` header plus `main`'s `py-8 pb-12`, i.e. 4rem + 2rem + 3rem = 9rem —
 * `components/application/app-shell.tsx`), so the panel and its composer stay
 * full-height without either magic-numbering the header's own line height.
 */
export function ChatSurface({ backend }: { backend?: ChatBackend }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const [stubBackend] = useState(() => createStubChatBackend());
  const activeBackend = backend ?? stubBackend;
  const { turns, pending, sendMessage } = useChatConversation(activeBackend, locale, t('chat.errorTurn'));

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[32rem] flex-col gap-6">
      <Panel emphasis="focal" className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          {turns.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState title={t('chat.emptyTitle')} description={t('chat.emptyBody')} />
            </div>
          ) : (
            <MessageScrollerProvider defaultScrollPosition="end">
              <MessageScroller className="h-full">
                <MessageScrollerViewport aria-label={t('chat.conversationLabel')}>
                  <MessageScrollerContent>
                    {turns.map((turn, index) => (
                      <MessageScrollerItem
                        key={turn.id}
                        messageId={turn.id}
                        scrollAnchor={!pending && index === turns.length - 1}
                      >
                        <ChatMessageItem turn={turn} />
                      </MessageScrollerItem>
                    ))}
                    {pending ? (
                      <MessageScrollerItem scrollAnchor>
                        <ChatInFlightIndicator />
                      </MessageScrollerItem>
                    ) : null}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
          )}
        </div>
        <ChatComposer onSubmit={(text) => void sendMessage(text)} disabled={pending} />
      </Panel>
    </div>
  );
}
