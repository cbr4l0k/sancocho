'use client';

import { useMutation, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';

import { api } from '@sancocho/convex/api';

import { useFieldDefinitionIndex } from '@/components/fields/use-field-definition-index';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { Field, FieldControl, FieldLabel } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { Skeleton } from '@/components/ui/skeleton';
import { builtinFieldLabel } from '@/i18n/builtin-fields';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { checkRecipeDraft, type DraftFieldProblem } from '@/lib/recipe-draft-checks';
import { roleAtLeast } from '@/lib/roles';

type RecipeVersion = FunctionReturnType<
  typeof api.recipes.queries.getRecipe
>['versions'][number];
type RecipeField = FunctionReturnType<
  typeof api.recipes.queries.getRecipeVersion
>['recipeFields'][number];
type RecipeId = FunctionArgs<typeof api.recipes.queries.getRecipe>['recipeId'];
type Action = () => Promise<unknown>;
type OnAction = (run: Action) => Promise<void>;

export function RecipeDetailSurface({ recipeId }: { recipeId: RecipeId }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const recipeData = useQuery(api.recipes.queries.getRecipe, { recipeId });
  const createDraft = useMutation(api.recipes.mutations.createInitialDraftVersion);
  const cloneDraft = useMutation(api.recipes.mutations.clonePublishedVersionToDraft);
  const publish = useMutation(api.recipes.mutations.publishRecipeVersion);
  const archive = useMutation(api.recipes.mutations.archiveRecipe);
  const update = useMutation(api.recipes.mutations.updateRecipeMetadata);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canManage =
    currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');

  if (recipeData === undefined) return null;

  const { recipe, versions } = recipeData;
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
        recipeId: recipe._id,
        name: String(form.get('name') ?? ''),
        description: String(form.get('description') ?? ''),
      }),
    );
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex max-w-3xl flex-col gap-2">
        <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
          {t('recipes.eyebrow')}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-display font-extrabold tracking-[-0.025em] text-ink">
            {recipe.name}
          </h1>
          <StatusChip emphasis="loud" kind="recipe" status={recipe.status} />
        </div>
        <p className="font-mono text-xs text-ink-2">{recipe.key}</p>
        <p className="text-sm text-ink-2">{recipe.description}</p>
      </header>
      {message === null ? null : <AlertMessage>{message}</AlertMessage>}
      {recipe.status === 'archived' ? (
        <Notice>{t('recipes.archivedNotice')}</Notice>
      ) : null}
      {canManage && recipe.status !== 'archived' ? (
        <ActionGroup>
          <Button onClick={() => setEditing(true)}>{t('recipes.edit')}</Button>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            {t('recipes.archive')}
          </Button>
        </ActionGroup>
      ) : null}
      {editing ? (
        <MetadataForm
          description={recipe.description}
          name={recipe.name}
          onClose={() => setEditing(false)}
          onSubmit={saveMetadata}
        />
      ) : null}
      {confirming ? (
        <Confirmation
          onCancel={() => setConfirming(false)}
          onConfirm={() => action(() => archive({ recipeId: recipe._id }))}
        />
      ) : null}
      <LifecycleActions
        archived={recipe.status === 'archived'}
        canManage={canManage}
        cloneDraft={cloneDraft}
        createDraft={createDraft}
        draft={draft}
        onAction={action}
        published={published}
        publish={publish}
        recipeId={recipe._id}
      />
      <Panel>
        <PanelHeader>
          <PanelTitle>{t('recipes.versionsTitle')}</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <p className="text-sm text-ink-2">{t('recipes.immutableNotice')}</p>
          {sorted.length === 0 ? (
            <p className="text-sm text-ink-3">{t('recipes.noVersions')}</p>
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
  recipeId,
  draft,
  published,
  archived,
  canManage,
  createDraft,
  cloneDraft,
  publish,
  onAction,
}: {
  recipeId: RecipeId;
  draft: RecipeVersion | undefined;
  published: RecipeVersion | undefined;
  archived: boolean;
  canManage: boolean;
  createDraft: ReturnType<
    typeof useMutation<typeof api.recipes.mutations.createInitialDraftVersion>
  >;
  cloneDraft: ReturnType<
    typeof useMutation<typeof api.recipes.mutations.clonePublishedVersionToDraft>
  >;
  publish: ReturnType<
    typeof useMutation<typeof api.recipes.mutations.publishRecipeVersion>
  >;
  onAction: OnAction;
}) {
  const t = useTranslations();

  if (!canManage || archived) return null;
  if (draft !== undefined) {
    return <DraftActions draft={draft} onAction={onAction} publish={publish} />;
  }
  if (published !== undefined) {
    return (
      <Button
        variant="primary"
        onClick={() => onAction(() => cloneDraft({ recipeId }))}
      >
        {t('recipes.newVersionFrom', { version: published.versionNumber })}
      </Button>
    );
  }
  return (
    <Button variant="primary" onClick={() => onAction(() => createDraft({ recipeId }))}>
      {t('recipes.createFirstDraft')}
    </Button>
  );
}

