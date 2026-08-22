'use client';

import { useTranslations } from 'next-intl';

import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message';
import { formatClockTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import type { ChatDisplayTurn } from '@/lib/chat-conversation';
import { cn } from '@/lib/utils';

import { ChatProposalPreview } from './chat-proposal-preview';

/** One turn in the transcript: user or assistant, complete or errored. */
export function ChatMessageItem({ turn }: { turn: ChatDisplayTurn }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const align = turn.role === 'user' ? 'end' : 'start';
  const isError = turn.status === 'error';
  const visibleText = turn.text.slice(0, turn.revealedLength);

  return (
    <Message align={align}>
      <MessageAvatar aria-hidden="true">{turn.role === 'user' ? t('chat.youLabel').slice(0, 1) : 'S'}</MessageAvatar>
      <MessageContent>
        <MessageHeader>{turn.role === 'user' ? t('chat.youLabel') : t('chat.assistantLabel')}</MessageHeader>
        <div
          className={cn(
            'w-fit max-w-full rounded-input px-3.5 py-2.5 text-sm whitespace-pre-wrap',
            turn.role === 'user' ? 'bg-accent text-accent-ink' : 'bg-ground-2 text-ink',
            isError && 'border border-tone-stop/45 bg-transparent text-tone-stop',
          )}
        >
          {visibleText}
        </div>
        {turn.proposals?.map((proposal) => <ChatProposalPreview key={proposal.id} proposal={proposal} />)}
        <MessageFooter aria-label={t('chat.timestampLabel', { time: formatClockTime(locale, turn.createdAt) })}>
          {formatClockTime(locale, turn.createdAt)}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}
