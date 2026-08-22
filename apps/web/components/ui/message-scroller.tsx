'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from '@shadcn/react/message-scroller';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Vendored from shadcn/ui (`@shadcn/message-scroller`) and re-skinned onto
 * Sancocho's tokens. The stick-to-bottom scroll behaviour — including the
 * "jump to latest" button that only appears once the viewer has scrolled away
 * from the live edge — comes from `@shadcn/react`; every visual decision below
 * is ours. This is what lets the chat surface's streaming-style incremental
 * rendering (#32) grow a message in place without fighting the scroll
 * position, so a later real streaming transport needs no re-layout here.
 *
 * Two fixes from the registry source: `@/registry/base-nova/lib/utils` became
 * `@/lib/utils`, and the registry's own `IconPlaceholder` (an internal helper
 * of the shadcn.com app, not a real export) is replaced with a hand-drawn
 * arrow — the design system installs no icon library (`docs/web-design.md`
 * §2), so status shapes and the handful of marks like this one are drawn in
 * CSS/SVG instead.
 */

function MessageScrollerProvider(props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>) {
  return <MessageScrollerPrimitive.Provider {...props} />;
}

function MessageScroller({ className, ...props }: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn('group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden', className)}
      {...props}
    />
  );
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn('size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain', className)}
      {...props}
    />
  );
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn('flex h-max min-h-full flex-col gap-4 px-5 py-5 sm:px-6', className)}
      {...props}
    />
  );
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn('min-w-0 shrink-0', className)}
      {...props}
    />
  );
}

function MessageScrollerButton({
  direction = 'end',
  className,
  children,
  render,
  variant = 'secondary',
  size = 'icon',
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  const t = useTranslations('common');

  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      direction={direction}
      className={cn(
        'absolute inset-x-1/2 -translate-x-1/2 transition-[translate,opacity] duration-150',
        'data-[active=false]:pointer-events-none data-[active=false]:opacity-0',
        'data-[direction=end]:bottom-3 data-[direction=end]:data-[active=false]:translate-y-2',
        'data-[direction=start]:top-3 data-[direction=start]:data-[active=false]:-translate-y-2',
        'data-[direction=start]:[&_svg]:rotate-180',
        className,
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <svg aria-hidden="true" className="size-3" viewBox="0 0 12 12">
            <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="sr-only">{direction === 'end' ? t('scrollToLatest') : t('scrollToEarliest')}</span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  );
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
};
