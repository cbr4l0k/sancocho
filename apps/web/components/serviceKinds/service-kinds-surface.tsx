'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldDescription, FieldLabel } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
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
import { LocaleLink } from '@/i18n/locale-link';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { roleAtLeast } from '@/lib/roles';

export function ServiceKindsSurface() {
  const { currentOrganization } = useCurrentOrganization();
  const t = useTranslations();
  const serviceKinds = usePaginatedQuery(
    api.serviceKinds.queries.listServiceKinds,
    currentOrganization === null
      ? 'skip'
      : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );
  const createServiceKind = useMutation(api.serviceKinds.mutations.createServiceKind);
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
      await createServiceKind(description === '' ? args : { ...args, description });
      setCreating(false);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={
          canManage && !creating ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('serviceKinds.create')}
            </Button>
          ) : undefined
        }
      />
      {message === null ? null : <AlertMessage>{message}</AlertMessage>}
      {creating ? <ServiceKindForm onClose={() => setCreating(false)} onSubmit={submit} /> : null}
      {serviceKinds.status === 'Exhausted' && serviceKinds.results.length === 0 ? (
        <EmptyState title={t('serviceKinds.emptyTitle')} description={t('serviceKinds.emptyBody')} />
      ) : (
        <Panel>
          <PanelHeader>
            <PanelTitle>{t('serviceKinds.title')}</PanelTitle>
          </PanelHeader>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('serviceKinds.name')}</TableHeaderCell>
                <TableHeaderCell>{t('serviceKinds.key')}</TableHeaderCell>
                <TableHeaderCell>{t('serviceKinds.statuses.active')}</TableHeaderCell>
                <TableHeaderCell>{t('serviceKinds.currentVersion')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            {serviceKinds.status === 'LoadingFirstPage' ? (
              <TableSkeletonRows columns={4} />
            ) : (
              <TableBody>
                {serviceKinds.results.map((serviceKind) => (
                  <ServiceKindRow key={serviceKind._id} serviceKind={serviceKind} />
                ))}
              </TableBody>
            )}
          </Table>
        </Panel>
      )}
      <TableLoadMore
        loadedCount={serviceKinds.results.length}
        status={serviceKinds.status}
        onLoadMore={serviceKinds.loadMore}
      />
    </div>
  );
}

type ServiceKind = FunctionReturnType<typeof api.serviceKinds.queries.listServiceKinds>['page'][number];

function ServiceKindRow({ serviceKind }: { serviceKind: ServiceKind }) {
  const t = useTranslations();
  const details = useQuery(api.serviceKinds.queries.getServiceKind, { serviceKindId: serviceKind._id });
  const published = details?.versions.find((version) => version.status === 'published');

  return (
    <TableRow>
      <TableRowHeaderCell>
        <LocaleLink
          className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
          to={`/settings/service-kinds/${serviceKind._id}`}
        >
          {serviceKind.name}
        </LocaleLink>
      </TableRowHeaderCell>
      <TableCell className="font-mono text-xs">{serviceKind.key}</TableCell>
      <TableCell>
        <StatusChip kind="serviceKind" status={serviceKind.status} />
      </TableCell>
      <TableCell className="font-mono text-xs text-ink-2">
        {published === undefined ? t('serviceKinds.noPublishedVersion') : `v${published.versionNumber}`}
      </TableCell>
    </TableRow>
  );
}

function ServiceKindForm({
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
          <PanelTitle>{t('serviceKinds.createTitle')}</PanelTitle>
          <p className="mt-1 text-sm text-ink-2">{t('serviceKinds.createLead')}</p>
        </div>
      </PanelHeader>
      <PanelBody>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <Field>
            <FieldLabel>{t('serviceKinds.name')}</FieldLabel>
            <FieldControl name="name" required />
          </Field>
          <Field>
            <FieldLabel>{t('serviceKinds.key')}</FieldLabel>
            <FieldControl name="key" pattern="[a-z][a-zA-Z0-9]{1,63}" required />
            <FieldDescription>{t('serviceKinds.keyHelp')}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>{t('serviceKinds.description')}</FieldLabel>
            <FieldControl name="description" />
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
