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
import { pickerArgs } from '@/lib/catalogue-filters';
import { useDebouncedValue } from '@/lib/use-debounced-value';

type VehicleClassId = FunctionArgs<typeof api.vehicles.queries.getVehicleClass>['vehicleClassId'];

/** Reusable active-Class picker; organization context only controls its backend query. */
export function VehicleClassPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: VehicleClassId | undefined;
  onChange: (vehicleClassId: VehicleClassId) => void;
  disabled?: boolean | undefined;
}) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const organizationId = currentOrganization?.organization._id;
  const classes = usePaginatedQuery(
    api.vehicles.queries.listVehicleClasses,
    pickerArgs(organizationId, debouncedSearch),
    { initialNumItems: 50 },
  );
  const selected = useQuery(
    api.vehicles.queries.getVehicleClass,
    value === undefined ? 'skip' : { vehicleClassId: value },
  );
  const selectedIsLoaded = value === undefined || classes.results.some((vehicleClass) => vehicleClass._id === value);

  return (
    <div className="flex flex-col gap-3">
      <input
        aria-label={t('fleet.vehicleClass')}
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm"
        placeholder={t('fleet.search')}
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
      {classes.status === 'Exhausted' && classes.results.length === 0 ? (
        <EmptyState
          tone={search.trim() === '' ? 'empty' : 'filtered'}
          title={t(search.trim() === '' ? 'fleet.classesEmptyTitle' : 'fleet.noMatchesTitle')}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {classes.results.map((vehicleClass) => (
            <Button
              key={vehicleClass._id}
              type="button"
              size="sm"
              selected={value === vehicleClass._id}
              disabled={disabled}
              onClick={() => onChange(vehicleClass._id)}
            >
              {vehicleClass.name} · {vehicleClass.key}
            </Button>
          ))}
        </div>
      )}
      {classes.status === 'CanLoadMore' ? (
        <Button type="button" size="sm" disabled={disabled} onClick={() => classes.loadMore(50)}>
          {t('table.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
