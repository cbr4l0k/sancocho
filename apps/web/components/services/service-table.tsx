'use client';

import { useMutation, usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useMemo, useState, type ComponentPropsWithoutRef } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ServiceCellEditor } from '@/components/services/service-cell-editor';
import { Button } from '@/components/ui/button';
import {
  createDataTableColumnHelper,
  DataTableContent,
  DataTableToolbar,
  selectionColumn,
  useDataTable,
  type DataTableColumn,
} from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelBodyFlush } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { TableLoadMore } from '@/components/ui/table';
import { formatDateTime } from '@/i18n/formats';
import { LocaleLink } from '@/i18n/locale-link';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { formatFieldValue } from '@/lib/field-value-format';
import {
  emptyFieldValueFormState,
  fromServiceFieldValue,
  toServiceFieldValue,
  type FieldValueFormState,
} from '@/lib/field-value-form';
import { projectWindowProblem } from '@/lib/project-window';
import { roleAtLeast, type Role } from '@/lib/roles';
import { serviceFieldColumns } from '@/lib/service-columns';
import { serviceFieldProblem } from '@/lib/service-form-checks';
import { changedServiceFieldValues } from '@/lib/service-value-diff';
import { serviceStatuses, type ServiceStatus } from '@/lib/status';
import { timestampFromParts, timestampToParts, type TimestampParts } from '@/lib/timestamps';

type ListArgs = FunctionArgs<typeof api.services.queries.listOrganizationServices>;
export type ServiceRow = FunctionReturnType<typeof api.services.queries.listOrganizationServices>['page'][number];
type ServiceField = ServiceRow['fields'][number];
type OrganizationId = ListArgs['organizationId'];
type ProjectId = NonNullable<ListArgs['projectId']>;
type ServiceId = ServiceRow['service']['_id'];
type FieldDefinitionId = ServiceField['fieldDefinitionId'];

/**
 * The in-place edit of one row.
 *
 * Editing lives in a context rather than in the column definitions' closures so
 * that a keystroke does not rebuild every column: the columns depend only on
 * which fields the loaded service kinds compose, and the cells subscribe to the draft
 * themselves.
 */
type RowDraft = {
  serviceId: ServiceId;
  name: string;
  start: TimestampParts;
  end: TimestampParts;
  values: Map<FieldDefinitionId, FieldValueFormState>;
};

type RowEditing = {
  draft: RowDraft | null;
  saving: boolean;
  /** The message a failed check or a rejected mutation left behind. */
  error: string | null;
  editableRow: (row: ServiceRow) => boolean;
  begin: (row: ServiceRow) => void;
  cancel: () => void;
  save: (row: ServiceRow) => void;
  setName: (name: string) => void;
  setStart: (start: TimestampParts) => void;
  setEnd: (end: TimestampParts) => void;
  setValue: (fieldDefinitionId: FieldDefinitionId, value: FieldValueFormState) => void;
};

const RowEditingContext = createContext<RowEditing | null>(null);

function useRowEditing(): RowEditing {
  const editing = useContext(RowEditingContext);
  if (editing === null) throw new Error('Service table cells must render inside the table.');
  return editing;
}

/** True while this row is the one being edited — cells switch on this. */
function isDrafting(editing: RowEditing, row: ServiceRow): boolean {
  return editing.draft !== null && editing.draft.serviceId === row.service._id;
}

/**
 * The Services table.
 *
 * One table serves both the organization-wide Services screen and a project's
 * own services block. It is column-configurable over the union of the fields
 * the loaded service kinds compose — an airport transfer's flight number and a
 * shuttle's route are both columns, and the organiser in the toolbar decides
 * which stay visible — and rows are editable in place, because opening a detail
 * screen to correct one time is the slowest possible way to fix a schedule.
 *
 * Project and status are SERVER-side filters: they narrow what is fetched, so
 * they mean "all matching services", unlike the toolbar's search, which can
 * only ever apply to loaded rows (I6 — there is no total count to page against).
 */
