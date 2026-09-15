'use client';

import { useMutation, usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ProviderPicker } from '@/components/providers/provider-picker';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldLabel } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelBodyFlush, PanelHeader, PanelTitle } from '@/components/ui/panel';
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
import { rateCardCatalogueArgs } from '@/lib/catalogue-filters';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';

type RateCard = FunctionReturnType<typeof api.rateCards.queries.listRateCards>['page'][number];
type Provider = FunctionReturnType<typeof api.providers.queries.listProviders>['page'][number];
type ProviderId = RateCard['providerId'];

export function RateCardsSurface() {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const organizationId = currentOrganization?.organization._id;
  const [createProviderId, setCreateProviderId] = useState<ProviderId | ''>('');
  const [filterProviderId, setFilterProviderId] = useState<ProviderId | ''>('');
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const cards = usePaginatedQuery(
    api.rateCards.queries.listRateCards,
    rateCardCatalogueArgs(organizationId, { providerId: filterProviderId }),
    { initialNumItems: 25 },
  );
  const providers = usePaginatedQuery(
    api.providers.queries.listProviders,
    organizationId === undefined ? 'skip' : { organizationId },
    { initialNumItems: 100 },
  );
  const create = useMutation(api.rateCards.mutations.createRateCard);

  if (currentOrganization === null) return null;
  const currentOrganizationId = currentOrganization.organization._id;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (createProviderId === '') return;
    try {
      await create({
        organizationId: currentOrganizationId,
        providerId: createProviderId,
        name: String(new FormData(event.currentTarget).get('name') ?? ''),
      });
      setCreating(false);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  const filtered = filterProviderId !== '';
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={
          creating ? undefined : (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('rateCards.create')}
            </Button>
          )
        }
      />
      {message === null ? null : <Alert>{message}</Alert>}
      {creating ? (
        <Panel emphasis="focal">
          <PanelHeader><PanelTitle>{t('rateCards.createTitle')}</PanelTitle></PanelHeader>
          <PanelBody>
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <Field>
                <FieldLabel>{t('rateCards.name')}</FieldLabel>
                <FieldControl name="name" required />
              </Field>
              <Field>
                <FieldLabel>{t('rateCards.provider')}</FieldLabel>
                <ProviderPicker
                  value={createProviderId === '' ? undefined : createProviderId}
                  onChange={setCreateProviderId}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" disabled={createProviderId === ''}>{t('rateCards.save')}</Button>
                <Button type="button" onClick={() => setCreating(false)}>{t('common.cancel')}</Button>
              </div>
            </form>
          </PanelBody>
        </Panel>
      ) : null}
      <Panel>
        <PanelHeader><PanelTitle>{t('rateCards.listTitle')}</PanelTitle></PanelHeader>
        <PanelBody>
          <Field>
            <FieldLabel>{t('rateCards.providerFilter')}</FieldLabel>
            <ProviderPicker
              value={filterProviderId === '' ? undefined : filterProviderId}
              onChange={setFilterProviderId}
              includeArchived
            />
            {filterProviderId === '' ? null : (
              <Button type="button" size="sm" onClick={() => setFilterProviderId('')}>{t('common.clear')}</Button>
            )}
          </Field>
        </PanelBody>
        {cards.status === 'Exhausted' && cards.results.length === 0 ? (
          <PanelBody>
            <EmptyState
              tone={filtered ? 'filtered' : 'empty'}
              title={t(filtered ? 'rateCards.noMatchesTitle' : 'rateCards.emptyTitle')}
              description={t(filtered ? 'rateCards.noMatchesBody' : 'rateCards.emptyBody')}
            />
          </PanelBody>
        ) : (
          <RateCardTable
            cards={cards.results}
            providers={providers.results}
            providersExhausted={providers.status === 'Exhausted'}
            loading={cards.status === 'LoadingFirstPage'}
          />
        )}
      </Panel>
      <TableLoadMore status={cards.status} loadedCount={cards.results.length} onLoadMore={cards.loadMore} />
      <TableLoadMore status={providers.status} loadedCount={providers.results.length} onLoadMore={providers.loadMore} />
    </div>
  );
}

function RateCardTable({ cards, providers, providersExhausted, loading }: {
  cards: readonly RateCard[];
  providers: readonly Provider[];
  providersExhausted: boolean;
  loading: boolean;
}) {
  const t = useTranslations();
  const providerNames = new Map(providers.map((provider) => [provider._id, provider.name]));
  return (
    <PanelBodyFlush>
      <Table>
        <TableHead><TableRow>
          <TableHeaderCell>{t('rateCards.name')}</TableHeaderCell>
          <TableHeaderCell>{t('rateCards.provider')}</TableHeaderCell>
          <TableHeaderCell>{t('rateCards.status')}</TableHeaderCell>
          <TableHeaderCell>{t('rateCards.currentPublished')}</TableHeaderCell>
        </TableRow></TableHead>
        {loading ? <TableSkeletonRows columns={4} /> : (
          <TableBody>
            {cards.map((card) => (
              <TableRow key={card._id}>
                <TableRowHeaderCell>
                  <LocaleLink className="font-semibold text-ink hover:text-accent" to={`/settings/rate-cards/${card._id}`}>
                    {card.name}
                  </LocaleLink>
                </TableRowHeaderCell>
                <TableCell>
                  {providerNames.get(card.providerId) ??
                    t(providersExhausted ? 'errors.notFound' : 'rateCards.providerStillLoading')}
                </TableCell>
                <TableCell><StatusChip kind="archival" status={card.status} /></TableCell>
                <TableCell>
                  {card.currentPublishedVersionId === undefined
                    ? t('rateCards.nonePublished')
                    : t('rateCards.publishedState')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        )}
      </Table>
    </PanelBodyFlush>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">{children}</p>;
}
