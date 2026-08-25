'use client';

import { useTranslations } from 'next-intl';

import type { FieldDataType, fieldConfigValidator } from '@priamo/convex/validators';

import { Button } from '@/components/ui/button';
import { isValidDateInput, isValidTimeInput, parseDateForStorage, parseTimeForStorage } from '@/i18n/formats';
import { clampConfigToBound } from '@/lib/recipe-field-narrowing';

export type FieldConfig = typeof fieldConfigValidator.type;
type Option = { id: string; label: string };

export const fieldDataTypes = [
  'text',
  'longText',
  'number',
  'boolean',
  'date',
  'datetime',
  'time',
  'select',
  'multiSelect',
  'location',
] as const;

type CoversExactly<Listed extends Union, Union> = [Union] extends [Listed] ? true : never;

const fieldDataTypesInSync: CoversExactly<(typeof fieldDataTypes)[number], FieldDataType> = true;

void fieldDataTypesInSync;

export const freshConfig: Record<FieldDataType, () => FieldConfig> = {
  text: () => ({ kind: 'text' }),
  longText: () => ({ kind: 'longText' }),
  number: () => ({ kind: 'number' }),
  boolean: () => ({ kind: 'boolean' }),
  date: () => ({ kind: 'date' }),
  datetime: () => ({ kind: 'datetime' }),
  time: () => ({ kind: 'time' }),
  select: () => ({ kind: 'select', options: [{ id: '', label: '' }] }),
  multiSelect: () => ({ kind: 'multiSelect', options: [{ id: '', label: '' }] }),
  location: () => ({ kind: 'location' }),
};

function optionalNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

type FieldConfigEditorProps = {
  config: FieldConfig;
  setConfig: (config: FieldConfig) => void;
  /** A definition config that a recipe snapshot may tighten but never widen. */
  bound?: FieldConfig | undefined;
  disabled?: boolean;
};

