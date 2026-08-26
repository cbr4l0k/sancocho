'use client';

import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { LocationPicker } from '@/components/locations/location-picker';
import { Field, FieldControl, FieldLabel, FieldSpanFull } from '@/components/ui/field';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { datetimeDateBounds, fieldInputBounds } from '@/lib/field-input-bounds';
import type { FieldValueFormState } from '@/lib/field-value-form';
import type { ProjectWindow } from '@/lib/project-window';
import type { TimestampParts } from '@/lib/timestamps';
import { cn } from '@/lib/utils';

type RecipeField = FunctionReturnType<typeof api.recipes.fields.queries.listRecipeFields>[number];
type OrganizationId = FunctionArgs<typeof api.locations.queries.listLocations>['organizationId'];

/**
 * The controls a Recipe Version's fields render as.
 *
 * These used to be bare `<label><input/></label>` pairs declared inside the
 * create screen: unstyled, unlabelled to assistive tech beyond the wrapping
 * label, and inconsistent with every other form in the app. They live here now
 * because the create screen and the detail screen render the same field set and
 * must not drift, and they go through `Field`/`FieldControl` so the label
 * placement, required marker, focus ring and invalid state are the primitive's
 * job rather than each screen's.
 */

/** Base UI styles `Field.Control`; multi-line and native selects need their own height. */
const controlClass = 'text-sm normal-case tracking-normal';

/**
 * `min`/`max` for the date half of a datetime pair.
 *
 * The picker is bounded to the days a value may fall on — for a service, the
 * days its project spans — so an out-of-range date takes deliberate effort
 * rather than being the default a blank calendar offers. Day granularity cannot
 * express the hours at each edge of the window; the submit-time check
 * (`projectWindowProblem`) and the server (`validateEventWithinProjectWindow`)
 * are what actually decide.
 */
export type DateBounds = { min?: string | undefined; max?: string | undefined };

export function ServiceDateTime({
  label,
  value,
  onChange,
  required = false,
  bounds,
}: {
  label: string;
  value: TimestampParts;
  onChange: (value: TimestampParts) => void;
  required?: boolean;
  bounds?: DateBounds | undefined;
}) {
  return (
    <Field>
      <FieldLabel required={required}>{label}</FieldLabel>
      <div className="flex min-w-0 gap-2">
        <FieldControl
          type="date"
          required={required}
          className={cn(controlClass, 'flex-1')}
          {...(bounds?.min === undefined ? {} : { min: bounds.min })}
          {...(bounds?.max === undefined ? {} : { max: bounds.max })}
          value={value.date}
          onChange={(event) => onChange({ ...value, date: event.target.value })}
        />
        <FieldControl
          type="time"
          required={required}
          className={cn(controlClass, 'w-[8.5rem] shrink-0')}
          value={value.time}
          onChange={(event) => onChange({ ...value, time: event.target.value })}
        />
      </div>
    </Field>
  );
}

/**
 * States the window the service must fall inside, in words.
 *
 * The bounded pickers alone leave the rule implicit — a greyed-out calendar
 * says "no" without saying why — so the span is spelled out beside them. It
 * renders nothing when the project declares no dates, because then there is no
 * rule to state.
 */
export function ProjectWindowHint({ project }: { project: ProjectWindow }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  if (project.startsAt === undefined && project.endsAt === undefined) return null;
  const start = project.startsAt === undefined ? undefined : formatDateTime(locale, project.startsAt);
  const end = project.endsAt === undefined ? undefined : formatDateTime(locale, project.endsAt);
  return (
    <FieldSpanFull>
      <p className="text-xs text-ink-3">
        {start !== undefined && end !== undefined
          ? t('services.projectWindow', { start, end })
          : start === undefined
            ? t('services.projectWindowOpenStart', { end: end ?? '' })
            : t('services.projectWindowOpenEnd', { start })}
      </p>
    </FieldSpanFull>
  );
}

export function ServiceDynamicField({
  field,
  label,
  value,
  onChange,
  organizationId,
  hasDefault = false,
}: {
  field: RecipeField;
  label: string;
  value: FieldValueFormState;
  onChange: (value: FieldValueFormState) => void;
  organizationId: OrganizationId | undefined;
  hasDefault?: boolean;
}) {
  const t = useTranslations();
  // A field with a stored default is not blocking: the server fills it in.
  const required = field.required && !hasDefault;

  if (field.config.kind === 'location' && value.kind === 'location' && organizationId !== undefined)
    return (
      <FieldSpanFull>
        <Field>
          <FieldLabel required={required}>{label}</FieldLabel>
          <LocationPicker
            organizationId={organizationId}
            value={value.locationId}
            onChange={(locationId) => onChange({ kind: 'location', locationId })}
          />
        </Field>
      </FieldSpanFull>
    );

  if (field.config.kind === 'boolean' && value.kind === 'boolean')
    return (
      <Field>
        <FieldLabel>{label}</FieldLabel>
        <label className="flex h-[38px] items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="size-4 accent-[var(--sc-accent)]"
            checked={value.value}
            onChange={(event) => onChange({ kind: 'boolean', value: event.target.checked })}
          />
          {value.value ? t('common.yes') : t('common.no')}
        </label>
      </Field>
    );

  if (field.config.kind === 'select' && value.kind === 'select')
    return (
      <Field>
        <FieldLabel required={required}>{label}</FieldLabel>
        <FieldControl
          render={<select />}
          required={required}
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
        </FieldControl>
      </Field>
    );

  if (field.config.kind === 'multiSelect' && value.kind === 'multiSelect')
    return (
      <FieldSpanFull>
        <fieldset className="flex min-w-0 flex-col gap-1.5">
          <legend className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">{label}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
            {field.config.options.map((option) => (
              <label key={option.id} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--sc-accent)]"
                  checked={value.optionIds.includes(option.id)}
                  onChange={(event) =>
                    onChange({
                      kind: 'multiSelect',
                      optionIds: event.target.checked
                        ? [...value.optionIds, option.id]
                        : value.optionIds.filter((id) => id !== option.id),
                    })
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
      </FieldSpanFull>
    );

  if (field.config.kind === 'datetime' && value.kind === 'datetime')
    return (
      <ServiceDateTime
        label={label}
        value={value}
        onChange={(next) => onChange({ kind: 'datetime', ...next })}
        required={required}
        bounds={datetimeDateBounds(field.config)}
      />
    );

  if (field.config.kind === 'longText' && value.kind === 'longText')
    return (
      <FieldSpanFull>
        <Field>
          <FieldLabel required={required}>{label}</FieldLabel>
          <FieldControl
            render={<textarea rows={3} />}
            required={required}
            className={cn(controlClass, 'h-auto py-2 leading-relaxed')}
            {...fieldInputBounds(field.config)}
            value={value.value}
            onChange={(event) => onChange({ kind: 'longText', value: event.target.value })}
          />
        </Field>
      </FieldSpanFull>
    );

  if (
    (field.config.kind === 'text' ||
      field.config.kind === 'number' ||
      field.config.kind === 'date' ||
      field.config.kind === 'time') &&
    value.kind === field.config.kind
  )
    return (
      <Field>
        <FieldLabel required={required}>{label}</FieldLabel>
        <FieldControl
          required={required}
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
          {...fieldInputBounds(field.config)}
          value={value.value}
          onChange={(event) => onChange({ kind: value.kind, value: event.target.value })}
        />
      </Field>
    );

  return null;
}
