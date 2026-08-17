'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@sancocho/convex/api';
import { auditActionMessageKey } from '@/i18n/vocab-keys';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ServiceDateTime, ServiceDynamicField } from '@/components/services/service-fields';
import { ServiceRelationships } from '@/components/services/service-relationships';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { formatDate, formatDateTime, formatNumber, formatTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import {
  emptyFieldValueFormState,
  fromEventFieldValue,
  toEventFieldValue,
  type EventFieldValue,
  type FieldValueFormState,
} from '@/lib/field-value-form';
import { roleAtLeast } from '@/lib/roles';
import { serviceFieldProblem } from '@/lib/service-form-checks';
import { legalNextServiceStatuses } from '@/lib/service-transitions';
import { changedEventFieldValues } from '@/lib/service-value-diff';
import { timestampFromParts, timestampToParts, type TimestampParts } from '@/lib/timestamps';

type EventId = FunctionArgs<typeof api.events.queries.getEvent>['eventId'];
type EventData = FunctionReturnType<typeof api.events.queries.getEvent>;
type RecipeVersionData = FunctionReturnType<typeof api.recipes.queries.getRecipeVersion>;

export function ServiceDetailSurface({ eventId }: { eventId: EventId }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const data = useQuery(api.events.queries.getEvent, { eventId });
  const project = useQuery(
    api.projects.queries.getProject,
    data === undefined ? 'skip' : { projectId: data.event.projectId },
  );
  const version = useQuery(
    api.recipes.queries.getRecipeVersion,
    data === undefined ? 'skip' : { recipeVersionId: data.event.recipeVersionId },
  );
  const updateCore = useMutation(api.events.mutations.updateEventCoreFields);
  const updateFields = useMutation(api.events.mutations.updateEventFields);
  const changeStatus = useMutation(api.events.mutations.changeEventStatus);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (data === undefined || project === undefined || version === undefined || currentOrganization === null) return null;
  const frozenByProject = project.status === 'archived';
  const terminal = data.event.status === 'completed' || data.event.status === 'cancelled';
  const canEdit = roleAtLeast(currentOrganization.role, 'planner') && !frozenByProject && !terminal;
  const canOperate = roleAtLeast(currentOrganization.role, 'operator') && !frozenByProject && !terminal;
  async function transition(status: EventData['event']['status']): Promise<void> {
    try {
      await changeStatus({ eventId, status });
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }
  return (
    /* The editor replaces the read-only panels in place, rather than being
     * appended after them: three panels of detail is more than a screen, so an
     * edit form rendered below them opened out of sight. */
    <div className="flex flex-col gap-6">
      <PageHeader
        title={data.event.name}
        badge={<StatusChip emphasis="loud" kind="service" status={data.event.status} />}
        actions={
          canEdit && !editing ? <Button onClick={() => setEditing(true)}>{t('services.edit')}</Button> : undefined
        }
      />
      {message === null ? null : <Alert>{message}</Alert>}
      {frozenByProject ? (
        <Notice>{t('services.projectFrozenNotice')}</Notice>
      ) : terminal ? (
        <Notice>{t('services.terminalNotice')}</Notice>
      ) : null}
      {editing ? (
        <ServiceEditor
          key={data.event._id}
          data={data}
          version={version}
          onClose={() => setEditing(false)}
          onMessage={setMessage}
          updateCore={updateCore}
          updateFields={updateFields}
        />
      ) : (
        <>
          <ServiceCoreDetails data={data} />
          <RecipeVersionPanel version={version} />
          <ServiceValues data={data} version={version} />
          <ServiceRelationships eventId={data.event._id} canEdit={canEdit} />
        </>
      )}
      {canOperate ? <StatusControls status={data.event.status} onTransition={transition} /> : null}
      <AuditPanel
        organizationId={data.event.organizationId}
        eventId={data.event._id}
        enabled={roleAtLeast(currentOrganization.role, 'admin')}
      />
    </div>
  );
}

function ServiceCoreDetails({ data }: { data: EventData }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('services.serviceDetails')}</PanelTitle>
      </PanelHeader>
      <PanelBody className="gap-2 text-sm text-ink-2">
        <p>
          <span className="text-ink-3">{t('services.startsAt')} </span>
          {formatDateTime(locale, data.event.startsAt)}
        </p>
        <p>
          <span className="text-ink-3">{t('services.endsAt')} </span>
          {data.event.endsAt === undefined ? t('services.notSet') : formatDateTime(locale, data.event.endsAt)}
        </p>
      </PanelBody>
    </Panel>
  );
}

