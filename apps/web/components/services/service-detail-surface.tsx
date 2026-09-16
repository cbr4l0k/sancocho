'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';
import { auditActionMessageKey } from '@/i18n/vocab-keys';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { AssignmentsPanel } from '@/components/assignments/assignments-panel';
import { ProjectWindowHint, ServiceDateTime, ServiceDynamicField } from '@/components/services/service-fields';
import { ServiceRelationships } from '@/components/services/service-relationships';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { formatFieldValue } from '@/lib/field-value-format';
import { projectWindowDateBounds, projectWindowProblem } from '@/lib/project-window';
import {
  emptyFieldValueFormState,
  fromServiceFieldValue,
  toServiceFieldValue,
  type FieldValueFormState,
} from '@/lib/field-value-form';
import { roleAtLeast } from '@/lib/roles';
import { serviceFieldProblem } from '@/lib/service-form-checks';
import { legalNextServiceStatuses } from '@/lib/service-transitions';
import { changedServiceFieldValues } from '@/lib/service-value-diff';
import { timestampFromParts, timestampToParts, type TimestampParts } from '@/lib/timestamps';

type ServiceId = FunctionArgs<typeof api.services.queries.getService>['serviceId'];
type ServiceData = FunctionReturnType<typeof api.services.queries.getService>;
type ServiceKindVersionData = FunctionReturnType<typeof api.serviceKinds.queries.getServiceKindVersion>;
type ProjectData = FunctionReturnType<typeof api.projects.queries.getProject>;

export function ServiceDetailSurface({ serviceId }: { serviceId: ServiceId }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const data = useQuery(api.services.queries.getService, { serviceId });
  const project = useQuery(
    api.projects.queries.getProject,
    data === undefined ? 'skip' : { projectId: data.service.projectId },
  );
  const version = useQuery(
    api.serviceKinds.queries.getServiceKindVersion,
    data === undefined ? 'skip' : { serviceKindVersionId: data.service.serviceKindVersionId },
  );
  const updateCore = useMutation(api.services.mutations.updateServiceCoreFields);
  const updateFields = useMutation(api.services.mutations.updateServiceFields);
  const changeStatus = useMutation(api.services.mutations.changeServiceStatus);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (data === undefined || project === undefined || version === undefined || currentOrganization === null) return null;
  const frozenByProject = project.status === 'archived';
  const terminal = data.service.status === 'completed' || data.service.status === 'cancelled';
  const canEdit = roleAtLeast(currentOrganization.role, 'planner') && !frozenByProject && !terminal;
  const canOperate = roleAtLeast(currentOrganization.role, 'operator') && !frozenByProject && !terminal;
  async function transition(status: ServiceData['service']['status']): Promise<void> {
    try {
      await changeStatus({ serviceId, status });
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
        badge={<StatusChip emphasis="loud" kind="service" status={data.service.status} />}
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
          key={data.service._id}
          data={data}
          version={version}
          project={project}
          onClose={() => setEditing(false)}
          onMessage={setMessage}
          updateCore={updateCore}
          updateFields={updateFields}
        />
      ) : (
        <>
          <AssignmentsPanel serviceId={data.service._id} serviceWritable={canEdit} />
          <ServiceCoreDetails data={data} />
          <ServiceKindVersionPanel version={version} />
          <ServiceValues data={data} version={version} />
          <ServiceRelationships serviceId={data.service._id} canEdit={canEdit} />
        </>
      )}
      {canOperate ? <StatusControls status={data.service.status} onTransition={transition} /> : null}
      <AuditPanel
        organizationId={data.service.organizationId}
        serviceId={data.service._id}
        enabled={roleAtLeast(currentOrganization.role, 'admin')}
      />
    </div>
  );
}

function ServiceCoreDetails({ data }: { data: ServiceData }) {
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
          {formatDateTime(locale, data.service.startsAt)}
        </p>
        <p>
          <span className="text-ink-3">{t('services.endsAt')} </span>
          {data.service.endsAt === undefined ? t('services.notSet') : formatDateTime(locale, data.service.endsAt)}
        </p>
      </PanelBody>
    </Panel>
  );
}

function ServiceKindVersionPanel({ version }: { version: ServiceKindVersionData }) {
  const t = useTranslations();
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('services.serviceKindVersionTitle')}</PanelTitle>
        <PanelDescription>{t('services.serviceKindVersionDescription')}</PanelDescription>
      </PanelHeader>
      <PanelBody className="gap-2 text-sm text-ink-2">
        <p>{t('services.serviceKindVersionNumber', { version: version.version.versionNumber })}</p>
        <StatusChip kind="serviceKindVersion" status={version.version.status} />
        {version.version.status === 'retired' ? <p>{t('services.serviceKindVersionRetired')}</p> : null}
      </PanelBody>
    </Panel>
  );
}

