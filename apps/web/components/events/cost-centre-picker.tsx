'use client';

import { usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { useDebouncedValue } from '@/lib/use-debounced-value';

type CostCentreId = FunctionArgs<typeof api.costCentres.queries.getCostCentre>['costCentreId'];
type OrganizationId = FunctionArgs<typeof api.costCentres.queries.listCostCentres>['organizationId'];

export function CostCentrePicker({
  organizationId,
  value,
  onChange,
  disabled = false,
}: {
  organizationId: OrganizationId;
  value: CostCentreId | undefined;
  onChange: (costCentreId: CostCentreId) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const centres = usePaginatedQuery(
    api.costCentres.queries.listCostCentres,
    {
      organizationId,
      status: 'active',
      ...(debouncedSearch === '' ? {} : { search: debouncedSearch }),
    },
    { initialNumItems: 50 },
  );
  const selected = useQuery(
    api.costCentres.queries.getCostCentre,
    value === undefined ? 'skip' : { costCentreId: value },
  );
  const selectedIsLoaded = value === undefined || centres.results.some((centre) => centre._id === value);

  return (
    <div className="flex flex-col gap-3">
      <input
        aria-label={t('events.costCentre')}
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm"
        placeholder={t('events.costCentre')}
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
      />
      {selected === undefined || selectedIsLoaded ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-input border border-line bg-ground-2 px-3 py-2">
          <span className="text-sm text-ink">
            {selected.name} · {selected.key}
          </span>
          {selected.status === 'archived' ? <StatusChip kind="archival" status="archived" /> : null}
        </div>
      )}
      {centres.status === 'Exhausted' && centres.results.length === 0 ? (
        <EmptyState
          tone={search.trim() === '' ? 'empty' : 'filtered'}
          title={t(search.trim() === '' ? 'empty.noRecords' : 'empty.noMatches')}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {centres.results.map((centre) => (
            <Button
              key={centre._id}
              type="button"
              size="sm"
              selected={value === centre._id}
              disabled={disabled}
              onClick={() => onChange(centre._id)}
            >
              {centre.name} · {centre.key}
            </Button>
          ))}
        </div>
      )}
      {centres.status === 'CanLoadMore' ? (
        <Button type="button" size="sm" onClick={() => centres.loadMore(50)}>
          {t('table.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