function RecipeVersionPanel({ version }: { version: RecipeVersionData }) {
  const t = useTranslations();
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('services.recipeVersionTitle')}</PanelTitle>
        <PanelDescription>{t('services.recipeVersionDescription')}</PanelDescription>
      </PanelHeader>
      <PanelBody className="gap-2 text-sm text-ink-2">
        <p>{t('services.recipeVersionNumber', { version: version.version.versionNumber })}</p>
        <StatusChip kind="recipeVersion" status={version.version.status} />
        {version.version.status === 'retired' ? <p>{t('services.recipeVersionRetired')}</p> : null}
      </PanelBody>
    </Panel>
  );
}

function ServiceValues({ data, version }: { data: EventData; version: RecipeVersionData }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const values = new Map(data.values.map((value) => [value.fieldDefinitionId, value]));
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('services.valuesTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody className="gap-4">
        {version.recipeFields
          .filter((field) => field.visible)
          .map((field) => {
            const item = values.get(field.fieldDefinitionId);
            return (
              <div key={field._id} className="flex flex-col gap-1">
                <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
                  {item?.label ?? t('common.notAvailable')}
                </p>
                <p className="text-sm text-ink-2">
                  {item === undefined ? t('services.notSet') : formatValue(locale, field.config, item.value)}
                </p>
              </div>
            );
          })}
      </PanelBody>
    </Panel>
  );
}

function formatValue(
  locale: ReturnType<typeof useCanonicalLocale>,
  config: RecipeVersionData['recipeFields'][number]['config'],
  value: EventFieldValue,
): string {
  switch (value.kind) {
    case 'text':
    case 'longText':
      return value.value;
    case 'number':
      return formatNumber(locale, value.value);
    case 'boolean':
      return value.value ? '✓' : '—';
    case 'date':
      return formatDate(locale, value.value);
    case 'datetime':
      return formatDateTime(locale, value.value);
    case 'time':
      return formatTime(locale, value.value);
    case 'select':
      return config.kind === 'select'
        ? (config.options.find((option) => option.id === value.optionId)?.label ?? value.optionId)
        : value.optionId;
    case 'multiSelect':
      return config.kind === 'multiSelect'
        ? value.optionIds.map((id) => config.options.find((option) => option.id === id)?.label ?? id).join(', ')
        : value.optionIds.join(', ');
    case 'location':
      return value.locationId;
  }
}

function StatusControls({
  status,
  onTransition,
}: {
  status: EventData['event']['status'];
  onTransition: (status: EventData['event']['status']) => Promise<void>;
}) {
  const t = useTranslations();
  const next = legalNextServiceStatuses(status);
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('services.statusActions')}</PanelTitle>
      </PanelHeader>
      <PanelBody className="flex-row flex-wrap">
        {next.map((item) => (
          <Button key={item} variant={item === 'cancelled' ? 'danger' : 'secondary'} onClick={() => onTransition(item)}>
            {item === 'cancelled'
              ? t('services.cancel')
              : t('services.advanceTo', { status: t(`services.statuses.${item}`) })}
          </Button>
        ))}
      </PanelBody>
    </Panel>
  );
}