export function ServiceTable({
  organizationId,
  fixedProjectId,
  initialProjectId,
}: {
  organizationId: OrganizationId;
  /** Set on a project's own screen: the project filter is then not offered. */
  fixedProjectId?: ProjectId | undefined;
  /** Seeds the filter on the organization-wide screen; still changeable. */
  initialProjectId?: ProjectId | undefined;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const [projectId, setProjectId] = useState<ProjectId | ''>(fixedProjectId ?? initialProjectId ?? '');
  const [status, setStatus] = useState<ServiceStatus | ''>('');
  const scopedProjectId = fixedProjectId ?? (projectId === '' ? undefined : projectId);

  const rows = usePaginatedQuery(
    api.services.queries.listOrganizationServices,
    {
      organizationId,
      ...(scopedProjectId === undefined ? {} : { projectId: scopedProjectId }),
      ...(status === '' ? {} : { status }),
    },
    { initialNumItems: 25 },
  );
  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    fixedProjectId === undefined ? { organizationId } : 'skip',
    { initialNumItems: 100 },
  );

  const editing = useRowEditingState(currentOrganization?.role);
  const fieldColumns = useMemo(() => serviceFieldColumns(rows.results), [rows.results]);

  const columns = useMemo<DataTableColumn<ServiceRow>[]>(() => {
    const column = createDataTableColumnHelper<ServiceRow>();
    const missing = t('services.notSet');
    return [
      selectionColumn<ServiceRow>({ selectAll: t('dataTable.selectAll'), selectRow: t('dataTable.selectRow') }),
      column.accessor((row) => row.service.name, {
        id: 'name',
        header: t('services.name'),
        meta: { label: t('services.name') },
        sortFn: 'text',
        cell: (info) => <NameCell row={info.row.original} />,
      }),
      column.accessor((row) => row.projectName, {
        id: 'project',
        header: t('services.project'),
        meta: { label: t('services.project') },
        sortFn: 'text',
        cell: (info) => <span className="text-ink-2">{info.getValue()}</span>,
      }),
      column.accessor((row) => row.service.startsAt, {
        id: 'startsAt',
        header: t('services.startsAt'),
        meta: { label: t('services.startsAt') },
        sortFn: 'basic',
        cell: (info) => <StartsAtCell row={info.row.original} locale={locale} />,
      }),
      column.accessor((row) => row.service.endsAt, {
        id: 'endsAt',
        header: t('services.endsAt'),
        meta: { label: t('services.endsAt') },
        sortFn: 'basic',
        cell: (info) => <EndsAtCell row={info.row.original} locale={locale} missing={missing} />,
      }),
      column.accessor((row) => row.service.status, {
        id: 'status',
        header: t('services.status'),
        meta: { label: t('services.status') },
        sortFn: 'text',
        cell: (info) => <StatusChip kind="service" status={info.row.original.service.status} />,
      }),
      // One column per field any loaded service kind composes. The accessor returns
      // the SAME text the cell shows, so searching and sorting a service kind column
      // agree with it instead of operating on a value union.
      ...fieldColumns.map((fieldColumn) =>
        column.accessor((row) => fieldText(locale, row, fieldColumn.key, missing), {
          id: `field:${fieldColumn.key}`,
          header: fieldColumn.label,
          meta: { label: fieldColumn.label },
          sortFn: 'text',
          cell: (info) => <FieldCell row={info.row.original} fieldKey={fieldColumn.key} missing={missing} />,
        }),
      ),
      {
        id: 'actions',
        header: t('services.actions'),
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) => <ActionsCell row={row.original} />,
      },
    ] as DataTableColumn<ServiceRow>[];
  }, [fieldColumns, locale, t]);

  const table = useDataTable<ServiceRow>({
    data: rows.results,
    columns,
    getRowId: (row) => row.service._id,
    ...(fixedProjectId === undefined ? {} : { initialState: { columnVisibility: { project: false } } }),
  });

  const loading = rows.status === 'LoadingFirstPage';
  const filtered = scopedProjectId !== undefined || status !== '';

  return (
    <RowEditingContext.Provider value={editing}>
      <Panel>
        <PanelBodyFlush>
          <DataTableToolbar
            table={table}
            searchLabel={t('dataTable.search')}
            scopeNotice={
              fieldColumns.length === 0
                ? t('dataTable.loadedScope')
                : `${t('dataTable.loadedScope')} · ${t('services.serviceKindColumnsNotice')}`
            }
          >
            {fixedProjectId === undefined ? (
              <FilterSelect
                label={t('services.projectFilter')}
                value={projectId}
                onChange={(next) => {
                  editing.cancel();
                  setProjectId(projects.results.find((project) => project._id === next)?._id ?? '');
                }}
                placeholder={t('services.allProjects')}
                options={projects.results.map((project) => ({ value: project._id, label: project.name }))}
                onLoadMore={projects.status === 'CanLoadMore' ? () => projects.loadMore(100) : undefined}
                loadMoreLabel={t('services.loadMore')}
              />
            ) : null}
            <FilterSelect
              label={t('services.status')}
              value={status}
              onChange={(next) => {
                editing.cancel();
                setStatus(serviceStatuses.find((candidate): candidate is ServiceStatus => candidate === next) ?? '');
              }}
              placeholder={t('services.allStatuses')}
              options={serviceStatuses.map((candidate) => ({
                value: candidate,
                label: t(`services.statuses.${candidate}`),
              }))}
            />
          </DataTableToolbar>
          {editing.error === null ? null : (
            <p role="alert" className="border-b border-line px-5 py-3 text-sm text-tone-stop sm:px-6">
              {editing.error}
            </p>
          )}
          <DataTableContent
            table={table}
            loading={loading}
            empty={
              <div className="p-5">
                <EmptyState
                  tone={rows.results.length === 0 && !filtered ? 'empty' : 'filtered'}
                  title={rows.results.length === 0 && !filtered ? t('services.emptyOrgTitle') : t('empty.noMatches')}
                  description={
                    rows.results.length === 0 && !filtered ? t('services.emptyOrgBody') : t('empty.noMatchesBody')
                  }
                />
              </div>
            }
          />
          <TableLoadMore status={rows.status} loadedCount={rows.results.length} onLoadMore={rows.loadMore} />
        </PanelBodyFlush>
      </Panel>
    </RowEditingContext.Provider>
  );
}