export function FieldConfigEditor({ config, setConfig, bound, disabled = false }: FieldConfigEditorProps) {
  const t = useTranslations();
  const update = (next: FieldConfig): void => setConfig(clampConfigToBound(next, bound));
  const isBounded = bound !== undefined && bound.kind === config.kind;

  function input(label: string, value: string, onChange: (value: string) => void, note?: string) {
    return <EditorInput label={label} value={value} onChange={onChange} disabled={disabled} note={note} />;
  }

  function numberInput(
    label: string,
    value: number | undefined,
    change: (value: number | undefined) => void,
    note?: string,
  ) {
    return input(label, value?.toString() ?? '', (next) => change(optionalNumber(next)), note);
  }

  const numberBound = (min: number | undefined, max: number | undefined): string | undefined =>
    min === undefined && max === undefined
      ? undefined
      : t('fields.definitionAllows', {
          min: min === undefined ? '−∞' : min,
          max: max === undefined ? '∞' : max,
        });

  switch (config.kind) {
    case 'text':
    case 'longText':
      return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {numberInput(
            t('fields.minLength'),
            config.minLength,
            (minLength) =>
              update({
                kind: config.kind,
                ...(minLength === undefined ? {} : { minLength }),
                ...(config.maxLength === undefined ? {} : { maxLength: config.maxLength }),
              }),
            numberBound(
              isBounded && bound.kind === config.kind ? bound.minLength : undefined,
              isBounded && bound.kind === config.kind ? bound.maxLength : undefined,
            ),
          )}
          {numberInput(
            t('fields.maxLength'),
            config.maxLength,
            (maxLength) =>
              update({
                kind: config.kind,
                ...(config.minLength === undefined ? {} : { minLength: config.minLength }),
                ...(maxLength === undefined ? {} : { maxLength }),
              }),
            numberBound(
              isBounded && bound.kind === config.kind ? bound.minLength : undefined,
              isBounded && bound.kind === config.kind ? bound.maxLength : undefined,
            ),
          )}
        </div>
      );
    case 'number':
      return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {numberInput(
            t('fields.min'),
            config.min,
            (min) =>
              update({
                kind: 'number',
                ...(min === undefined ? {} : { min }),
                ...(config.max === undefined ? {} : { max: config.max }),
                ...(config.integer === undefined ? {} : { integer: config.integer }),
              }),
            numberBound(
              isBounded && bound.kind === 'number' ? bound.min : undefined,
              isBounded && bound.kind === 'number' ? bound.max : undefined,
            ),
          )}
          {numberInput(
            t('fields.max'),
            config.max,
            (max) =>
              update({
                kind: 'number',
                ...(config.min === undefined ? {} : { min: config.min }),
                ...(max === undefined ? {} : { max }),
                ...(config.integer === undefined ? {} : { integer: config.integer }),
              }),
            numberBound(
              isBounded && bound.kind === 'number' ? bound.min : undefined,
              isBounded && bound.kind === 'number' ? bound.max : undefined,
            ),
          )}
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={config.integer ?? false}
              disabled={disabled || (isBounded && bound.kind === 'number' && bound.integer === true)}
              onChange={(event) =>
                update({
                  kind: 'number',
                  ...(config.min === undefined ? {} : { min: config.min }),
                  ...(config.max === undefined ? {} : { max: config.max }),
                  ...(event.target.checked ? { integer: true } : {}),
                })
              }
            />
            {t('fields.integerOnly')}
          </label>
        </div>
      );
    case 'date':
    case 'time':
      return (
        <TemporalBounds
          type={config.kind}
          min={config.min}
          max={config.max}
          bound={isBounded && bound.kind === config.kind ? bound : undefined}
          disabled={disabled}
          onChange={(min, max) =>
            update({ kind: config.kind, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) })
          }
        />
      );
    case 'datetime':
      return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {numberInput(
            t('fields.min'),
            config.min,
            (min) =>
              update({
                kind: 'datetime',
                ...(min === undefined ? {} : { min }),
                ...(config.max === undefined ? {} : { max: config.max }),
              }),
            numberBound(
              isBounded && bound.kind === 'datetime' ? Number(bound.min) : undefined,
              isBounded && bound.kind === 'datetime' ? Number(bound.max) : undefined,
            ),
          )}
          {numberInput(
            t('fields.max'),
            config.max,
            (max) =>
              update({
                kind: 'datetime',
                ...(config.min === undefined ? {} : { min: config.min }),
                ...(max === undefined ? {} : { max }),
              }),
            numberBound(
              isBounded && bound.kind === 'datetime' ? Number(bound.min) : undefined,
              isBounded && bound.kind === 'datetime' ? Number(bound.max) : undefined,
            ),
          )}
        </div>
      );
    case 'select':
    case 'multiSelect':
      return (
        <OptionEditor
          config={config}
          bound={isBounded && bound.kind === config.kind ? bound : undefined}
          disabled={disabled}
          update={update}
        />
      );
    case 'boolean':
    case 'location':
      return null;
  }
}

