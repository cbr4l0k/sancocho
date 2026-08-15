'use client';

import { useMutation, usePaginatedQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';

import { api } from '@sancocho/convex/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { semanticRegistry } from '@sancocho/convex/validators';
import type { FieldDataType, SemanticType } from '@sancocho/convex/validators';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Panel,
  PanelBody,
  PanelBodyFlush,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableLoadMore,
  TableRow,
  TableRowHeaderCell,
  TableSkeletonRows,
} from '@/components/ui/table';
import { builtinFieldLabel } from '@/i18n/builtin-fields';
import {
  formatDate,
  formatDateTime,
  formatTime,
  isValidDateInput,
  isValidTimeInput,
  parseDateForStorage,
  parseTimeForStorage,
} from '@/i18n/formats';
import type { CanonicalLocale } from '@/i18n/locales';
import { messagesForLocale } from '@/i18n/messages';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { semanticTypeMessageKey } from '@/i18n/vocab-keys';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { roleAtLeast } from '@/lib/roles';

type FieldDefinition = FunctionReturnType<
  typeof api.fields.queries.listFieldDefinitions
>['page'][number];
type Option = { id: string; label: string };
type CreateFieldArgs = Omit<
  FunctionArgs<typeof api.fields.mutations.createFieldDefinition>,
  'organizationId'
>;
type UpdateFieldArgs = FunctionArgs<typeof api.fields.mutations.updateFieldDefinition>;
type FieldConfig = CreateFieldArgs['config'];
type EditorState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; field: FieldDefinition };
type ConfirmationState =
  | { mode: 'archive'; field: FieldDefinition }
  | { mode: 'delete'; field: FieldDefinition }
  | null;