/** The text a service kind column shows for one row — also its sort and search value. */
function fieldText(
  locale: ReturnType<typeof useCanonicalLocale>,
  row: ServiceRow,
  fieldKey: string,
  missing: string,
): string {
  const field = row.fields.find((candidate) => candidate.key === fieldKey);
  // A row whose service kind has no such field is blank, not "not set": the column
  // simply does not apply to it.
  if (field === undefined) return '';
  return field.value === undefined ? missing : formatFieldValue(locale, field.config, field.value, missing, field.locationName);
}

function NameCell({ row }: { row: ServiceRow }) {
  const editing = useRowEditing();
  if (isDrafting(editing, row) && editing.draft !== null)
    return (
      <CellInput
        aria-label={row.service.name}
        value={editing.draft.name}
        onChange={(value) => editing.setName(value)}
      />
    );
  return (
    <LocaleLink
      className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
      to={`/services/${row.service._id}`}
    >
      {row.service.name}
    </LocaleLink>
  );
}

function StartsAtCell({ row, locale }: { row: ServiceRow; locale: ReturnType<typeof useCanonicalLocale> }) {
  const t = useTranslations();
  const editing = useRowEditing();
  if (isDrafting(editing, row) && editing.draft !== null)
    return (
      <CellTimestamp row={row} label={t('services.startsAt')} value={editing.draft.start} onChange={editing.setStart} />
    );
  return <span className="font-mono text-xs tabular-nums text-ink">{formatDateTime(locale, row.service.startsAt)}</span>;
}

function EndsAtCell({
  row,
  locale,
  missing,
}: {
  row: ServiceRow;
  locale: ReturnType<typeof useCanonicalLocale>;
  missing: string;
}) {
  const t = useTranslations();
  const editing = useRowEditing();
  if (isDrafting(editing, row) && editing.draft !== null)
    return <CellTimestamp row={row} label={t('services.endsAt')} value={editing.draft.end} onChange={editing.setEnd} />;
  return (
    <span className="font-mono text-xs tabular-nums text-ink">
      {row.service.endsAt === undefined ? missing : formatDateTime(locale, row.service.endsAt)}
    </span>
  );
}

