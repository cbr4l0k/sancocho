'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api } from '@sancocho/convex/api';

import { LocationPicker } from '@/components/locations/location-picker';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { useLocaleHref } from '@/i18n/locale-link';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import {
  emptyFieldValueFormState,
  fromEventFieldValue,
  toEventFieldValue,
  type FieldValueFormState,
} from '@/lib/field-value-form';
import { serviceFieldProblem } from '@/lib/service-form-checks';
import { timestampFromParts, type TimestampParts } from '@/lib/timestamps';
import { roleAtLeast } from '@/lib/roles';

type ProjectId = FunctionArgs<typeof api.projects.queries.getProject>['projectId'];
type RecipeField = FunctionReturnType<typeof api.recipes.fields.queries.listRecipeFields>[number];
type Project = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number];

export function ServiceCreateSurface({ initialProjectId }: { initialProjectId?: string }) {
  const t = useTranslations();
  const router = useRouter();
  const localeHref = useLocaleHref();
  const { currentOrganization } = useCurrentOrganization();
  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    currentOrganization === null ? 'skip' : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );
  const recipes = usePaginatedQuery(
    api.recipes.queries.listRecipes,
    currentOrganization === null ? 'skip' : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );
  const [projectId, setProjectId] = useState<ProjectId | undefined>();
  const [recipeVersionId, setRecipeVersionId] =
    useState<FunctionArgs<typeof api.recipes.fields.queries.listRecipeFields>['recipeVersionId']>();
  const [message, setMessage] = useState<string>();
  const canCreate = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');
  if (currentOrganization === null) return null;
  const selectedProject = projects.results.find((project) => project._id === (projectId ?? initialProjectId));
  const effectiveProjectId = projectId ?? selectedProject?._id;
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{t('services.eyebrow')}</p>
        <h1 className="text-display font-extrabold tracking-[-0.025em] text-ink">{t('services.createTitle')}</h1>
        <p className="text-sm text-ink-2">{t('services.createLead')}</p>
      </header>
      {!canCreate ? <p className="text-sm text-ink-3">{t('services.permissionNotice')}</p> : null}
      <Panel>
        <PanelHeader>
          <PanelTitle>{t('services.chooseProject')}</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <div className="flex flex-wrap gap-2">
            {projects.results.map((project) => (
              <ProjectChoice
                key={project._id}
                project={project}
                selected={project._id === effectiveProjectId}
                onSelect={() => {
                  setProjectId(project._id);
                  setRecipeVersionId(undefined);
                }}
              />
            ))}
          </div>
          {projects.status !== 'Exhausted' ? (
            <Button size="sm" onClick={() => projects.loadMore(25)}>
              {t('services.loadMore')}
            </Button>
          ) : null}
        </PanelBody>
      </Panel>
      {effectiveProjectId === undefined ||
      selectedProject?.status === 'completed' ||
      selectedProject?.status === 'archived' ? null : (
        <Panel>
          <PanelHeader>
            <PanelTitle>{t('services.chooseRecipe')}</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <div className="flex flex-col gap-2">
              {recipes.results.map((recipe) => (
                <RecipeChoice
                  key={recipe._id}
                  recipeId={recipe._id}
                  selectedVersionId={recipeVersionId}
                  onSelect={setRecipeVersionId}
                />
              ))}
            </div>
            {recipes.status !== 'Exhausted' ? (
              <Button size="sm" onClick={() => recipes.loadMore(25)}>
                {t('services.loadMore')}
              </Button>
            ) : null}
          </PanelBody>
        </Panel>
      )}
      {effectiveProjectId !== undefined && recipeVersionId !== undefined && canCreate ? (
        <ServiceForm
          organizationId={currentOrganization.organization._id}
          projectId={effectiveProjectId}
          recipeVersionId={recipeVersionId}
          onCreated={(id) => router.push(localeHref(`/services/${id}`))}
          onMessage={setMessage}
        />
      ) : null}
      {message === undefined ? null : (
        <p role="alert" className="text-sm text-tone-stop">
          {message}
        </p>
      )}
    </div>
  );
}

