import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/lib/utils';

/**
 * The bento grid.
 *
 * Twelve columns from `md` up, one column below it. Twelve divides by 2, 3, 4
 * and 6, which is what keeps a mixed row of large and small modules aligned
 * without bespoke widths. Items never set their own margins; the grid owns all
 * gutters, so alignment cannot drift.
 */
export function Bento({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="bento"
      className={cn('grid grid-cols-1 gap-3 md:grid-cols-12 lg:gap-4', className)}
      {...props}
    />
  );
}

/** Column spans. Written out because Tailwind only sees literal class names. */
const columnSpan = {
  2: 'md:col-span-2',
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  5: 'md:col-span-5',
  6: 'md:col-span-6',
  7: 'md:col-span-7',
  8: 'md:col-span-8',
  9: 'md:col-span-9',
  10: 'md:col-span-10',
  12: 'md:col-span-12',
} as const;

/** Row spans. Capped at three: a taller module belongs on its own row. */
const rowSpan = {
  1: '',
  2: 'md:row-span-2',
  3: 'md:row-span-3',
} as const;

export type BentoSpan = keyof typeof columnSpan;
export type BentoRows = keyof typeof rowSpan;

export type BentoItemProps = ComponentPropsWithoutRef<'div'> & {
  /** Columns out of twelve, from `md` up. Full width below that. */
  span: BentoSpan;
  /** Grid rows to occupy. Defaults to one. */
  rows?: BentoRows;
};

export function BentoItem({ className, span, rows = 1, ...props }: BentoItemProps) {
  return <div data-slot="bento-item" className={cn('flex min-w-0 flex-col', columnSpan[span], rowSpan[rows], className)} {...props} />;
}