function FieldCell({ row, fieldKey, missing }: { row: ServiceRow; fieldKey: string; missing: string }) {
  const locale = useCanonicalLocale();
  const editing = useRowEditing();
  const field = row.fields.find((candidate) => candidate.key === fieldKey);
  if (field === undefined) return <span className="text-ink-3">—</span>;
  if (isDrafting(editing, row) && editing.draft !== null)
    return (
      <ServiceCellEditor
        field={field}
        organizationId={row.service.organizationId}
        value={editing.draft.values.get(field.fieldDefinitionId) ?? draftValueOf(field)}
        onChange={(next) => editing.setValue(field.fieldDefinitionId, next)}
      />
    );
  return (
    <span className="text-ink-2">
      {field.value === undefined
        ? missing
        : formatFieldValue(locale, field.config, field.value, missing, field.locationName)}
    </span>
  );
}

function ActionsCell({ row }: { row: ServiceRow }) {
  const t = useTranslations();
  const editing = useRowEditing();
  if (isDrafting(editing, row))
    return (
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" disabled={editing.saving} onClick={() => editing.save(row)}>
          {t('services.saveRow')}
        </Button>
        <Button size="sm" variant="ghost" disabled={editing.saving} onClick={editing.cancel}>
          {t('services.cancelRow')}
        </Button>
      </div>
    );
  // A row the backend would refuse is not offered an editor. This is an
  // affordance, never authorization (lib/roles.ts) — the mutation still decides.
  if (!editing.editableRow(row)) return <span className="text-xs text-ink-3">{t('services.rowReadOnly')}</span>;
  return (
    <Button size="sm" disabled={editing.draft !== null} onClick={() => editing.begin(row)}>
      {t('services.editRow')}
    </Button>
  );
}

function draftValueOf(field: ServiceField): FieldValueFormState {
  return field.value === undefined ? emptyFieldValueFormState(field.config.kind) : fromServiceFieldValue(field.value);
}

const cellControlClass =
  'h-8 w-full min-w-0 rounded-input border border-line bg-ground-2 px-2 text-sm text-ink ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

function CellInput({
  value,
  onChange,
  ...props
}: { value: string; onChange: (value: string) => void } & Omit<
  ComponentPropsWithoutRef<'input'>,
  'value' | 'onChange'
>) {
  return (
    <input {...props} className={cellControlClass} value={value} onChange={(event) => onChange(event.target.value)} />
  );
}

/**
 * A date+time pair in a cell, bounded by the owning project's window so the
 * picker offers the festival's days rather than the whole calendar.
 */
function CellTimestamp({
  row,
  label,
  value,
  onChange,
}: {
  row: ServiceRow;
  /** Names which of the two timestamps this is, for the two bare controls. */
  label: string;
  value: TimestampParts;
  onChange: (value: TimestampParts) => void;
}) {
  const bounds = {
    ...(row.projectStartsAt === undefined ? {} : { min: timestampToParts(row.projectStartsAt).date }),
    ...(row.projectEndsAt === undefined ? {} : { max: timestampToParts(row.projectEndsAt).date }),
  };
  return (
    <div className="flex min-w-[13rem] gap-1.5">
      <input
        type="date"
        aria-label={label}
        className={cellControlClass}
        {...bounds}
        value={value.date}
        onChange={(event) => onChange({ ...value, date: event.target.value })}
      />
      <input
        type="time"
        aria-label={label}
        className={`${cellControlClass} w-[6.5rem] shrink-0`}
        value={value.time}
        onChange={(event) => onChange({ ...value, time: event.target.value })}
      />
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  placeholder,
  options,
  onLoadMore,
  loadMoreLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
  onLoadMore?: (() => void) | undefined;
  loadMoreLabel?: string | undefined;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
      {label}
      <span className="flex items-center gap-1.5">
        <select
          className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal text-ink"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {/* The query behind this list is paginated, so a tenant past the first
         * page needs a way to reach the rest — a `<select>` cannot scroll-load. */}
        {onLoadMore === undefined ? null : (
          <Button type="button" variant="link" size="sm" onClick={onLoadMore}>
            {loadMoreLabel}
          </Button>
        )}
      </span>
    </label>
  );
}

/**
 * The edit-one-row state machine, including the checks that run before a write.
 *
 * Every check here mirrors a server rule rather than inventing one: the
 * date ordering and the project window are `services/model.ts`'s, and the per-field
 * rules are the service kind snapshot's. They exist so a mistake is named where it was
 * made instead of arriving as a rejected mutation.
 */