function OptionEditor({
  config,
  bound,
  disabled,
  update,
}: {
  config: Extract<FieldConfig, { kind: 'select' | 'multiSelect' }>;
  bound: Extract<FieldConfig, { kind: 'select' | 'multiSelect' }> | undefined;
  disabled: boolean;
  update: (config: FieldConfig) => void;
}) {
  const t = useTranslations();
  function changeOption(index: number, property: keyof Option, value: string): void {
    const options = config.options.map((option, optionIndex) =>
      optionIndex === index ? { ...option, [property]: value } : option,
    );
    update(config.kind === 'select' ? { kind: 'select', options } : { ...config, options });
  }
  const multiBound = bound?.kind === 'multiSelect' ? bound : undefined;
  const multiNote =
    multiBound === undefined
      ? undefined
      : t('fields.definitionAllows', { min: multiBound.minSelections ?? '−∞', max: multiBound.maxSelections ?? '∞' });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-3">{t('fields.optionIdentityNotice')}</p>
      {config.options.map((option, index) => (
        <div key={option.id || index} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <EditorInput
            label={t('fields.optionId')}
            value={option.id}
            onChange={(value) => changeOption(index, 'id', value)}
            disabled={disabled || bound !== undefined}
          />
          <EditorInput
            label={t('fields.optionLabel')}
            value={option.label}
            onChange={(value) => changeOption(index, 'label', value)}
            disabled={disabled}
          />
          <Button
            type="button"
            variant="ghost"
            className="self-end"
            disabled={disabled}
            onClick={() =>
              update(
                config.kind === 'select'
                  ? { kind: 'select', options: config.options.filter((_, optionIndex) => optionIndex !== index) }
                  : { ...config, options: config.options.filter((_, optionIndex) => optionIndex !== index) },
              )
            }
          >
            {t('fields.removeOption')}
          </Button>
        </div>
      ))}
      {bound === undefined ? (
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          disabled={disabled}
          onClick={() =>
            update(
              config.kind === 'select'
                ? { kind: 'select', options: [...config.options, { id: '', label: '' }] }
                : { ...config, options: [...config.options, { id: '', label: '' }] },
            )
          }
        >
          {t('fields.addOption')}
        </Button>
      ) : null}
      {config.kind === 'multiSelect' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {numberInput(
            t('fields.minSelections'),
            config.minSelections,
            (minSelections) =>
              update({
                kind: 'multiSelect',
                options: config.options,
                ...(minSelections === undefined ? {} : { minSelections }),
                ...(config.maxSelections === undefined ? {} : { maxSelections: config.maxSelections }),
              }),
            disabled,
            multiNote,
          )}
          {numberInput(
            t('fields.maxSelections'),
            config.maxSelections,
            (maxSelections) =>
              update({
                kind: 'multiSelect',
                options: config.options,
                ...(config.minSelections === undefined ? {} : { minSelections: config.minSelections }),
                ...(maxSelections === undefined ? {} : { maxSelections }),
              }),
            disabled,
            multiNote,
          )}
        </div>
      ) : null}
    </div>
  );
}

function numberInput(
  label: string,
  value: number | undefined,
  change: (value: number | undefined) => void,
  disabled: boolean,
  note: string | undefined,
) {
  return (
    <EditorInput
      label={label}
      value={value?.toString() ?? ''}
      onChange={(next) => change(optionalNumber(next))}
      disabled={disabled}
      note={note}
    />
  );
}

function TemporalBounds({
  type,
  min,
  max,
  bound,
  disabled,
  onChange,
}: {
  type: 'date' | 'time';
  min: string | undefined;
  max: string | undefined;
  bound: Extract<FieldConfig, { kind: 'date' | 'time' }> | undefined;
  disabled: boolean;
  onChange: (min: string | undefined, max: string | undefined) => void;
}) {
  const t = useTranslations();
  const parse = type === 'date' ? parseDateForStorage : parseTimeForStorage;
  const valid = type === 'date' ? isValidDateInput : isValidTimeInput;
  const note =
    bound === undefined ? undefined : t('fields.definitionAllows', { min: bound.min ?? '−∞', max: bound.max ?? '∞' });
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <EditorInput
        label={t('fields.min')}
        type={type}
        value={min ?? ''}
        disabled={disabled}
        note={note}
        onChange={(value) => onChange(value === '' ? undefined : valid(value) ? parse(value) : undefined, max)}
      />
      <EditorInput
        label={t('fields.max')}
        type={type}
        value={max ?? ''}
        disabled={disabled}
        note={note}
        onChange={(value) => onChange(min, value === '' ? undefined : valid(value) ? parse(value) : undefined)}
      />
    </div>
  );
}

function EditorInput({
  label,
  value,
  onChange,
  disabled,
  note,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  note?: string | undefined;
  type?: 'text' | 'date' | 'time';
}) {
  return (
    <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
      {label}
      <input
        type={type}
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {note === undefined ? null : (
        <span className="text-xs font-normal normal-case tracking-normal text-ink-3">{note}</span>
      )}
    </label>
  );
}