function ServiceEditor({
  data,
  version,
  onClose,
  onMessage,
  updateCore,
  updateFields,
}: {
  data: EventData;
  version: RecipeVersionData;
  onClose: () => void;
  onMessage: (message: string) => void;
  updateCore: ReturnType<typeof useMutation<typeof api.events.mutations.updateEventCoreFields>>;
  updateFields: ReturnType<typeof useMutation<typeof api.events.mutations.updateEventFields>>;
}) {
  const t = useTranslations();
  const original = new Map(data.values.map((item) => [item.fieldDefinitionId, item.value]));
  const [name, setName] = useState(data.event.name);
  const [start, setStart] = useState<TimestampParts>(timestampToParts(data.event.startsAt));
  const [end, setEnd] = useState<TimestampParts>(
    data.event.endsAt === undefined ? { date: '', time: '' } : timestampToParts(data.event.endsAt),
  );
  const [states, setStates] = useState<Map<EventData['values'][number]['fieldDefinitionId'], FieldValueFormState>>(
    new Map(),
  );
  function state(field: RecipeVersionData['recipeFields'][number]): FieldValueFormState {
    const changed = states.get(field.fieldDefinitionId);
    if (changed !== undefined) return changed;
    const stored = original.get(field.fieldDefinitionId);
    return stored === undefined ? emptyFieldValueFormState(field.config.kind) : fromEventFieldValue(stored);
  }
  async function save(): Promise<void> {
    const startsAt = timestampFromParts(start);
    const endBlank = end.date === '' && end.time === '';
    const endsAt = endBlank ? undefined : timestampFromParts(end);
    if (startsAt === undefined || (!endBlank && endsAt === undefined) || (endsAt !== undefined && endsAt < startsAt)) {
      onMessage(t('errors.eventDatesInvalid'));
      return;
    }
    const edited = new Map(
      version.recipeFields
        .filter((field) => field.visible)
        .map((field) => [field.fieldDefinitionId, toEventFieldValue(state(field))]),
    );
    for (const field of version.recipeFields.filter((item) => item.visible))
      if (serviceFieldProblem(field.config, edited.get(field.fieldDefinitionId), field.required, false) !== undefined) {
        onMessage(t('services.fieldInvalid'));
        return;
      }
    const changes = changedEventFieldValues(original, edited);
    try {
      const core = {
        eventId: data.event._id,
        ...(name === data.event.name ? {} : { name }),
        ...(startsAt === data.event.startsAt ? {} : { startsAt }),
        ...(endsAt === data.event.endsAt ? {} : { endsAt: endsAt ?? null }),
      };
      if (Object.keys(core).length > 1) await updateCore(core);
      if (changes.length > 0) await updateFields({ eventId: data.event._id, values: changes });
      onClose();
    } catch (error) {
      onMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }
  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <PanelTitle>{t('services.editTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <div className="flex flex-col gap-4">
          <label>
            {t('services.name')}
            <input
              className="ml-2 h-[38px] rounded-input border border-line bg-well px-3 text-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ServiceDateTime label={t('services.startsAt')} value={start} onChange={setStart} required />
          <ServiceDateTime label={t('services.endsAt')} value={end} onChange={setEnd} />
          {version.recipeFields
            .filter((field) => field.visible)
            .map((field) => (
              <ServiceDynamicField
                key={field._id}
                field={field}
                label={
                  data.values.find((value) => value.fieldDefinitionId === field.fieldDefinitionId)?.label ??
                  t('common.notAvailable')
                }
                value={state(field)}
                organizationId={data.event.organizationId}
                onChange={(next) => setStates((old) => new Map(old).set(field.fieldDefinitionId, next))}
              />
            ))}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={save}>
              {t('services.save')}
            </Button>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function AuditPanel({
  organizationId,
  eventId,
  enabled,
}: {
  organizationId: EventData['event']['organizationId'];
  eventId: EventId;
  enabled: boolean;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const audits = usePaginatedQuery(
    api.audit.queries.listEntityAuditEvents,
    enabled ? { organizationId, entityType: 'event', entityId: eventId } : 'skip',
    { initialNumItems: 25 },
  );
  if (!enabled) return null;
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('services.auditTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        {audits.results.map((audit) => (
          <p key={audit._id} className="text-sm text-ink-2">
            {formatDateTime(locale, audit._creationTime)} ·{' '}
            {t(`vocab.auditActions.${auditActionMessageKey[audit.action]}`)}
          </p>
        ))}
        {audits.status !== 'Exhausted' ? (
          <Button size="sm" onClick={() => audits.loadMore(25)}>
            {t('services.loadMore')}
          </Button>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function Notice({ children }: { children: string }) {
  return <p className="rounded-input border border-line px-4 py-3 text-sm text-ink-2">{children}</p>;
}
function Alert({ children }: { children: string }) {
  return (
    <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">
      {children}
    </p>
  );
}