function useRowEditingState(role: Role | undefined): RowEditing {
  const t = useTranslations();
  const updateCore = useMutation(api.services.mutations.updateServiceCoreFields);
  const updateFields = useMutation(api.services.mutations.updateServiceFields);
  const [draft, setDraft] = useState<RowDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editableRow = useCallback(
    (row: ServiceRow) =>
      role !== undefined &&
      roleAtLeast(role, 'planner') &&
      row.projectStatus !== 'archived' &&
      row.service.status !== 'completed' &&
      row.service.status !== 'cancelled',
    [role],
  );

  const begin = useCallback((row: ServiceRow) => {
    setError(null);
    setDraft({
      serviceId: row.service._id,
      name: row.service.name,
      start: timestampToParts(row.service.startsAt),
      end: row.service.endsAt === undefined ? { date: '', time: '' } : timestampToParts(row.service.endsAt),
      values: new Map(),
    });
  }, []);

  const cancel = useCallback(() => {
    setDraft(null);
    setError(null);
  }, []);

  const setName = useCallback((name: string) => setDraft((old) => (old === null ? old : { ...old, name })), []);
  const setStart = useCallback(
    (start: TimestampParts) => setDraft((old) => (old === null ? old : { ...old, start })),
    [],
  );
  const setEnd = useCallback((end: TimestampParts) => setDraft((old) => (old === null ? old : { ...old, end })), []);
  const setValue = useCallback(
    (fieldDefinitionId: FieldDefinitionId, value: FieldValueFormState) =>
      setDraft((old) => (old === null ? old : { ...old, values: new Map(old.values).set(fieldDefinitionId, value) })),
    [],
  );

  const save = useCallback(
    (row: ServiceRow) => {
      void (async () => {
        if (draft === null || draft.serviceId !== row.service._id) return;
        const startsAt = timestampFromParts(draft.start);
        const endBlank = draft.end.date === '' && draft.end.time === '';
        const endsAt = endBlank ? undefined : timestampFromParts(draft.end);
        if (startsAt === undefined || (!endBlank && endsAt === undefined) || (endsAt !== undefined && endsAt < startsAt)) {
          setError(t('errors.serviceDatesInvalid'));
          return;
        }
        const outside = projectWindowProblem(
          { startsAt: row.projectStartsAt, endsAt: row.projectEndsAt },
          startsAt,
          endsAt,
        );
        if (outside !== undefined) {
          setError(t(outside === 'before' ? 'errors.serviceBeforeProjectWindow' : 'errors.serviceAfterProjectWindow'));
          return;
        }

        const original = new Map(
          row.fields.flatMap((field) => (field.value === undefined ? [] : [[field.fieldDefinitionId, field.value]])),
        );
        const edited = new Map(
          row.fields.map((field) => [
            field.fieldDefinitionId,
            toServiceFieldValue(draft.values.get(field.fieldDefinitionId) ?? draftValueOf(field)),
          ]),
        );
        for (const field of row.fields)
          if (
            serviceFieldProblem(field.config, edited.get(field.fieldDefinitionId), field.required, false) !== undefined
          ) {
            setError(t('services.fieldInvalid'));
            return;
          }

        setSaving(true);
        setError(null);
        try {
          const core = {
            serviceId: row.service._id,
            ...(draft.name === row.service.name ? {} : { name: draft.name }),
            ...(startsAt === row.service.startsAt ? {} : { startsAt }),
            ...(endsAt === row.service.endsAt ? {} : { endsAt: endsAt ?? null }),
          };
          if (Object.keys(core).length > 1) await updateCore(core);
          const changes = changedServiceFieldValues(original, edited);
          if (changes.length > 0) await updateFields({ serviceId: row.service._id, values: changes });
          setDraft(null);
        } catch (caught) {
          setError(t(errorMessageKey(presentConvexError(caught))));
        } finally {
          setSaving(false);
        }
      })();
    },
    [draft, t, updateCore, updateFields],
  );

  return { draft, saving, error, editableRow, begin, cancel, save, setName, setStart, setEnd, setValue };
}
