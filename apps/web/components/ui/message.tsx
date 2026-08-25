import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Vendored from shadcn/ui (`@shadcn/message`) and re-skinned onto Priamo's
 * tokens. Purely presentational — no state, no dependency beyond `cn` — so it
 * composes into any conversation surface. `align="end"` is the operator's own
 * turns; `align="start"` is everything the other party said.
 */

function MessageGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="message-group" className={cn('flex min-w-0 flex-col gap-2', className)} {...props} />;
}

function Message({
  className,
  align = 'start',
  ...props
}: React.ComponentProps<'div'> & { align?: 'start' | 'end' }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn('group/message relative flex w-full min-w-0 gap-2 data-[align=end]:flex-row-reverse', className)}
      {...props}
    />
  );
}

function MessageAvatar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-avatar"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-ground-2 text-micro font-semibold text-ink-2',
        className,
      )}
      {...props}
    />
  );
}

function MessageContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        'flex w-full min-w-0 max-w-[36rem] flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:items-end',
        className,
      )}
      {...props}
    />
  );
}

function MessageHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-header"
      className={cn('flex max-w-full min-w-0 items-center gap-2 px-1 text-xs font-medium text-ink-3', className)}
      {...props}
    />
  );
}

function MessageFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        'flex max-w-full min-w-0 items-center px-1 font-mono text-xs text-ink-3 group-data-[align=end]/message:justify-end',
        className,
      )}
      {...props}
    />
  );
}

export { MessageGroup, Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader };
