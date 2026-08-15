import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The card surface every module in the bento sits on.
 *
 * Two emphases, not five. `focal` is the one panel a screen is *about*: larger
 * radius and a slightly stronger border. `module`
 * is everything else. A screen with two focal panels has no focus.
 */
const panelVariants = cva(
  cn('relative flex min-w-0 flex-col overflow-hidden border border-line', 'shadow-[var(--sc-shadow-panel)]'),
  {
    variants: {
      emphasis: {
        focal: 'rounded-panel border-line-strong bg-ground-1',
        module: 'rounded-panel bg-ground-1',
        /** Nested inside another panel: no shadow, no competing radius. */
        inset: 'rounded-input border-line/80 bg-ground-2 shadow-none',
      },
    },
    defaultVariants: { emphasis: 'module' },
  },
);

export type PanelProps = ComponentPropsWithoutRef<'section'> & VariantProps<typeof panelVariants>;

export function Panel({ className, emphasis, ...props }: PanelProps) {
  return <section data-slot="panel" className={cn(panelVariants({ emphasis }), className)} {...props} />;
}

export function PanelHeader({ className, ...props }: ComponentPropsWithoutRef<'header'>) {
  return (
    <header
      data-slot="panel-header"
      className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5 sm:px-6 sm:pt-6', className)}
      {...props}
    />
  );
}

/**
 * The eyebrow carries the section's category. It is the only place uppercase
 * tracking is allowed outside chips and table headers, and it wraps rather than
 * truncates — "Vocabulario de estados" needs the room.
 */
export function PanelEyebrow({ className, ...props }: ComponentPropsWithoutRef<'p'>) {
  return (
    <p
      data-slot="panel-eyebrow"
      className={cn('text-micro font-semibold uppercase tracking-[0.09em] text-ink-3', className)}
      {...props}
    />
  );
}

export function PanelTitle({ className, ...props }: ComponentPropsWithoutRef<'h2'>) {
  return (
    <h2 data-slot="panel-title" className={cn('text-lg font-bold tracking-[-0.01em] text-ink', className)} {...props} />
  );
}

export function PanelDescription({ className, ...props }: ComponentPropsWithoutRef<'p'>) {
  return <p data-slot="panel-description" className={cn('max-w-prose text-sm text-ink-2', className)} {...props} />;
}

export function PanelActions({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="panel-actions" className={cn('flex flex-wrap items-center gap-2', className)} {...props} />;
}

export function PanelBody({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="panel-body"
      className={cn('flex min-w-0 flex-1 flex-col gap-4 px-5 py-5 sm:px-6 sm:py-6', className)}
      {...props}
    />
  );
}

/** Body variant for panels whose content is a table: the table owns its edges. */
export function PanelBodyFlush({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="panel-body" className={cn('flex min-w-0 flex-1 flex-col', className)} {...props} />;
}

export function PanelFooter({ className, ...props }: ComponentPropsWithoutRef<'footer'>) {
  return (
    <footer
      data-slot="panel-footer"
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-ground-2/60 px-4 py-2.5 text-xs text-ink-3 sm:px-5',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The one number a focal panel exists to show. Mono and oversized so it reads
 * from across a dispatch room; the label above it stays small and quiet.
 */
export function PanelMetric({
  label,
  value,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div data-slot="panel-metric" className={cn('flex flex-col gap-1', className)}>
      <span className="text-micro uppercase text-ink-3">{label}</span>
      <span className="font-mono text-3xl font-medium text-ink">{value}</span>
    </div>
  );
}
