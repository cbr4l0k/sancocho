'use client';

import { usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { datetimeDateBounds, fieldInputBounds } from '@/lib/field-input-bounds';
import type { FieldValueFormState } from '@/lib/field-value-form';
import { cn } from '@/lib/utils';

type ServiceField = FunctionReturnType<typeof api.services.queries.listOrganizationServices>['page'][number]['fields'][number];
type OrganizationId = FunctionArgs<typeof api.locations.queries.listLocations>['organizationId'];
type LocationId = Extract<NonNullable<ServiceField['value']>, { kind: 'location' }>['locationId'];

/**
 * The control a service kind field renders as inside a table cell.
 *
 * It is a separate, deliberately plainer set from `service-fields.tsx`: the
 * form controls there carry their own label, required marker and help text
 * because a form is read top to bottom, whereas a cell already sits under a
 * column header and has one line of room. The rules behind them are the same
 * ones — `fieldInputBounds` puts the service kind snapshot's range on the control,
 * and `serviceFieldProblem` checks the result before the row is saved.
 *
 * `longText` is edited on a single line here on purpose: a cell is not the
 * place to write three paragraphs, and the detail screen still offers the
 * textarea.
 */
const controlClass =
  'h-8 w-full min-w-0 rounded-input border border-line bg-ground-2 px-2 text-sm text-ink ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export function ServiceCellEditor({
  field,
  value,
  onChange,
  organizationId,
}: {
  field: ServiceField;
  value: FieldValueFormState;
  onChange: (value: FieldValueFormState) => void;
  organizationId: OrganizationId;
}) {
  const t = useTranslations();
  const bounds = fieldInputBounds(field.config);

  if (field.config.kind === 'boolean' && value.kind === 'boolean')
    return (
      <input
        type="checkbox"
        aria-label={field.label}
        className="size-4 accent-[var(--sc-accent)]"
        checked={value.value}
        onChange={(event) => onChange({ kind: 'boolean', value: event.target.checked })}
      />
    );

  if (field.config.kind === 'select' && value.kind === 'select')
    return (
      <select
        aria-label={field.label}
        className={controlClass}
        value={value.optionId}
        onChange={(event) => onChange({ kind: 'select', optionId: event.target.value })}
      >
        <option value="">{t('services.selectPlaceholder')}</option>
        {field.config.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );

  if (field.config.kind === 'multiSelect' && value.kind === 'multiSelect')
    return (
      // A native multiple-select is the only control that fits a cell and still
      // expresses "several of these". Ctrl-click is awkward; the detail screen's
      // checkbox list remains the comfortable way to do it.
      <select
        multiple
        size={3}
        aria-label={field.label}
        className={cn(controlClass, 'h-auto py-1')}
        value={value.optionIds}
        onChange={(event) =>
          onChange({
            kind: 'multiSelect',
            optionIds: [...event.target.selectedOptions].map((option) => option.value),
          })
        }
      >
        {field.config.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );

  if (field.config.kind === 'location' && value.kind === 'location')
    return (
      <LocationCellSelect
        label={field.label}
        organizationId={organizationId}
        value={value.locationId}
        currentName={field.locationName}
        onChange={(locationId) => onChange({ kind: 'location', locationId })}
      />
    );

  if (field.config.kind === 'datetime' && value.kind === 'datetime') {
    const dateBounds = datetimeDateBounds(field.config);
    return (
      <div className="flex min-w-[13rem] gap-1.5">
        <input
          type="date"
          aria-label={field.label}
          className={controlClass}
          {...dateBounds}
          value={value.date}
          onChange={(event) => onChange({ kind: 'datetime', date: event.target.value, time: value.time })}
        />
        <input
          type="time"
          aria-label={field.label}
          className={cn(controlClass, 'w-[6.5rem] shrink-0')}
          value={value.time}
          onChange={(event) => onChange({ kind: 'datetime', date: value.date, time: event.target.value })}
        />
      </div>
    );
  }

  if (
    (field.config.kind === 'text' ||
      field.config.kind === 'longText' ||
      field.config.kind === 'number' ||
      field.config.kind === 'date' ||
      field.config.kind === 'time') &&
    value.kind === field.config.kind
  )
    return (
      <input
        aria-label={field.label}
        className={controlClass}
        type={
          field.config.kind === 'number'
            ? 'number'
            : field.config.kind === 'date'
              ? 'date'
              : field.config.kind === 'time'
                ? 'time'
                : 'text'
        }
        {...bounds}
        value={value.value}
        onChange={(event) => onChange({ kind: value.kind, value: event.target.value })}
      />
    );

  // The form state and the snapshot disagree on kind — corruption, not a case
  // to guess at. `service-fields.tsx` bails the same way.
  return null;
}

/**
 * A one-line location chooser.
 *
 * The full `LocationPicker` is a search box, a type filter and a list — right
 * for a form, far too tall for a cell. This loads the same active locations and
 * offers them flat, and always includes the location the row already points at
 * (named from the row's own join) so a value beyond the first page is never
 * silently blanked by opening the editor.
 */
function LocationCellSelect({
  label,
  organizationId,
  value,
  currentName,
  onChange,
}: {
  label: string;
  organizationId: OrganizationId;
  value: LocationId | undefined;
  currentName: string | undefined;
  onChange: (locationId: LocationId) => void;
}) {
  const t = useTranslations();
  const locations = usePaginatedQuery(
    api.locations.queries.listLocations,
    { organizationId, status: 'active' },
    { initialNumItems: 100 },
  );
  const loaded = locations.results.map((location) => ({ id: location._id, name: location.name }));
  const options =
    value !== undefined && !loaded.some((option) => option.id === value)
      ? [{ id: value, name: currentName ?? t('common.notAvailable') }, ...loaded]
      : loaded;

  return (
    <select
      aria-label={label}
      className={controlClass}
      value={value ?? ''}
      onChange={(event) => {
        const chosen = options.find((option) => option.id === event.target.value);
        if (chosen !== undefined) onChange(chosen.id);
      }}
    >
      <option value="">{t('services.selectPlaceholder')}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}
