'use client';

import { useMutation, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';

import { api } from '@priamo/convex/api';

import { useFieldDefinitionIndex } from '@/components/fields/use-field-definition-index';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { Field, FieldControl, FieldLabel } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { Skeleton } from '@/components/ui/skeleton';
import { builtinFieldLabel } from '@/i18n/builtin-fields';
import { formatDateTime } from '@/i18n/formats';
import { LocaleLink } from '@/i18n/locale-link';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { checkServiceKindDraft, type DraftFieldProblem } from '@/lib/service-kind-draft-checks';
import { roleAtLeast } from '@/lib/roles';

type ServiceKindVersion = FunctionReturnType<
  typeof api.serviceKinds.queries.getServiceKind
>['versions'][number];
type ServiceKindField = FunctionReturnType<
  typeof api.serviceKinds.queries.getServiceKindVersion
>['serviceKindFields'][number];
type ServiceKindId = FunctionArgs<typeof api.serviceKinds.queries.getServiceKind>['serviceKindId'];
type Action = () => Promise<unknown>;
type OnAction = (run: Action) => Promise<void>;

export function ServiceKindDetailSurface({ serviceKindId }: { serviceKindId: ServiceKindId }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const serviceKindData = useQuery(api.serviceKinds.queries.getServiceKind, { serviceKindId });
  const createDraft = useMutation(api.serviceKinds.mutations.createInitialDraftVersion);
  const cloneDraft = useMutation(api.serviceKinds.mutations.clonePublishedVersionToDraft);
  const publish = useMutation(api.serviceKinds.mutations.publishServiceKindVersion);
  const archive = useMutation(api.serviceKinds.mutations.archiveServiceKind);
  const update = useMutation(api.serviceKinds.mutations.updateServiceKindMetadata);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canManage =
    currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');

  if (serviceKindData === undefined) return null;

  const { serviceKind, versions } = serviceKindData;
  const draft = versions.find((version) => version.status === 'draft');
  const published = versions.find((version) => version.status === 'published');
  const sorted = [...versions].sort(
    (left, right) => right.versionNumber - left.versionNumber,
  );

  async function action(run: Action): Promise<void> {
    try {
      await run();
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action(() =>
      update({
        serviceKindId: serviceKind._id,
        name: String(form.get('name') ?? ''),
        description: String(form.get('description') ?? ''),
      }),
    );
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        badge={<StatusChip emphasis="loud" kind="serviceKind" status={serviceKind.status} />}
        actions={
          canManage && serviceKind.status !== 'archived' && !editing ? (
            <>
              <Button onClick={() => setEditing(true)}>{t('serviceKinds.edit')}</Button>
              <Button variant="danger" onClick={() => setConfirming(true)}>
                {t('serviceKinds.archive')}
              </Button>
            </>
          ) : undefined
        }
      />
      {message === null ? null : <AlertMessage>{message}</AlertMessage>}
      {serviceKind.status === 'archived' ? (
        <Notice>{t('serviceKinds.archivedNotice')}</Notice>
      ) : null}
      {editing ? (
        <MetadataForm
          description={serviceKind.description}
          name={serviceKind.name}
          onClose={() => setEditing(false)}
          onSubmit={saveMetadata}
        />
      ) : (
        /* The key and description are the service kind's own data, so they belong in a
         * panel with the rest of it — not stacked under the page title where
         * they read as chrome explaining the screen. */
        <Panel>
          <PanelBody className="gap-2 text-sm text-ink-2">
            <p className="font-mono text-xs text-ink-3">{serviceKind.key}</p>
            {serviceKind.description === undefined ? null : <p className="text-ink">{serviceKind.description}</p>}
          </PanelBody>
        </Panel>
      )}
      {confirming ? (
        <Confirmation
          onCancel={() => setConfirming(false)}
          onConfirm={() => action(() => archive({ serviceKindId: serviceKind._id }))}
        />
      ) : null}
      <LifecycleActions
        archived={serviceKind.status === 'archived'}
        canManage={canManage}
        cloneDraft={cloneDraft}
        createDraft={createDraft}
        draft={draft}
        onAction={action}
        published={published}
        publish={publish}
        serviceKindId={serviceKind._id}
      />
      <Panel>
        <PanelHeader>
          <PanelTitle>{t('serviceKinds.versionsTitle')}</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <p className="text-sm text-ink-2">{t('serviceKinds.immutableNotice')}</p>
          {sorted.length === 0 ? (
            <p className="text-sm text-ink-3">{t('serviceKinds.noVersions')}</p>
          ) : (
            sorted.map((version) => (
              <VersionCard
                key={version._id}
                current={version.status === 'published'}
                version={version}
              />
            ))
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

function LifecycleActions({
  serviceKindId,
  draft,
  published,
  archived,
  canManage,
  createDraft,
  cloneDraft,
  publish,
  onAction,
}: {
  serviceKindId: ServiceKindId;
  draft: ServiceKindVersion | undefined;
  published: ServiceKindVersion | undefined;
  archived: boolean;
  canManage: boolean;
  createDraft: ReturnType<
    typeof useMutation<typeof api.serviceKinds.mutations.createInitialDraftVersion>
  >;
  cloneDraft: ReturnType<
    typeof useMutation<typeof api.serviceKinds.mutations.clonePublishedVersionToDraft>
  >;
  publish: ReturnType<
    typeof useMutation<typeof api.serviceKinds.mutations.publishServiceKindVersion>
  >;
  onAction: OnAction;
}) {
  const t = useTranslations();

  if (!canManage || archived) return null;
  if (draft !== undefined) {
    return <DraftActions draft={draft} onAction={onAction} publish={publish} serviceKindId={serviceKindId} />;
  }
  if (published !== undefined) {
    return (
      <Button
        variant="primary"
        onClick={() => onAction(() => cloneDraft({ serviceKindId }))}
      >
        {t('serviceKinds.newVersionFrom', { version: published.versionNumber })}
      </Button>
    );
  }
  return (
    <Button variant="primary" onClick={() => onAction(() => createDraft({ serviceKindId }))}>
      {t('serviceKinds.createFirstDraft')}
    </Button>
  );
}

function DraftActions({
  draft,
  serviceKindId,
  publish,
  onAction,
}: {
  draft: ServiceKindVersion;
  serviceKindId: ServiceKindId;
  publish: ReturnType<
    typeof useMutation<typeof api.serviceKinds.mutations.publishServiceKindVersion>
  >;
  onAction: OnAction;
}) {
  const t = useTranslations();
  const details = useQuery(api.serviceKinds.queries.getServiceKindVersion, {
    serviceKindVersionId: draft._id,
  });
  const checks = checkServiceKindDraft(details?.serviceKindFields ?? []);
  const blocked = checks.empty || checks.fieldProblems.size > 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        disabled={blocked}
        variant="primary"
        onClick={() => onAction(() => publish({ serviceKindVersionId: draft._id }))}
      >
        {t('serviceKinds.publishDraft')}
      </Button>
      <Button render={<LocaleLink to={`/settings/service-kinds/${serviceKindId}/draft`} />}>
        {t('serviceKinds.draftEditor')}
      </Button>
    </div>
  );
}

function VersionCard({ version, current }: { version: ServiceKindVersion; current: boolean }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const details = useQuery(api.serviceKinds.queries.getServiceKindVersion, {
    serviceKindVersionId: version._id,
  });
  const index = useFieldDefinitionIndex(
    currentOrganization === null ? undefined : currentOrganization.organization._id,
    details?.serviceKindFields ?? [],
  );
  const checks = checkServiceKindDraft(details?.serviceKindFields ?? []);

  return (
    <Panel emphasis={version.status === 'draft' ? 'inset' : 'module'}>
      <PanelHeader>
        <div className="flex flex-wrap items-center gap-2">
          <PanelTitle>v{version.versionNumber}</PanelTitle>
          <StatusChip kind="serviceKindVersion" status={version.status} />
          {current ? <CurrentBadge>{t('serviceKinds.current')}</CurrentBadge> : null}
          {version.status !== 'draft' ? <LockedBadge>{t('serviceKinds.locked')}</LockedBadge> : null}
        </div>
        <span className="text-xs text-ink-3">
          {version.publishedAt === undefined ? t('serviceKinds.created') : t('serviceKinds.published')}:{' '}
          {formatDateTime(locale, version.publishedAt ?? version._creationTime)}
        </span>
      </PanelHeader>
      <PanelBody>
        {details === undefined ? null : index === undefined ? (
          <VersionContentsSkeleton fields={details.serviceKindFields} />
        ) : (
          <VersionContents
            fields={details.serviceKindFields}
            index={index}
            problems={checks.fieldProblems}
          />
        )}
      </PanelBody>
    </Panel>
  );
}

function VersionContentsSkeleton({ fields }: { fields: readonly ServiceKindField[] }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      {fields.map((field) => (
        <div key={field._id} className="rounded-input border border-line bg-ground-2/60 p-3">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="mt-2 h-3 w-2/5" />
        </div>
      ))}
    </div>
  );
}

function VersionContents({
  fields,
  index,
  problems,
}: {
  fields: readonly ServiceKindField[];
  index: NonNullable<ReturnType<typeof useFieldDefinitionIndex>>;
  problems: ReadonlyMap<string, readonly DraftFieldProblem[]>;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-bold text-ink">{t('serviceKinds.contentsTitle')}</h3>
      {fields.map((field) => {
        const definition = index.get(field.fieldDefinitionId);
        const label =
          definition === undefined
            ? t('common.notAvailable')
            : builtinFieldLabel(locale, definition.semanticType, definition.label);

        return (
          <div key={field._id} className="rounded-input border border-line bg-ground-2/60 p-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink">
              <span className="font-mono text-xs">{field.position}</span>
              <span>{label}</span>
              {definition === undefined ? null : (
                <span className="font-mono text-xs text-ink-3">{definition.key}</span>
              )}
              <span>
                {t('serviceKinds.requiredField')}: {field.required ? t('serviceKinds.yes') : t('serviceKinds.no')}
              </span>
              <span>
                {t('serviceKinds.visibleField')}: {field.visible ? t('serviceKinds.yes') : t('serviceKinds.no')}
              </span>
            </div>
            <p className="mt-2 text-xs text-ink-2">
              {t('serviceKinds.rules')}: {field.config.kind}
            </p>
            {definition === undefined ? (
              <p className="mt-2 text-xs text-tone-stop">
                {t('serviceKinds.definitionUnresolved')}
              </p>
            ) : null}
            {(problems.get(field._id) ?? []).map((problem) => (
              <p key={problem} className="mt-1 text-xs text-tone-stop">
                {t(`serviceKinds.${problem}`)}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function MetadataForm({
  name,
  description,
  onSubmit,
  onClose,
}: {
  name: string;
  description: string | undefined;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const t = useTranslations();

  return (
    <Panel emphasis="focal">
      <PanelBody>
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <Field>
            <FieldLabel>{t('serviceKinds.name')}</FieldLabel>
            <FieldControl defaultValue={name} name="name" required />
          </Field>
          <Field>
            <FieldLabel>{t('serviceKinds.description')}</FieldLabel>
            <FieldControl defaultValue={description} name="description" />
          </Field>
          <ActionGroup>
            <Button type="submit" variant="primary">
              {t('serviceKinds.save')}
            </Button>
            <Button type="button" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </ActionGroup>
        </form>
      </PanelBody>
    </Panel>
  );
}

function Confirmation({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations();

  return (
    <Panel emphasis="focal">
      <PanelBody>
        <PanelTitle>{t('serviceKinds.archiveTitle')}</PanelTitle>
        <p className="text-sm text-ink-2">{t('serviceKinds.archiveWarning')}</p>
        <ActionGroup>
          <Button variant="danger" onClick={onConfirm}>
            {t('serviceKinds.archiveConfirm')}
          </Button>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
        </ActionGroup>
      </PanelBody>
    </Panel>
  );
}

function ActionGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

function AlertMessage({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop"
    >
      {children}
    </p>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-input border border-line bg-ground-2 px-4 py-3 text-sm text-ink-2">
      {children}
    </p>
  );
}

function CurrentBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-pill bg-ground-3 px-2 py-1 text-micro font-semibold text-ink">
      {children}
    </span>
  );
}

function LockedBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-pill border border-line px-2 py-1 text-micro font-semibold text-ink-2">
      {children}
    </span>
  );
}
