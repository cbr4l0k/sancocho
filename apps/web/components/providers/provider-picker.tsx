'use client';

import { usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { pickerArgs, providerFilterPickerArgs } from '@/lib/catalogue-filters';
import { useDebouncedValue } from '@/lib/use-debounced-value';

type ProviderId = FunctionArgs<typeof api.providers.queries.getProvider>['providerId'];

/** Reusable active-Provider picker; organization context only controls its backend query. */
export function ProviderPicker({
  value,
  onChange,
  disabled = false,
  includeArchived = false,
}: {
  value: ProviderId | undefined;
  onChange: (providerId: ProviderId) => void;
  disabled?: boolean | undefined;
  includeArchived?: boolean | undefined;
}) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const organizationId = currentOrganization?.organization._id;
  const providers = usePaginatedQuery(
    api.providers.queries.listProviders,
    includeArchived
      ? providerFilterPickerArgs(organizationId, debouncedSearch)
      : pickerArgs(organizationId, debouncedSearch),
    { initialNumItems: 50 },
  );
  const selected = useQuery(api.providers.queries.getProvider, value === undefined ? 'skip' : { providerId: value });
  const selectedIsLoaded = value === undefined || providers.results.some((provider) => provider._id === value);

  return (
    <div className="flex flex-col gap-3">
      <input
        aria-label={t('providers.search')}
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm"
        placeholder={t('providers.search')}
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
      />
      {selected === undefined || selectedIsLoaded ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-input border border-line bg-ground-2 px-3 py-2">
          <span className="text-sm text-ink">{selected.name}</span>
          {selected.status === 'archived' ? <StatusChip kind="archival" status="archived" /> : null}
          {selected.status === 'archived' ? (
            <span className="text-xs text-ink-3">{t('fleet.selectedArchived')}</span>
          ) : null}
        </div>
      )}
      {providers.status === 'Exhausted' && providers.results.length === 0 ? (
        <EmptyState
          tone={search.trim() === '' ? 'empty' : 'filtered'}
          title={t(search.trim() === '' ? 'providers.emptyTitle' : 'providers.noMatchesTitle')}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {providers.results.map((provider) => (
            <Button
              key={provider._id}
              type="button"
              size="sm"
              selected={value === provider._id}
              disabled={disabled}
              onClick={() => onChange(provider._id)}
            >
              {provider.name}
            </Button>
          ))}
        </div>
      )}
      {providers.status === 'CanLoadMore' ? (
        <Button type="button" size="sm" disabled={disabled} onClick={() => providers.loadMore(50)}>
          {t('table.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