const fieldDataTypes = [
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

type CoversExactly<Listed extends Union, Union> = [Union] extends [Listed]
  ? true
  : never;

const _fieldDataTypesInSync: CoversExactly<
  (typeof fieldDataTypes)[number],
  FieldDataType
> = true;

void _fieldDataTypesInSync;

const freshConfig: Record<FieldDataType, () => FieldConfig> = {
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

function semanticTypesFor(kind: FieldDataType): SemanticType[] {
  return Object.keys(semanticTypeMessageKey)
    .filter(
      (semanticType): semanticType is SemanticType =>
        Object.hasOwn(semanticRegistry, semanticType),
    )
    .filter(
      (semanticType) => semanticRegistry[semanticType].expectedDataType === kind,
    );
}

function configSummary(config: FieldConfig, locale: CanonicalLocale): string {
  switch (config.kind) {
    case 'date':
      return [
        config.min && formatDate(locale, config.min),
        config.max && formatDate(locale, config.max),
      ]
        .filter(Boolean)
        .join(' – ');
    case 'time':
      return [
        config.min && formatTime(locale, config.min),
        config.max && formatTime(locale, config.max),
      ]
        .filter(Boolean)
        .join(' – ');
    case 'datetime':
      return [
        config.min && formatDateTime(locale, config.min),
        config.max && formatDateTime(locale, config.max),
      ]
        .filter(Boolean)
        .join(' – ');
    case 'select':
    case 'multiSelect':
      return config.options.map((option) => option.label).join(', ');
    default:
      return '';
  }
}

function dataTypeLabel(locale: CanonicalLocale, kind: FieldDataType): string {
  return messagesForLocale(locale).fields.dataTypes[kind];
}

function semanticLabel(locale: CanonicalLocale, semanticType: SemanticType): string {
  return messagesForLocale(locale).fields.semanticTypes[
    semanticTypeMessageKey[semanticType]
  ].label;
}

export function FieldDefinitionsSurface() {
  const { currentOrganization } = useCurrentOrganization();
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const custom = usePaginatedQuery(
    api.fields.queries.listFieldDefinitions,
    currentOrganization === null
      ? 'skip'
      : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );
  const builtins = usePaginatedQuery(
    api.fields.queries.listBuiltinFieldDefinitions,
    {},
    { initialNumItems: 25 },
  );
  const createField = useMutation(api.fields.mutations.createFieldDefinition);
  const updateField = useMutation(api.fields.mutations.updateFieldDefinition);
  const archiveField = useMutation(api.fields.mutations.archiveFieldDefinition);
  const deleteField = useMutation(api.fields.mutations.deleteFieldDefinition);
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });
  const [confirmation, setConfirmation] = useState<ConfirmationState>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canManage =
    currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');

  if (currentOrganization === null) return null;

  async function confirmAction(): Promise<void> {
    if (confirmation === null) return;

    try {
      if (confirmation.mode === 'archive') {
        await archiveField({ fieldDefinitionId: confirmation.field._id });
      } else {
        await deleteField({ fieldDefinitionId: confirmation.field._id });
      }
      setConfirmation(null);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  const editorField = editor.mode === 'edit' ? editor.field : undefined;
  const editorKey = editor.mode === 'edit' ? editor.field._id : 'create';

  return (
    <div className="flex flex-col gap-8">
      <header className="flex max-w-3xl flex-col gap-2">
        <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
          {t('fields.eyebrow')}
        </p>
        <h1 className="text-display font-extrabold tracking-[-0.025em] text-ink">
          {t('fields.title')}
        </h1>
        <p className="text-sm text-ink-2">{t('fields.lead')}</p>
      </header>
      {message === null ? null : (
        <p
          role="alert"
          className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop"
        >
          {message}
        </p>
      )}
      {canManage ? (
        <Button
          variant="primary"
          className="self-start"
          onClick={() => setEditor({ mode: 'create' })}
        >
          {t('fields.create')}
        </Button>
      ) : null}
      {canManage && editor.mode !== 'closed' ? (
        <FieldEditor
          key={editorKey}
          field={editorField}
          organizationId={currentOrganization.organization._id}
          onClose={() => setEditor({ mode: 'closed' })}
          onCreate={createField}
          onUpdate={updateField}
        />
      ) : null}
      <FieldTable
        title={t('fields.customTitle')}
        fields={custom.results}
        loading={custom.status === 'LoadingFirstPage'}
        canManage={canManage}
        locale={locale}
        onEdit={(field) => setEditor({ mode: 'edit', field })}
        onArchive={(field) => setConfirmation({ mode: 'archive', field })}
        onDelete={(field) => setConfirmation({ mode: 'delete', field })}
      />
      {custom.status === 'Exhausted' && custom.results.length === 0 ? (
        <EmptyState
          title={t('fields.emptyTitle')}
          description={t('fields.emptyBody')}
          action={
            canManage ? (
              <Button
                variant="secondary"
                onClick={() => setEditor({ mode: 'create' })}
              >
                {t('fields.create')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <TableLoadMore
          status={custom.status}
          loadedCount={custom.results.length}
          onLoadMore={custom.loadMore}
        />
      )}
      <FieldTable
        title={t('fields.builtinsTitle')}
        fields={builtins.results}
        loading={builtins.status === 'LoadingFirstPage'}
        canManage={false}
        locale={locale}
        builtin
      />
      <TableLoadMore
        status={builtins.status}
        loadedCount={builtins.results.length}
        onLoadMore={builtins.loadMore}
      />
      {confirmation === null ? null : (
        <FieldConfirmation
          mode={confirmation.mode}
          onConfirm={confirmAction}
          onCancel={() => setConfirmation(null)}
        />
      )}
    </div>
  );
}

type FieldTableProps = {
  title: string;
  fields: readonly FieldDefinition[];
  loading: boolean;
  canManage: boolean;
  locale: CanonicalLocale;
  onEdit?: (field: FieldDefinition) => void;
  onArchive?: (field: FieldDefinition) => void;
  onDelete?: (field: FieldDefinition) => void;
  builtin?: boolean;
};

function FieldTable({
  title,
  fields,
  loading,
  canManage,
  locale,
  onEdit,
  onArchive,
  onDelete,
  builtin = false,
}: FieldTableProps) {
  const t = useTranslations();

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
      </PanelHeader>
      <PanelBodyFlush>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('fields.label')}</TableHeaderCell>
              <TableHeaderCell>{t('fields.key')}</TableHeaderCell>
              <TableHeaderCell>{t('fields.dataType')}</TableHeaderCell>
              <TableHeaderCell>{t('fields.semanticType')}</TableHeaderCell>
              <TableHeaderCell>{t('fields.statuses.active')}</TableHeaderCell>
              {canManage ? <TableHeaderCell /> : null}
            </TableRow>
          </TableHead>
          {loading ? (
            <TableSkeletonRows columns={canManage ? 6 : 5} />
          ) : (
            <TableBody>
              {fields.map((field) => (
                <TableRow
                  key={field._id}
                  className={builtin ? 'bg-ground-2/30' : undefined}
                >
                  <TableRowHeaderCell>
                    <div className="flex flex-col gap-1">
                      <span>
                        {builtin
                          ? builtinFieldLabel(
                              locale,
                              field.semanticType,
                              field.label,
                            )
                          : field.label}
                      </span>
                      {field.description === undefined ? null : (
                        <span className="text-xs font-normal text-ink-3">
                          {field.description}
                        </span>
                      )}
                    </div>
                  </TableRowHeaderCell>
                  <TableCell mono>{field.key}</TableCell>
                  <TableCell>{dataTypeLabel(locale, field.config.kind)}</TableCell>
                  <TableCell>
                    {field.semanticType === undefined
                      ? t('fields.noSemanticType')
                      : semanticLabel(locale, field.semanticType)}
                  </TableCell>
                  <TableCell>
                    <StatusChip kind="archival" status={field.status} />
                  </TableCell>
                  {canManage ? (
                    <TableCell align="end">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onEdit?.(field)}
                        >
                          {t('fields.edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onArchive?.(field)}
                          disabled={field.status === 'archived'}
                        >
                          {t('fields.archive')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => onDelete?.(field)}
                        >
                          {t('fields.delete')}
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          )}
        </Table>
      </PanelBodyFlush>
    </Panel>
  );
}

function FieldConfirmation({
  mode,
  onConfirm,
  onCancel,
}: {
  mode: 'archive' | 'delete';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const archive = mode === 'archive';

  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>
            {t(archive ? 'fields.archiveTitle' : 'fields.deleteTitle')}
          </PanelTitle>
          <PanelDescription>
            {t(archive ? 'fields.archiveWarning' : 'fields.deleteWarning')}
          </PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="flex-row flex-wrap">
        <Button variant="danger" onClick={onConfirm}>
          {t(archive ? 'fields.archiveConfirm' : 'fields.deleteConfirm')}
        </Button>
        <Button onClick={onCancel}>
          {t(archive ? 'fields.cancelArchive' : 'common.cancel')}
        </Button>
      </PanelBody>
    </Panel>
  );
}

type FieldEditorProps = {
  field?: FieldDefinition | undefined;
  organizationId: FunctionArgs<
    typeof api.fields.mutations.createFieldDefinition
  >['organizationId'];
  onClose: () => void;
  onCreate: (
    args: FunctionArgs<typeof api.fields.mutations.createFieldDefinition>,
  ) => Promise<unknown>;
  onUpdate: (args: UpdateFieldArgs) => Promise<unknown>;
};

function FieldEditor({
  field,
  organizationId,
  onClose,
  onCreate,
  onUpdate,
}: FieldEditorProps) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const [key, setKey] = useState(field?.key ?? '');
  const [label, setLabel] = useState(field?.label ?? '');
  const [description, setDescription] = useState(field?.description ?? '');
  const [config, setConfig] = useState<FieldConfig>(
    field?.config ?? freshConfig.text(),
  );
  const [semanticType, setSemanticType] = useState<SemanticType | undefined>(
    field?.semanticType,
  );
  const [error, setError] = useState<string | null>(null);
  const compatibleSemantics = semanticTypesFor(config.kind);
  const existing = field !== undefined;

  function chooseType(kind: FieldDataType): void {
    setConfig(freshConfig[kind]());
    if (
      semanticType !== undefined &&
      semanticRegistry[semanticType].expectedDataType !== kind
    ) {
      setSemanticType(undefined);
    }
  }

  function updateOptions(
    index: number,
    property: keyof Option,
    value: string,
  ): void {
    if (config.kind !== 'select' && config.kind !== 'multiSelect') return;

    const options = config.options.map((option, optionIndex) =>
      optionIndex === index ? { ...option, [property]: value } : option,
    );
    setConfig(
      config.kind === 'select' ? { kind: 'select', options } : { ...config, options },
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    try {
      if (existing && field !== undefined) {
        await onUpdate({
          fieldDefinitionId: field._id,
          key,
          label,
          ...(description === '' ? {} : { description }),
          ...(semanticType === undefined ? {} : { semanticType }),
          config,
        });
      } else {
        await onCreate({
          organizationId,
          key,
          label,
          ...(description === '' ? {} : { description }),
          ...(semanticType === undefined ? {} : { semanticType }),
          config,
        });
      }
      onClose();
    } catch (caught) {
      setError(t(errorMessageKey(presentConvexError(caught))));
    }
  }

  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>
            {t(existing ? 'fields.editTitle' : 'fields.createTitle')}
          </PanelTitle>
          <PanelDescription>{t('fields.snapshotNotice')}</PanelDescription>
        </div>
        <Button variant="ghost" onClick={onClose}>
          {t('fields.close')}
        </Button>
      </PanelHeader>
      <PanelBody>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <p className="text-xs text-ink-3">{t('fields.immutableNotice')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <EditorInput
              label={t('fields.label')}
              value={label}
              onChange={setLabel}
              required
            />
            <EditorInput
              label={t('fields.key')}
              value={key}
              onChange={setKey}
              required
              disabled={existing && field?.status === 'archived'}
            />
            <EditorInput
              label={t('fields.description')}
              value={description}
              onChange={setDescription}
            />
            <EditorSelect
              label={t('fields.dataType')}
              value={config.kind}
              onChange={(value) => {
                const kind = fieldDataTypes.find((candidate) => candidate === value);
                if (kind !== undefined) chooseType(kind);
              }}
              disabled={existing && field?.status === 'archived'}
            >
              {fieldDataTypes.map((kind) => (
                <option key={kind} value={kind}>
                  {dataTypeLabel(locale, kind)}
                </option>
              ))}
            </EditorSelect>
            <EditorSelect
              label={t('fields.semanticType')}
              value={semanticType ?? ''}
              onChange={(value) =>
                setSemanticType(compatibleSemantics.find((type) => type === value))
              }
            >
              <option value="">{t('fields.noSemanticType')}</option>
              {compatibleSemantics.map((type) => (
                <option key={type} value={type}>
                  {semanticLabel(locale, type)}
                </option>
              ))}
            </EditorSelect>
          </div>
          <ConfigEditor
            config={config}
            setConfig={setConfig}
            updateOptions={updateOptions}
          />
          {semanticType === undefined ? null : (
            <p className="text-xs text-ink-2">
              {
                messagesForLocale(locale).fields.semanticTypes[
                  semanticTypeMessageKey[semanticType]
                ].description
              }
              {' · '}
              {semanticRegistry[semanticType].capabilities
                .map(
                  (capability) =>
                    messagesForLocale(locale).fields.capabilities[capability],
                )
                .join(' · ')}
            </p>
          )}
          {error === null ? null : (
            <p role="alert" className="text-sm text-tone-stop">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit">
              {t('fields.save')}
            </Button>
            <Button type="button" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </PanelBody>
    </Panel>
  );
}

function EditorLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
      {label}
      {children}
    </label>
  );
}

function EditorInput({
  label,
  value,
  onChange,
  required = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <EditorLabel label={label}>
      <input
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
        value={value}
        required={required}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </EditorLabel>
  );
}

function EditorSelect({
  label,
  value,
  onChange,
  disabled = false,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <EditorLabel label={label}>
      <select
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        {children}
      </select>
    </EditorLabel>
  );
}

type ConfigEditorProps = {
  config: FieldConfig;
  setConfig: (config: FieldConfig) => void;
  updateOptions: (index: number, property: keyof Option, value: string) => void;
};

function ConfigEditor({
  config,
  setConfig,
  updateOptions,
}: ConfigEditorProps) {
  const t = useTranslations();

  function bound(
    label: string,
    value: number | undefined,
    change: (value: number | undefined) => void,
  ) {
    return (
      <EditorInput
        label={label}
        value={value?.toString() ?? ''}
        onChange={(next) => change(optionalNumber(next))}
      />
    );
  }

  switch (config.kind) {
    case 'text':
    case 'longText':
      return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {bound(t('fields.minLength'), config.minLength, (minLength) =>
            setConfig({
              kind: config.kind,
              ...(minLength === undefined ? {} : { minLength }),
              ...(config.maxLength === undefined
                ? {}
                : { maxLength: config.maxLength }),
            }),
          )}
          {bound(t('fields.maxLength'), config.maxLength, (maxLength) =>
            setConfig({
              kind: config.kind,
              ...(config.minLength === undefined
                ? {}
                : { minLength: config.minLength }),
              ...(maxLength === undefined ? {} : { maxLength }),
            }),
          )}
        </div>
      );
    case 'number':
      return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {bound(t('fields.min'), config.min, (min) =>
            setConfig({
              kind: 'number',
              ...(min === undefined ? {} : { min }),
              ...(config.max === undefined ? {} : { max: config.max }),
              ...(config.integer === undefined ? {} : { integer: config.integer }),
            }),
          )}
          {bound(t('fields.max'), config.max, (max) =>
            setConfig({
              kind: 'number',
              ...(config.min === undefined ? {} : { min: config.min }),
              ...(max === undefined ? {} : { max }),
              ...(config.integer === undefined ? {} : { integer: config.integer }),
            }),
          )}
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={config.integer ?? false}
              onChange={(event) =>
                setConfig({
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
      return (
        <TemporalBounds
          type="date"
          min={config.min}
          max={config.max}
          onChange={(min, max) =>
            setConfig({
              kind: 'date',
              ...(min === undefined ? {} : { min }),
              ...(max === undefined ? {} : { max }),
            })
          }
        />
      );
    case 'time':
      return (
        <TemporalBounds
          type="time"
          min={config.min}
          max={config.max}
          onChange={(min, max) =>
            setConfig({
              kind: 'time',
              ...(min === undefined ? {} : { min }),
              ...(max === undefined ? {} : { max }),
            })
          }
        />
      );
    case 'datetime':
      return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {bound(t('fields.min'), config.min, (min) =>
            setConfig({
              kind: 'datetime',
              ...(min === undefined ? {} : { min }),
              ...(config.max === undefined ? {} : { max: config.max }),
            }),
          )}
          {bound(t('fields.max'), config.max, (max) =>
            setConfig({
              kind: 'datetime',
              ...(config.min === undefined ? {} : { min: config.min }),
              ...(max === undefined ? {} : { max }),
            }),
          )}
        </div>
      );
    case 'select':
    case 'multiSelect':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-ink-3">
            {t('fields.optionIdentityNotice')}
          </p>
          {config.options.map((option, index) => (
            <div
              key={index}
              className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]"
            >
              <EditorInput
                label={t('fields.optionId')}
                value={option.id}
                onChange={(value) => updateOptions(index, 'id', value)}
              />
              <EditorInput
                label={t('fields.optionLabel')}
                value={option.label}
                onChange={(value) => updateOptions(index, 'label', value)}
              />
              <Button
                type="button"
                variant="ghost"
                className="self-end"
                onClick={() =>
                  setConfig(
                    config.kind === 'select'
                      ? {
                          kind: 'select',
                          options: config.options.filter(
                            (_, optionIndex) => optionIndex !== index,
                          ),
                        }
                      : {
                          ...config,
                          options: config.options.filter(
                            (_, optionIndex) => optionIndex !== index,
                          ),
                        },
                  )
                }
              >
                {t('fields.removeOption')}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            className="self-start"
            onClick={() =>
              setConfig(
                config.kind === 'select'
                  ? {
                      kind: 'select',
                      options: [...config.options, { id: '', label: '' }],
                    }
                  : {
                      ...config,
                      options: [...config.options, { id: '', label: '' }],
                    },
              )
            }
          >
            {t('fields.addOption')}
          </Button>
          {config.kind === 'multiSelect' ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {bound(
                t('fields.minSelections'),
                config.minSelections,
                (minSelections) =>
                  setConfig({
                    kind: 'multiSelect',
                    options: config.options,
                    ...(minSelections === undefined ? {} : { minSelections }),
                    ...(config.maxSelections === undefined
                      ? {}
                      : { maxSelections: config.maxSelections }),
                  }),
              )}
              {bound(
                t('fields.maxSelections'),
                config.maxSelections,
                (maxSelections) =>
                  setConfig({
                    kind: 'multiSelect',
                    options: config.options,
                    ...(config.minSelections === undefined
                      ? {}
                      : { minSelections: config.minSelections }),
                    ...(maxSelections === undefined ? {} : { maxSelections }),
                  }),
              )}
            </div>
          ) : null}
        </div>
      );
    case 'boolean':
    case 'location':
      return null;
  }
}

function TemporalBounds({
  type,
  min,
  max,
  onChange,
}: {
  type: 'date' | 'time';
  min: string | undefined;
  max: string | undefined;
  onChange: (min: string | undefined, max: string | undefined) => void;
}) {
  const t = useTranslations();
  const parse = type === 'date' ? parseDateForStorage : parseTimeForStorage;
  const valid = type === 'date' ? isValidDateInput : isValidTimeInput;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <EditorLabel label={t('fields.min')}>
        <input
          type={type}
          className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm"
          value={min ?? ''}
          onChange={(event) =>
            onChange(
              event.target.value === ''
                ? undefined
                : valid(event.target.value)
                  ? parse(event.target.value)
                  : undefined,
              max,
            )
          }
        />
      </EditorLabel>
      <EditorLabel label={t('fields.max')}>
        <input
          type={type}
          className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm"
          value={max ?? ''}
          onChange={(event) =>
            onChange(
              min,
              event.target.value === ''
                ? undefined
                : valid(event.target.value)
                  ? parse(event.target.value)
                  : undefined,
            )
          }
        />
      </EditorLabel>
    </div>
  );
}