function ServiceValues({ data, version }: { data: ServiceData; version: ServiceKindVersionData }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const values = new Map(data.values.map((value) => [value.fieldDefinitionId, value]));
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('services.valuesTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody className="gap-4">
        {version.serviceKindFields
          .filter((field) => field.visible)
          .map((field) => {
            const item = values.get(field.fieldDefinitionId);
            return (
              <div key={field._id} className="flex flex-col gap-1">
                <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
                  {item?.label ?? t('common.notAvailable')}
                </p>
                <p className="text-sm text-ink-2">
                  {item === undefined
                    ? t('services.notSet')
                    : formatFieldValue(locale, field.config, item.value, t('common.notAvailable'), item.locationName)}
                </p>
              </div>
            );
          })}
      </PanelBody>
    </Panel>
  );
}

function StatusControls({
  status,
  onTransition,
}: {
  status: ServiceData['service']['status'];
  onTransition: (status: ServiceData['service']['status']) => Promise<void>;
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
  project,
  onClose,
  onMessage,
  updateCore,
  updateFields,
}: {
  data: ServiceData;
  version: ServiceKindVersionData;
  project: ProjectData;
  onClose: () => void;
  onMessage: (message: string) => void;
  updateCore: ReturnType<typeof useMutation<typeof api.services.mutations.updateServiceCoreFields>>;
  updateFields: ReturnType<typeof useMutation<typeof api.services.mutations.updateServiceFields>>;
}) {
  const t = useTranslations();
  const original = new Map(data.values.map((item) => [item.fieldDefinitionId, item.value]));
  const [name, setName] = useState(data.service.name);
  const [start, setStart] = useState<TimestampParts>(timestampToParts(data.service.startsAt));
  const [end, setEnd] = useState<TimestampParts>(
    data.service.endsAt === undefined ? { date: '', time: '' } : timestampToParts(data.service.endsAt),
  );
  const [states, setStates] = useState<Map<ServiceData['values'][number]['fieldDefinitionId'], FieldValueFormState>>(
    new Map(),
  );
  function state(field: ServiceKindVersionData['serviceKindFields'][number]): FieldValueFormState {
    const changed = states.get(field.fieldDefinitionId);
    if (changed !== undefined) return changed;
    const stored = original.get(field.fieldDefinitionId);
    return stored === undefined ? emptyFieldValueFormState(field.config.kind) : fromServiceFieldValue(stored);
  }
  async function save(): Promise<void> {
    const startsAt = timestampFromParts(start);
    const endBlank = end.date === '' && end.time === '';
    const endsAt = endBlank ? undefined : timestampFromParts(end);
    if (startsAt === undefined || (!endBlank && endsAt === undefined) || (endsAt !== undefined && endsAt < startsAt)) {
      onMessage(t('errors.serviceDatesInvalid'));
      return;
    }
    // The project's window is the second date rule, and the one this screen
    // used to ignore entirely: a service could be moved outside its project
    // and only the server would ever have objected — except it did not either.
    const outside = projectWindowProblem(project, startsAt, endsAt);
    if (outside !== undefined) {
      onMessage(t(outside === 'before' ? 'errors.serviceBeforeProjectWindow' : 'errors.serviceAfterProjectWindow'));
      return;
    }
    const edited = new Map(
      version.serviceKindFields
        .filter((field) => field.visible)
        .map((field) => [field.fieldDefinitionId, toServiceFieldValue(state(field))]),
    );
    for (const field of version.serviceKindFields.filter((item) => item.visible))
      if (serviceFieldProblem(field.config, edited.get(field.fieldDefinitionId), field.required, false) !== undefined) {
        onMessage(t('services.fieldInvalid'));
        return;
      }
    const changes = changedServiceFieldValues(original, edited);
    try {
      const core = {
        serviceId: data.service._id,
        ...(name === data.service.name ? {} : { name }),
        ...(startsAt === data.service.startsAt ? {} : { startsAt }),
        ...(endsAt === data.service.endsAt ? {} : { endsAt: endsAt ?? null }),
      };
      if (Object.keys(core).length > 1) await updateCore(core);
      if (changes.length > 0) await updateFields({ serviceId: data.service._id, values: changes });
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
          <ProjectWindowHint project={project} />
          <ServiceDateTime
            label={t('services.startsAt')}
            value={start}
            onChange={setStart}
            required
            bounds={projectWindowDateBounds(project)}
          />
          <ServiceDateTime
            label={t('services.endsAt')}
            value={end}
            onChange={setEnd}
            bounds={projectWindowDateBounds(project)}
          />
          {version.serviceKindFields
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
                organizationId={data.service.organizationId}
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
  serviceId,
  enabled,
}: {
  organizationId: ServiceData['service']['organizationId'];
  serviceId: ServiceId;
  enabled: boolean;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const audits = usePaginatedQuery(
    api.audit.queries.listEntityAuditEvents,
    enabled ? { organizationId, entityType: 'service', entityId: serviceId } : 'skip',
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
