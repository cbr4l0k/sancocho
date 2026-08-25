'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';

import { useFieldDefinitionIndex } from '@/components/fields/use-field-definition-index';
import { FieldConfigEditor } from '@/components/fields/field-config-editor';
import { LocationPicker } from '@/components/locations/location-picker';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { builtinFieldLabel } from '@/i18n/builtin-fields';
import { LocaleLink } from '@/i18n/locale-link';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import {
  emptyFieldValueFormState,
  fromEventFieldValue,
  toEventFieldValue,
  type FieldValueFormState,
} from '@/lib/field-value-form';
import { checkRecipeDraft } from '@/lib/recipe-draft-checks';
import { roleAtLeast } from '@/lib/roles';

type RecipeId = FunctionArgs<typeof api.recipes.queries.getRecipe>['recipeId'];
type RecipeField = FunctionReturnType<typeof api.recipes.fields.queries.listRecipeFields>[number];
type Definition = FunctionReturnType<typeof api.fields.queries.listFieldDefinitions>['page'][number];

export function DraftRecipeEditorSurface({ recipeId }: { recipeId: RecipeId }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const recipeData = useQuery(api.recipes.queries.getRecipe, { recipeId });
  const draft = recipeData?.versions.find((version) => version.status === 'draft');
  const fields = useQuery(
    api.recipes.fields.queries.listRecipeFields,
    draft === undefined ? 'skip' : { recipeVersionId: draft._id },
  );
  const index = useFieldDefinitionIndex(currentOrganization?.organization._id, fields ?? []);
  const custom = usePaginatedQuery(
    api.fields.queries.listFieldDefinitions,
    currentOrganization === null ? 'skip' : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 200 },
  );
  const builtins = usePaginatedQuery(api.fields.queries.listBuiltinFieldDefinitions, {}, { initialNumItems: 200 });
  const add = useMutation(api.recipes.fields.mutations.addRecipeField);
  const update = useMutation(api.recipes.fields.mutations.updateRecipeField);
  const reorder = useMutation(api.recipes.fields.mutations.reorderRecipeFields);
  const remove = useMutation(api.recipes.fields.mutations.removeRecipeField);
  const [message, setMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RecipeField | null>(null);
  const canManage = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');

  async function action(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  if (recipeData === undefined) return null;
  if (recipeData.recipe.status === 'archived') return <BackNotice recipeId={recipeId} text={t('recipes.draftArchived')} />;
  if (draft === undefined) return <BackNotice recipeId={recipeId} text={t('recipes.draftMissing')} />;
  if (fields === undefined || index === undefined) return null;

  const used = new Set(fields.map((field) => field.fieldDefinitionId));
  const definitions = [...custom.results, ...builtins.results].filter(
    (definition) => definition.status === 'active' && !used.has(definition._id),
  );
  const checks = checkRecipeDraft(fields);

  return (
    <div className="flex flex-col gap-6">
      {message === null ? null : (
        <p role="alert" className="text-sm text-tone-stop">
          {message}
        </p>
      )}
      <Panel>
        <PanelHeader>
          <PanelTitle>{t('recipes.addField')}</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <p className="mb-3 text-xs text-ink-3">{t('recipes.fieldCount', { count: fields.length, max: 200 })}</p>
          {canManage && fields.length < 200 ? (
            <div className="flex flex-wrap gap-2">
              {definitions.map((definition) => (
                <Button
                  key={definition._id}
                  size="sm"
                  onClick={() =>
                    action(() =>
                      add({
                        recipeVersionId: draft._id,
                        fieldDefinitionId: definition._id,
                        required: false,
                        visible: true,
                      }),
                    )
                  }
                >
                  {builtinFieldLabel(locale, definition.semanticType, definition.label)} ·{' '}
                  {t(`fields.dataTypes.${definition.config.kind}`)}
                </Button>
              ))}
              {definitions.length === 0 ? <p className="text-sm text-ink-3">{t('recipes.noAvailableFields')}</p> : null}
            </div>
          ) : null}
        </PanelBody>
      </Panel>
      <p className="text-xs text-ink-3">{t('recipes.tightenRulesHelp')}</p>
      {fields.map((field, position) => {
        const definition = index.get(field.fieldDefinitionId);
        return (
          <RecipeFieldRow
            key={field._id}
            canManage={canManage}
            definition={definition}
            field={field}
            isFirst={position === 0}
            isLast={position === fields.length - 1}
            locale={locale}
            onMove={(offset) =>
              action(() =>
                reorder({
                  recipeVersionId: draft._id,
                  orderedRecipeFieldIds: fields.map((item, itemIndex) =>
                    itemIndex === position
                      ? fields[position + offset]!._id
                      : itemIndex === position + offset
                        ? field._id
                        : item._id,
                  ),
                }),
              )
            }
            onRemove={() => setRemoving(field)}
            onUpdate={(args) => action(() => update({ recipeFieldId: field._id, ...args }))}
            problems={checks.fieldProblems.get(field._id) ?? []}
          />
        );
      })}
      {removing === null ? null : (
        <Panel emphasis="focal">
          <PanelBody>
            <PanelTitle>{t('recipes.removeFieldTitle')}</PanelTitle>
            <p className="text-sm text-ink-2">{t('recipes.removeFieldWarning')}</p>
            <div className="mt-3 flex gap-2">
              <Button
                variant="danger"
                onClick={() =>
                  action(async () => {
                    await remove({ recipeFieldId: removing._id });
                    setRemoving(null);
                  })
                }
              >
                {t('recipes.removeFieldConfirm')}
              </Button>
              <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
            </div>
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}

function RecipeFieldRow({
  field,
  definition,
  canManage,
  isFirst,
  isLast,
  locale,
  onMove,
  onRemove,
  onUpdate,
  problems,
}: {
  field: RecipeField;
  definition: Definition | undefined;
  canManage: boolean;
  isFirst: boolean;
  isLast: boolean;
  locale: ReturnType<typeof useCanonicalLocale>;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
  onUpdate: (args: Omit<FunctionArgs<typeof api.recipes.fields.mutations.updateRecipeField>, 'recipeFieldId'>) => void;
  problems: readonly string[];
}) {
  const t = useTranslations();
  const [defaultState, setDefaultState] = useState<FieldValueFormState | null>(
    field.defaultValue === undefined ? null : fromEventFieldValue(field.defaultValue),
  );
  const [config, setConfig] = useState(field.config);
  const label =
    definition === undefined
      ? t('common.notAvailable')
      : builtinFieldLabel(locale, definition.semanticType, definition.label);
  function setRequired(required: boolean): void {
    onUpdate({ required, visible: required ? true : field.visible });
  }
  function problemMessage(problem: string): string {
    switch (problem) {
      case 'duplicateDefinition':
        return t('recipes.duplicateDefinition');
      case 'duplicatePosition':
        return t('recipes.duplicatePosition');
      case 'invalidPosition':
        return t('recipes.invalidPosition');
      case 'requiredHidden':
        return t('recipes.requiredHidden');
      default:
        return t('errors.generic');
    }
  }
  return (
    <Panel emphasis="inset">
      <PanelBody>
        <div className="flex flex-wrap items-center gap-2">
          <strong>{label}</strong>
          <span className="font-mono text-xs text-ink-3">{definition?.key}</span>
          <span className="text-xs text-ink-3">{t(`fields.dataTypes.${field.config.kind}`)}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label>
            <input
              type="checkbox"
              checked={field.required}
              disabled={!canManage}
              onChange={(event) => setRequired(event.target.checked)}
            />{' '}
            {t('recipes.requiredField')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={field.visible}
              disabled={!canManage || field.required}
              onChange={(event) => onUpdate({ visible: event.target.checked })}
            />{' '}
            {t('recipes.visibleField')}
          </label>
          <Button size="sm" disabled={!canManage || isFirst} onClick={() => onMove(-1)}>
            {t('recipes.moveUp')}
          </Button>
          <Button size="sm" disabled={!canManage || isLast} onClick={() => onMove(1)}>
            {t('recipes.moveDown')}
          </Button>
          <Button size="sm" variant="danger" disabled={!canManage} onClick={onRemove}>
            {t('recipes.removeField')}
          </Button>
        </div>
        <div className="mt-4 rounded-input border border-line p-3">
          <p className="text-micro font-semibold uppercase text-ink-3">{t('recipes.tightenRules')}</p>
          <p className="mb-3 text-xs text-ink-3">{t('recipes.tightenRulesVersionOnly')}</p>
          <FieldConfigEditor
            config={config}
            setConfig={(next) => {
              setConfig(next);
              onUpdate({ config: next });
            }}
            bound={definition?.config}
            disabled={!canManage || definition === undefined}
          />
        </div>
        <DefaultEditor
          config={field.config}
          state={defaultState}
          setState={setDefaultState}
          canManage={canManage}
          onClear={() => {
            setDefaultState(null);
            onUpdate({ defaultValue: null });
          }}
          onSave={() => {
            const value = defaultState === null ? undefined : toEventFieldValue(defaultState);
            if (value !== undefined) onUpdate({ defaultValue: value });
          }}
        />
        {problems.map((problem) => (
          <p key={problem} className="mt-2 text-xs text-tone-stop">
            {problemMessage(problem)}
          </p>
        ))}
      </PanelBody>
    </Panel>
  );
}

function DefaultEditor({
  config,
  state,
  setState,
  canManage,
  onClear,
  onSave,
}: {
  config: RecipeField['config'];
  state: FieldValueFormState | null;
  setState: (state: FieldValueFormState | null) => void;
  canManage: boolean;
  onClear: () => void;
  onSave: () => void;
}) {
  const t = useTranslations();
  const current = state?.kind === config.kind ? state : emptyFieldValueFormState(config.kind);
  const { currentOrganization } = useCurrentOrganization();
  return (
    <div className="mt-4 rounded-input border border-line p-3">
      <p className="text-micro font-semibold uppercase text-ink-3">{t('recipes.defaultValue')}</p>
      <DefaultControl
        config={config}
        state={current}
        onChange={setState}
        disabled={!canManage}
        organizationId={currentOrganization?.organization._id}
      />
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={!canManage} onClick={onSave}>
          {t('common.save')}
        </Button>
        <Button size="sm" disabled={!canManage || state === null} onClick={onClear}>
          {t('recipes.clearDefault')}
        </Button>
      </div>
      {config.kind === 'location' ? (
        <p className="mt-2 text-xs text-tone-stop">{t('recipes.locationDefaultWarning')}</p>
      ) : null}
    </div>
  );
}

function DefaultControl({
  config,
  state,
  onChange,
  disabled,
  organizationId,
}: {
  config: RecipeField['config'];
  state: FieldValueFormState;
  onChange: (state: FieldValueFormState) => void;
  disabled: boolean;
  organizationId: FunctionArgs<typeof api.locations.queries.listLocations>['organizationId'] | undefined;
}) {
  if (config.kind === 'boolean' && state.kind === 'boolean')
    return (
      <input
        type="checkbox"
        checked={state.value}
        disabled={disabled}
        onChange={(event) => onChange({ kind: 'boolean', value: event.target.checked })}
      />
    );
  if (
    (config.kind === 'text' ||
      config.kind === 'longText' ||
      config.kind === 'number' ||
      config.kind === 'date' ||
      config.kind === 'time') &&
    state.kind === config.kind
  )
    return (
      <input
        type={
          config.kind === 'number'
            ? 'number'
            : config.kind === 'date'
              ? 'date'
              : config.kind === 'time'
                ? 'time'
                : 'text'
        }
        value={state.value}
        disabled={disabled}
        onChange={(event) => onChange({ kind: config.kind, value: event.target.value })}
      />
    );
  if (config.kind === 'datetime' && state.kind === 'datetime')
    return (
      <span className="flex gap-2">
        <input
          type="date"
          value={state.date}
          disabled={disabled}
          onChange={(event) => onChange({ ...state, date: event.target.value })}
        />
        <input
          type="time"
          value={state.time}
          disabled={disabled}
          onChange={(event) => onChange({ ...state, time: event.target.value })}
        />
      </span>
    );
  if (config.kind === 'select' && state.kind === 'select')
    return (
      <select
        value={state.optionId}
        disabled={disabled}
        onChange={(event) => onChange({ kind: 'select', optionId: event.target.value })}
      >
        {config.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );
  if (config.kind === 'multiSelect' && state.kind === 'multiSelect')
    return (
      <select
        multiple
        value={state.optionIds}
        disabled={disabled}
        onChange={(event) =>
          onChange({
            kind: 'multiSelect',
            optionIds: Array.from(event.target.selectedOptions, (option) => option.value),
          })
        }
      >
        {config.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );
  if (config.kind === 'location' && state.kind === 'location')
    return organizationId === undefined ? null : (
      <LocationPicker
        organizationId={organizationId}
        value={state.locationId}
        disabled={disabled}
        onChange={(locationId) => onChange({ kind: 'location', locationId })}
      />
    );
  return null;
}

function BackNotice({ recipeId, text }: { recipeId: RecipeId; text: string }) {
  const t = useTranslations();

  return (
    <Panel>
      <PanelBody>
        <p className="text-sm text-ink-2">{text}</p>
        <Button className="mt-3" variant="link" render={<LocaleLink to={`/settings/recipes/${recipeId}`} />}>
          {t('recipes.backToRecipe')}
        </Button>
      </PanelBody>
    </Panel>
  );
}
