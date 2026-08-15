'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Empty states, in exactly three flavours.
 *
 * - `empty`     — the collection has no records yet. Says so, and offers the
 *                 action that creates the first one.
 * - `filtered`  — records exist, the current filter matches none. Offers to
 *                 clear the filter, never to create anything.
 * - `unavailable` — the backend answered "not found or inaccessible" (I9). The
 *                 copy is deliberately incurious: it must read identically
 *                 whether the record was deleted, never existed, or belongs to
 *                 another tenant, in both languages. There is no "request
 *                 access" affordance, because offering one would confirm the
 *                 record exists.
 */
export type EmptyStateTone = 'empty' | 'filtered' | 'unavailable';

const glyph: Record<EmptyStateTone, string> = {
  empty: 'border-line-strong',
  filtered: 'border-line-strong',
  unavailable: 'border-tone-stop/40',
};

/**
 * Three marks, drawn rather than pulled from an icon set: a bare rule for
 * "nothing here", a lens for "nothing matched", and a barred circle for "not
 * available". No icon font, no dependency, and each reads at 12px.
 */
const glyphMark: Record<EmptyStateTone, ReactNode> = {
  empty: <span className="block h-px w-4 rounded-full bg-ink-3" />,
  filtered: (
    <span className="relative block size-3 rounded-full border border-ink-3 after:absolute after:-right-1 after:-bottom-1 after:h-[1.5px] after:w-2 after:rotate-45 after:rounded-full after:bg-ink-3" />
  ),
  unavailable: (
    <span className="relative block size-3 rounded-full border border-tone-stop before:absolute before:top-[-1px] before:left-1/2 before:h-[calc(100%+2px)] before:w-px before:-translate-x-1/2 before:rotate-45 before:bg-tone-stop" />
  ),
};

export type EmptyStateProps = {
  tone?: EmptyStateTone;
  title: ReactNode;
  description?: ReactNode;
  /** A single action at most: an empty state is not a menu. */
  action?: ReactNode;
  className?: string | undefined;
};

export function EmptyState({ tone = 'empty', title, description, action, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      data-tone={tone}
      className={cn('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}
    >
      <span aria-hidden="true" className={cn('flex size-9 items-center justify-center rounded-module border border-dashed', glyph[tone])}>
        {glyphMark[tone]}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        {description === undefined ? null : <p className="max-w-[46ch] text-xs text-ink-2">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * The one presentation for the backend's single generic failure. Screens render
 * this and stop asking questions.
 */
export function UnavailableState({ className }: { className?: string | undefined }) {
  const t = useTranslations();

  return <EmptyState tone="unavailable" title={t('empty.unavailable')} description={t('errors.notFound')} className={className} />;
}
