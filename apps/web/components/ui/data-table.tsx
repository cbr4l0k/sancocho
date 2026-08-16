'use client';

import {
  columnFilteringFeature,
  columnOrderingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type TableState,
} from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { dropInOrder, moveInOrder } from '@/lib/column-order';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSkeletonRows,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The sortable, filterable, selectable table.
 *
 * This is shadcn's data-table recipe: TanStack Table drives the behaviour and
 * the markup is ours. It is built that way rather than installed because
 * shadcn's copy paints itself with `--background`/`--foreground`, and this app
 * has its own palette (`--sc-*`) and its own `Table` primitives — the same
 * reason `button.tsx` is vendored and re-skinned rather than pulled in whole.
 *
 * **Sorting and filtering apply to loaded rows only.** The Convex queries behind
 * these tables are cursor-paginated with no total count (I6), so the table can
 * only order and filter the pages fetched so far. Screens say so out loud rather
 * than implying the whole tenant was searched; "load more" widens the window.
 */
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
  columnOrderingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  /**
   * The column's translated name. A column's `header` may be arbitrary markup,
   * so the organiser cannot reuse it as a label; this is a plain string it can
   * put next to a checkbox. Phantom value — only the type is used.
   */
  columnMeta: {} as { label?: string },
});

export type DataTableFeatures = typeof dataTableFeatures;

export type DataTableColumn<TData extends RowData> = ColumnDef<DataTableFeatures, TData, unknown>;

/** Column definitions are authored through this so cell values keep their types. */
export function createDataTableColumnHelper<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}

export type DataTable<TData extends RowData> = ReturnType<typeof useDataTable<TData>>;

export function useDataTable<TData extends RowData>({
  data,
  columns,
  getRowId,
  initialState,
}: {
  data: TData[];
  columns: ColumnDef<DataTableFeatures, TData, unknown>[];
  /**
   * Row identity. Convex re-pushes every loaded page on any change, so rows are
   * new objects on each update; without a stable id the selection would clear
   * itself whenever the backend pushed.
   */
  getRowId?: ((row: TData) => string) | undefined;
  initialState?: Partial<TableState<DataTableFeatures>> | undefined;
}) {
  return useTable({
    features: dataTableFeatures,
    data,
    columns,
    enableRowSelection: true,
    globalFilterFn: 'includesString',
    ...(getRowId === undefined ? {} : { getRowId }),
    ...(initialState === undefined ? {} : { initialState }),
  });
}

/**
 * Current left-to-right order. Read from the table rather than from
 * `state.columnOrder`, which is empty until the first reorder — the columns are
 * in definition order at that point, and that is the order a move applies to.
 */
function columnOrder<TData extends RowData>(table: DataTable<TData>): string[] {
  return table.getAllLeafColumns().map((column) => column.id);
}

function moveColumn<TData extends RowData>(table: DataTable<TData>, columnId: string, offset: number): void {
  table.setColumnOrder(moveInOrder(columnOrder(table), columnId, offset));
}

function dropColumn<TData extends RowData>(table: DataTable<TData>, draggedId: string, targetId: string): void {
  table.setColumnOrder(dropInOrder(columnOrder(table), draggedId, targetId));
}

/**
 * Search box, a slot for screen-specific filters, and the column organiser.
 *
 * The organiser is an inline disclosure rather than a floating menu: it holds a
 * checkbox and two move buttons per column, which is a lot of interactive
 * surface to trap inside a popover, and reordering is much easier to follow when
 * the table stays visible underneath.
 */
export function DataTableToolbar<TData extends RowData>({
  table,
  searchLabel,
  scopeNotice,
  children,
}: {
  table: DataTable<TData>;
  searchLabel: string;
  /** States that only loaded rows are searched. Required: see the file comment. */
  scopeNotice: string;
  children?: ReactNode;
}) {
  const t = useTranslations('dataTable');
  const [organising, setOrganising] = useState(false);
  const panelId = useId();
  const searchId = useId();
  const globalFilter = table.state.globalFilter ?? '';
  const selectedCount = Object.keys(table.state.rowSelection ?? {}).length;

  return (
    <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label
            htmlFor={searchId}
            className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-2"
          >
            {searchLabel}
          </label>
          <input
            id={searchId}
            type="search"
            value={typeof globalFilter === 'string' ? globalFilter : ''}
            onChange={(event) => table.setGlobalFilter(event.target.value)}
            className={cn(
              'h-[38px] w-full min-w-0 max-w-sm rounded-input border border-line bg-ground-2 px-3 text-sm text-ink',
              'placeholder:text-ink-3 transition-colors duration-150 hover:border-line-strong',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            )}
          />
        </div>
        {children}
        <Button
          type="button"
          size="sm"
          selected={organising}
          aria-expanded={organising}
          aria-controls={panelId}
          onClick={() => setOrganising((open) => !open)}
        >
          {t('columns')}
        </Button>
      </div>
      <p className="text-xs text-ink-3">
        {selectedCount > 0 ? `${t('selected', { count: selectedCount })} · ${scopeNotice}` : scopeNotice}
      </p>
      {organising ? <ColumnOrganiser id={panelId} table={table} /> : null}
    </div>
  );
}

