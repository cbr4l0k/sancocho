import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The single line at the top of a screen: what you are looking at, and what you
 * can do to it.
 *
 * Deliberately title-only. Screens used to stack an uppercase eyebrow above the
 * title and a sentence of prose below it; the eyebrow restated the nav item that
 * got you here, the sentence restated the title, and together they pushed the
 * actual content down the page. Category belongs to the nav, explanation belongs
 * to empty states, and status belongs on a chip next to the name.
 *
 * `actions` sit on the same line, pinned right, so a screen's verbs are next to
 * its title instead of stranded at the bottom of the page under whatever
 * happened to render last.
 */
export function PageHeader({
  title,
  badge,
  actions,
  className,
}: {
  title: ReactNode;
  /** Status chip or similar, rendered inline after the title. */
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <header data-slot="page-header" className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
      <h1 className="text-display font-extrabold tracking-[-0.025em] text-ink">{title}</h1>
      {badge}
      {actions === undefined ? null : <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
