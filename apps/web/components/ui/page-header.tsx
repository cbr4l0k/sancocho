import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The single line at the top of a screen: what you can do to what you are
 * looking at.
 *
 * Deliberately chrome-free. Screens used to stack an uppercase eyebrow, a page
 * title, and a sentence of prose here; the eyebrow restated the nav item that
 * got you here, the title restated the eyebrow, the sentence restated the
 * title, and together they pushed the actual content down the page. Category
 * belongs to the nav, name belongs to the record itself, explanation belongs to
 * empty states, and status belongs on a chip.
 *
 * What is left is the verb line: `actions` pinned right, with an optional
 * `badge` leading, so a screen's actions sit at the top next to its content
 * instead of stranded at the bottom under whatever happened to render last. A
 * screen with neither should not render this at all.
 */
export function PageHeader({
  badge,
  actions,
  className,
}: {
  /** Status chip or similar, rendered at the start of the line. */
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <header data-slot="page-header" className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
      {badge}
      {actions === undefined ? null : <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