function ProjectChoice({ project, selected, onSelect }: { project: Project; selected: boolean; onSelect: () => void }) {
  const t = useTranslations();
  const unavailable = project.status === 'archived' || project.status === 'completed';
  return (
    <Button size="sm" selected={selected} disabled={unavailable} onClick={onSelect}>
      {project.name} <StatusChip kind="project" status={project.status} />
      {unavailable ? ` · ${t('services.projectUnavailable')}` : ''}
    </Button>
  );
}
function RecipeChoice({
  recipeId,
  selectedVersionId,
  onSelect,
}: {
  recipeId: FunctionArgs<typeof api.recipes.queries.getRecipe>['recipeId'];
  selectedVersionId: FunctionArgs<typeof api.recipes.fields.queries.listRecipeFields>['recipeVersionId'] | undefined;
  onSelect: (id: FunctionArgs<typeof api.recipes.fields.queries.listRecipeFields>['recipeVersionId']) => void;
}) {
  const data = useQuery(api.recipes.queries.getRecipe, { recipeId });
  const t = useTranslations();
  if (data === undefined) return null;
  const version = data.versions.find((item) => item.status === 'published');
  const unavailable = data.recipe.status === 'archived' || version === undefined;
  return (
    <Button
      size="sm"
      selected={version?._id === selectedVersionId}
      disabled={unavailable}
      onClick={() => (version === undefined ? undefined : onSelect(version._id))}
    >
      {data.recipe.name}
      {version === undefined ? ` · ${t('services.recipeUnavailable')}` : ` · v${version.versionNumber}`}
    </Button>
  );
}

