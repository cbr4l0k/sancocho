'use client';

import type { PaginationStatus } from 'convex/react';
import { useTranslations } from 'next-intl';
import type { ComponentPropsWithoutRef } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The table primitive, built for a cursor-paginated backend (I6).
 *
 * It never receives a full dataset and has no concept of "page 3 of 47": the
 * Convex queries behind it return a cursor and a page, and no total count
 * exists to number pages against. `TableLoadMore` therefore takes the exact
 * `status` union `usePaginatedQuery` returns, so a caller cannot invent a state
 * the hook does not produce.
 *
 * Horizontal overflow is contained here rather than on the page, so a wide
 * table scrolls inside its panel instead of moving the whole layout.
 */
export function Table({ className, ...props }: ComponentPropsWithoutRef<'table'>) {
  return (
    <div data-slot="table-scroll" className="min-w-0 overflow-x-auto">
      <table data-slot="table" className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
    </div>
  );
}

/**
 * Header cells wrap instead of truncating and sit on the sunken ground so the
 * header survives a sticky scroll. "Número de vuelo" over "Flight number" is a
 * two-line header, and that is fine.
 */
export function TableHead({ className, ...props }: ComponentPropsWithoutRef<'thead'>) {
  return <thead data-slot="table-head" className={cn('bg-ground-3', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentPropsWithoutRef<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentPropsWithoutRef<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('border-t border-line transition-colors duration-100 hover:bg-ground-2', className)}
      {...props}
    />
  );
}

/**
 * Two alignments only. Numeric and identifier columns go `end`, everything else
 * `start`; centred columns make a dense table impossible to scan down.
 *
 * The native, deprecated `align` attribute is omitted from the prop types so
 * this one wins the name outright rather than intersecting to `never`.
 */
type Align = 'start' | 'end';

const alignClass: Record<Align, string> = { start: 'text-left', end: 'text-right' };

export type TableHeaderCellProps = Omit<ComponentPropsWithoutRef<'th'>, 'align'> & { align?: Align | undefined };

export function TableHeaderCell({ className, align = 'start', ...props }: TableHeaderCellProps) {
  return (
    <th
      scope="col"
      data-slot="table-header-cell"
      className={cn('px-3 py-2 align-bottom text-micro uppercase text-ink-3', alignClass[align], className)}
      {...props}
    />
  );
}

export type TableCellProps = Omit<ComponentPropsWithoutRef<'td'>, 'align'> & {
  align?: Align | undefined;
  /** Identifiers, keys, timestamps and quantities. Mono, so columns line up. */
  mono?: boolean | undefined;
};

export function TableCell({ className, align = 'start', mono = false, ...props }: TableCellProps) {
  return (
    <td
      data-slot="table-cell"
      className={cn('px-3 py-2 align-top text-ink-2', alignClass[align], mono && 'font-mono text-xs text-ink', className)}
      {...props}
    />
  );
}

/** The first cell of a row: the thing the row is about. */
export function TableRowHeaderCell({ className, ...props }: ComponentPropsWithoutRef<'th'>) {
  return <th scope="row" data-slot="table-row-header-cell" className={cn('px-3 py-2 text-left align-top font-medium text-ink', className)} {...props} />;
}

/** First-page placeholder. Column count comes from the header, so it lines up. */
export function TableSkeletonRows({ rows = 5, columns }: { rows?: number | undefined; columns: number }) {
  return (
    <tbody data-slot="table-skeleton" aria-busy="true">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex} className="border-t border-line">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <td key={columnIndex} className="px-3 py-2.5">
              <Skeleton className={cn('h-3.5', columnIndex === 0 ? 'w-4/5' : 'w-2/3')} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export type TableLoadMoreProps = {
  status: PaginationStatus;
  /** Rows currently in hand. There is no total to compare it against. */
  loadedCount: number;
  /** Rows to request per click. */
  pageSize?: number | undefined;
  onLoadMore: (pageSize: number) => void;
  className?: string | undefined;
};

/**
 * Cursor pagination, surfaced as "load more".
 *
 * Numbered pages would need a total count and an offset, neither of which the
 * backend offers or should. Accumulating pages also keeps every loaded row
 * live: Convex re-pushes updates for pages already fetched, which a page-swap
 * control would throw away on every navigation.
 */
export function TableLoadMore({ status, loadedCount, pageSize = 25, onLoadMore, className }: TableLoadMoreProps) {
  const t = useTranslations('table');

  if (status === 'LoadingFirstPage') return null;

  return (
    <div
      data-slot="table-load-more"
      className={cn('mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line px-4 py-2.5', className)}
    >
      <p className="text-xs text-ink-3" aria-live="polite">
        {t('loaded', { count: loadedCount })}
      </p>
      {status === 'Exhausted' ? (
        <p className="text-micro uppercase text-ink-3">{t('endOfList')}</p>
      ) : (
        <Button variant="ghost" size="sm" disabled={status === 'LoadingMore'} onClick={() => onLoadMore(pageSize)}>
          {status === 'LoadingMore' ? t('loadingMore') : t('loadMore')}
        </Button>
      )}
    </div>
  );
}
