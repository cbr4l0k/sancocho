'use client';

import Link from 'next/link';
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';

import { api } from '@sancocho/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
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
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { roleAtLeast } from '@/lib/roles';

export function RecipesSurface({ locale }: { locale: string }) {
  const { currentOrganization } = useCurrentOrganization();
  const t = useTranslations();
  const recipes = usePaginatedQuery(
    api.recipes.queries.listRecipes,
    currentOrganization === null
      ? 'skip'
      : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );
  const createRecipe = useMutation(api.recipes.mutations.createRecipe);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canManage =
    currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');

  if (currentOrganization === null) return null;

  const organizationId = currentOrganization.organization._id;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    try {
      const description = String(form.get('description') ?? '');
      const args = {
        organizationId,
        key: String(form.get('key') ?? ''),
        name: String(form.get('name') ?? ''),
      };
      await createRecipe(description === '' ? args : { ...args, description });
      setCreating(false);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex max-w-3xl flex-col gap-2">
        <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
          {t('recipes.eyebrow')}
        </p>
        <h1 className="text-display font-extrabold tracking-[-0.025em] text-ink">
          {t('recipes.title')}
        </h1>
        <p className="text-sm text-ink-2">{t('recipes.lead')}</p>
      </header>
      {message === null ? null : <AlertMessage>{message}</AlertMessage>}
      {canManage ? (
        <Button className="self-start" variant="primary" onClick={() => setCreating(true)}>
          {t('recipes.create')}
        </Button>
      ) : null}
      {creating ? <RecipeForm onClose={() => setCreating(false)} onSubmit={submit} /> : null}
      {recipes.status === 'Exhausted' && recipes.results.length === 0 ? (
        <EmptyState title={t('recipes.emptyTitle')} description={t('recipes.emptyBody')} />
      ) : (
        <Panel>
          <PanelHeader>
            <PanelTitle>{t('recipes.title')}</PanelTitle>
          </PanelHeader>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('recipes.name')}</TableHeaderCell>
                <TableHeaderCell>{t('recipes.key')}</TableHeaderCell>
                <TableHeaderCell>{t('recipes.statuses.active')}</TableHeaderCell>
                <TableHeaderCell>{t('recipes.currentVersion')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            {recipes.status === 'LoadingFirstPage' ? (
              <TableSkeletonRows columns={4} />
            ) : (
              <TableBody>
                {recipes.results.map((recipe) => (
                  <RecipeRow key={recipe._id} locale={locale} recipe={recipe} />
                ))}
              </TableBody>
            )}
          </Table>
        </Panel>
      )}
      <TableLoadMore
        loadedCount={recipes.results.length}
        status={recipes.status}
        onLoadMore={recipes.loadMore}
      />
    </div>
  );
}

type Recipe = FunctionReturnType<typeof api.recipes.queries.listRecipes>['page'][number];

function RecipeRow({ recipe, locale }: { recipe: Recipe; locale: string }) {
  const t = useTranslations();
  const details = useQuery(api.recipes.queries.getRecipe, { recipeId: recipe._id });
  const published = details?.versions.find((version) => version.status === 'published');

  return (
    <TableRow>
      <TableRowHeaderCell>
        <Link
          className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
          href={`/${locale}/recipes/${recipe._id}`}
        >
          {recipe.name}
        </Link>
      </TableRowHeaderCell>
      <TableCell className="font-mono text-xs">{recipe.key}</TableCell>
      <TableCell>
        <StatusChip kind="recipe" status={recipe.status} />
      </TableCell>
      <TableCell className="font-mono text-xs text-ink-2">
        {published === undefined ? t('recipes.noPublishedVersion') : `v${published.versionNumber}`}
      </TableCell>
    </TableRow>
  );
}

function RecipeForm({
  onSubmit,
  onClose,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const t = useTranslations();

  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>{t('recipes.createTitle')}</PanelTitle>
          <p className="mt-1 text-sm text-ink-2">{t('recipes.createLead')}</p>
        </div>
      </PanelHeader>
      <PanelBody>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <Field>
            <FieldLabel>{t('recipes.name')}</FieldLabel>
            <FieldControl name="name" required />
          </Field>
          <Field>
            <FieldLabel>{t('recipes.key')}</FieldLabel>
            <FieldControl name="key" pattern="[a-z][a-zA-Z0-9]{1,63}" required />
            <FieldDescription>{t('recipes.keyHelp')}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>{t('recipes.description')}</FieldLabel>
            <FieldControl name="description" />
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