function ServiceForm({
  organizationId,
  projectId,
  recipeVersionId,
  onCreated,
  onMessage,
}: {
  organizationId: FunctionArgs<typeof api.fields.queries.getFieldDefinitionsByIds>['organizationId'];
  projectId: ProjectId;
  recipeVersionId: FunctionArgs<typeof api.recipes.fields.queries.listRecipeFields>['recipeVersionId'];
  onCreated: (id: string) => void;
  onMessage: (message: string) => void;
}) {
  const t = useTranslations();
  const fields = useQuery(api.recipes.fields.queries.listRecipeFields, { recipeVersionId });
  const defs = useQuery(
    api.fields.queries.getFieldDefinitionsByIds,
    fields === undefined
      ? 'skip'
      : { organizationId, fieldDefinitionIds: fields.map((field) => field.fieldDefinitionId) },
  );
  const create = useMutation(api.events.mutations.createEventFromRecipe);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Map<string, FieldValueFormState>>(new Map());
  const [start, setStart] = useState<TimestampParts>({ date: '', time: '' });
  const [end, setEnd] = useState<TimestampParts>({ date: '', time: '' });
  if (fields === undefined || defs === undefined) return null;
  const loadedFields = fields;
  const definitions = new Map(defs.map((definition) => [definition._id, definition]));
  function state(field: RecipeField): FieldValueFormState {
    return (
      values.get(field.fieldDefinitionId) ??
      (field.defaultValue === undefined
        ? emptyFieldValueFormState(field.config.kind)
        : fromEventFieldValue(field.defaultValue))
    );
  }
  async function submit(): Promise<void> {
    const startsAt = timestampFromParts(start);
    const endsAt = end.date === '' && end.time === '' ? undefined : timestampFromParts(end);
    if (
      startsAt === undefined ||
      (endsAt === undefined && !(end.date === '' && end.time === '')) ||
      (endsAt !== undefined && endsAt < startsAt)
    ) {
      onMessage(t('errors.eventDatesInvalid'));
      return;
    }
    const submitted = loadedFields.flatMap((field) => {
      if (!field.visible) return [];
      const value = toEventFieldValue(state(field));
      return value === undefined ? [] : [{ fieldDefinitionId: field.fieldDefinitionId, value }];
    });
    for (const field of loadedFields) {
      if (!field.visible) continue;
      if (
        serviceFieldProblem(
          field.config,
          toEventFieldValue(state(field)),
          field.required,
          field.defaultValue !== undefined,
        ) !== undefined
      ) {
        onMessage(t('services.fieldInvalid'));
        return;
      }
    }
    try {
      onCreated(
        await create({
          projectId,
          recipeVersionId,
          name,
          startsAt,
          ...(endsAt === undefined ? {} : { endsAt }),
          values: submitted,
        }),
      );
    } catch (error) {
      onMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }
  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <PanelTitle>{t('services.serviceDetails')}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <div className="flex flex-col gap-4">
          <label>
            {t('services.name')}
            <input
              required
              className="ml-2 h-[38px] rounded-input border border-line bg-well px-3 text-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ServiceDateTime label={t('services.startsAt')} value={start} onChange={setStart} required />
          <ServiceDateTime label={t('services.endsAt')} value={end} onChange={setEnd} />
          {loadedFields
            .filter((field) => field.visible)
            .map((field) => (
              <ServiceDynamicField
                key={field._id}
                field={field}
                label={definitions.get(field.fieldDefinitionId)?.label ?? t('common.notAvailable')}
                value={state(field)}
                organizationId={organizationId}
                hasDefault={field.defaultValue !== undefined}
                onChange={(next) => setValues((old) => new Map(old).set(field.fieldDefinitionId, next))}
              />
            ))}
          <Button variant="primary" onClick={submit}>
            {t('services.create')}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}

export function ServiceDateTime({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: TimestampParts;
  onChange: (value: TimestampParts) => void;
  required?: boolean;
}) {
  return (
    <label className="flex flex-wrap gap-2 text-sm">
      {label}
      <input
        type="date"
        required={required}
        value={value.date}
        onChange={(event) => onChange({ ...value, date: event.target.value })}
      />
      <input
        type="time"
        required={required}
        value={value.time}
        onChange={(event) => onChange({ ...value, time: event.target.value })}
      />
    </label>
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
  organizationId: FunctionArgs<typeof api.locations.queries.listLocations>['organizationId'] | undefined;
  hasDefault?: boolean;
}) {
  const required = field.required && !hasDefault;
  if (field.config.kind === 'location' && value.kind === 'location' && organizationId !== undefined)
    return (
      <label>
        {label}
        <LocationPicker
          organizationId={organizationId}
          value={value.locationId}
          onChange={(locationId) => onChange({ kind: 'location', locationId })}
        />
      </label>
    );
  if (field.config.kind === 'boolean' && value.kind === 'boolean')
    return (
      <label>
        {label}
        <input
          type="checkbox"
          checked={value.value}
          onChange={(event) => onChange({ kind: 'boolean', value: event.target.checked })}
        />
      </label>
    );
  if (field.config.kind === 'select' && value.kind === 'select')
    return (
      <label>
        {label}
        <select
          required={required}
          value={value.optionId}
          onChange={(event) => onChange({ kind: 'select', optionId: event.target.value })}
        >
          <option value="" />
          {field.config.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  if (field.config.kind === 'multiSelect' && value.kind === 'multiSelect')
    return (
      <fieldset>
        <legend>{label}</legend>
        {field.config.options.map((option) => (
          <label key={option.id}>
            <input
              type="checkbox"
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
      </fieldset>
    );
  if (field.config.kind === 'datetime' && value.kind === 'datetime')
    return (
      <ServiceDateTime
        label={label}
        value={value}
        onChange={(next) => onChange({ kind: 'datetime', ...next })}
        required={required}
      />
    );
  if (
    (field.config.kind === 'text' ||
      field.config.kind === 'longText' ||
      field.config.kind === 'number' ||
      field.config.kind === 'date' ||
      field.config.kind === 'time') &&
    value.kind === field.config.kind
  )
    return (
      <label>
        {label}
        {field.required ? ' *' : ''}
        {field.config.kind === 'longText' ? (
          <textarea
            required={required}
            value={value.value}
            onChange={(event) => onChange({ kind: 'longText', value: event.target.value })}
          />
        ) : (
          <input
            required={required}
            type={
              field.config.kind === 'number'
                ? 'number'
                : field.config.kind === 'date'
                  ? 'date'
                  : field.config.kind === 'time'
                    ? 'time'
                    : 'text'
            }
            value={value.value}
            onChange={(event) => onChange({ kind: value.kind, value: event.target.value })}
          />
        )}
      </label>
    );
  return null;
}
