import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/lib/utils';

/**
 * The loading placeholder.
 *
 * Skeletons stand in for content whose *shape* we already know — a table body,
 * a metric, a row of chips. When the shape is unknown, show nothing rather than
 * a guess. The sweep is slow (1.8s) on purpose: this is a console people keep
 * open, and a fast shimmer reads as an alarm.
 *
 * Always mark the region that contains skeletons with `aria-busy`; the skeleton
 * itself is hidden from assistive technology.
 */
export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        'rounded-input bg-ground-2',
        'bg-[linear-gradient(90deg,transparent_0%,color-mix(in_oklab,var(--sc-ink)_10%,transparent)_50%,transparent_100%)]',
        '[background-size:200%_100%] animate-[sc-sweep_1.8s_linear_infinite]',
        className,
      )}
      {...props}
    />
  );
}

/** A stack of text-height bars, for paragraph- and list-shaped placeholders. */
export function SkeletonText({ lines = 3, className }: { lines?: number | undefined; className?: string | undefined }) {
  return (
    <div data-slot="skeleton-text" className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3.5', index === lines - 1 ? 'w-3/5' : 'w-full')} />
      ))}
    </div>
  );
}