function DraftActions({
  draft,
  publish,
  onAction,
}: {
  draft: RecipeVersion;
  publish: ReturnType<
    typeof useMutation<typeof api.recipes.mutations.publishRecipeVersion>
  >;
  onAction: OnAction;
}) {
  const t = useTranslations();
  const details = useQuery(api.recipes.queries.getRecipeVersion, {
    recipeVersionId: draft._id,
  });
  const checks = checkRecipeDraft(details?.recipeFields ?? []);
  const blocked = checks.empty || checks.fieldProblems.size > 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        disabled={blocked}
        variant="primary"
        onClick={() => onAction(() => publish({ recipeVersionId: draft._id }))}
      >
        {t('recipes.publishDraft')}
      </Button>
      <Button>{t('recipes.draftEditor')}</Button>
      <span className="text-xs text-ink-3">{t('recipes.draftEditorNote')}</span>
    </div>
  );
}

function VersionCard({ version, current }: { version: RecipeVersion; current: boolean }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const details = useQuery(api.recipes.queries.getRecipeVersion, {
    recipeVersionId: version._id,
  });
  const index = useFieldDefinitionIndex(
    currentOrganization === null ? undefined : currentOrganization.organization._id,
    details?.recipeFields ?? [],
  );
  const checks = checkRecipeDraft(details?.recipeFields ?? []);

  return (
    <Panel emphasis={version.status === 'draft' ? 'inset' : 'module'}>
      <PanelHeader>
        <div className="flex flex-wrap items-center gap-2">
          <PanelTitle>v{version.versionNumber}</PanelTitle>
          <StatusChip kind="recipeVersion" status={version.status} />
          {current ? <CurrentBadge>{t('recipes.current')}</CurrentBadge> : null}
          {version.status !== 'draft' ? <LockedBadge>{t('recipes.locked')}</LockedBadge> : null}
        </div>
        <span className="text-xs text-ink-3">
          {t('recipes.created')}: {formatDateTime(locale, version._creationTime)}
        </span>
      </PanelHeader>
      <PanelBody>
        {details === undefined ? null : index === undefined ? (
          <VersionContentsSkeleton fields={details.recipeFields} />
        ) : (
          <VersionContents
            fields={details.recipeFields}
            index={index}
            problems={checks.fieldProblems}
          />
        )}
      </PanelBody>
    </Panel>
  );
}

function VersionContentsSkeleton({ fields }: { fields: readonly RecipeField[] }) {
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
  fields: readonly RecipeField[];
  index: NonNullable<ReturnType<typeof useFieldDefinitionIndex>>;
  problems: ReadonlyMap<string, readonly DraftFieldProblem[]>;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-bold text-ink">{t('recipes.contentsTitle')}</h3>
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
                {t('recipes.requiredField')}: {field.required ? t('recipes.yes') : t('recipes.no')}
              </span>
              <span>
                {t('recipes.visibleField')}: {field.visible ? t('recipes.yes') : t('recipes.no')}
              </span>
            </div>
            <p className="mt-2 text-xs text-ink-2">
              {t('recipes.rules')}: {field.config.kind}
            </p>
            {definition === undefined ? (
              <p className="mt-2 text-xs text-tone-stop">
                {t('recipes.definitionUnresolved')}
              </p>
            ) : null}
            {(problems.get(field._id) ?? []).map((problem) => (
              <p key={problem} className="mt-1 text-xs text-tone-stop">
                {t(`recipes.${problem}`)}
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
            <FieldLabel>{t('recipes.name')}</FieldLabel>
            <FieldControl defaultValue={name} name="name" required />
          </Field>
          <Field>
            <FieldLabel>{t('recipes.description')}</FieldLabel>
            <FieldControl defaultValue={description} name="description" />
          </Field>
          <ActionGroup>
            <Button type="submit" variant="primary">
              {t('recipes.save')}
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
        <PanelTitle>{t('recipes.archiveTitle')}</PanelTitle>
        <p className="text-sm text-ink-2">{t('recipes.archiveWarning')}</p>
        <ActionGroup>
          <Button variant="danger" onClick={onConfirm}>
            {t('recipes.archiveConfirm')}
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