function ColumnOrganiser<TData extends RowData>({ id, table }: { id: string; table: DataTable<TData> }) {
  const t = useTranslations('dataTable');
  const columns = table.getAllLeafColumns().filter((column) => column.columnDef.enableHiding !== false);

  return (
    <div id={id} className="flex flex-col gap-1 rounded-input border border-line bg-ground-2 p-2">
      <p className="px-1 pb-1 text-xs text-ink-3">{t('organiseHint')}</p>
      {columns.map((column, index) => (
        <div key={column.id} className="flex items-center gap-2 rounded-input px-1 py-1 hover:bg-ground-3">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="size-4 accent-[var(--sc-accent)]"
              checked={column.getIsVisible()}
              onChange={column.getToggleVisibilityHandler()}
            />
            <span className="truncate">{columnLabel(column.id, column.columnDef.meta?.label)}</span>
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={index === 0}
            aria-label={t('moveEarlier')}
            onClick={() => moveColumn(table, column.id, -1)}
          >
            ↑
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={index === columns.length - 1}
            aria-label={t('moveLater')}
            onClick={() => moveColumn(table, column.id, 1)}
          >
            ↓
          </Button>
        </div>
      ))}
    </div>
  );
}

/** `meta.label` carries the translated name; the id is a last resort. */
function columnLabel(id: string, label: string | undefined): string {
  return label ?? id;
}

export function DataTableContent<TData extends RowData>({
  table,
  loading = false,
  empty,
}: {
  table: DataTable<TData>;
  loading?: boolean;
  /** Rendered in place of the body when no row survives the current filter. */
  empty?: ReactNode;
}) {
  const t = useTranslations('dataTable');
  const dragged = useRef<string | null>(null);
  const rows = table.getRowModel().rows;
  const leafColumns = table.getAllLeafColumns().filter((column) => column.getIsVisible());

  return (
    <>
      <Table>
        <TableHead>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const column = header.column;
                const sorted = column.getIsSorted();
                const canSort = column.getCanSort();
                const canOrder = column.columnDef.enableHiding !== false;
                return (
                  <TableHeaderCell
                    key={header.id}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    draggable={canOrder}
                    onDragStart={() => {
                      dragged.current = column.id;
                    }}
                    onDragOver={(event) => {
                      if (dragged.current !== null) event.preventDefault();
                    }}
                    onDrop={() => {
                      if (dragged.current !== null) dropColumn(table, dragged.current, column.id);
                      dragged.current = null;
                    }}
                    onDragEnd={() => {
                      dragged.current = null;
                    }}
                    className={cn(canOrder && 'cursor-grab active:cursor-grabbing')}
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={column.getToggleSortingHandler()}
                        className={cn(
                          'inline-flex items-center gap-1 uppercase tracking-[0.09em]',
                          'rounded-input focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                          sorted === false ? 'text-ink-3 hover:text-ink-2' : 'text-ink',
                        )}
                      >
                        <table.FlexRender header={header} />
                        <span aria-hidden="true" className="text-[0.7em]">
                          {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}
                        </span>
                        <span className="sr-only">
                          {sorted === 'asc' ? t('sortedAscending') : sorted === 'desc' ? t('sortedDescending') : t('sortBy')}
                        </span>
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHeaderCell>
                );
              })}
            </TableRow>
          ))}
        </TableHead>
        {loading ? (
          <TableSkeletonRows columns={leafColumns.length} />
        ) : (
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} data-selected={row.getIsSelected() ? '' : undefined} className={cn(row.getIsSelected() && 'bg-ground-2')}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        )}
      </Table>
      {!loading && rows.length === 0 ? empty : null}
    </>
  );
}

/**
 * The leading checkbox column. Declared here so every table selects rows the
 * same way, including the header's indeterminate state, which a plain
 * `checked` prop cannot express.
 */
export function selectionColumn<TData extends RowData>(labels: {
  selectAll: string;
  selectRow: string;
}): ColumnDef<DataTableFeatures, TData, unknown> {
  return {
    id: 'select',
    enableSorting: false,
    enableHiding: false,
    header: ({ table }) => (
      <SelectAllCheckbox
        checked={table.getIsAllRowsSelected()}
        indeterminate={table.getIsSomeRowsSelected()}
        onChange={table.getToggleAllRowsSelectedHandler()}
        label={labels.selectAll}
      />
    ),
    cell: ({ row }) => (
      <input
        type="checkbox"
        className="size-4 accent-[var(--sc-accent)]"
        aria-label={labels.selectRow}
        checked={row.getIsSelected()}
        onChange={row.getToggleSelectedHandler()}
      />
    ),
  };
}

function SelectAllCheckbox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: (event: unknown) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      className="size-4 accent-[var(--sc-accent)]"
      aria-label={label}
      checked={checked}
      ref={(node) => {
        if (node !== null) node.indeterminate = !checked && indeterminate;
      }}
      onChange={onChange}
    />
  );
}
