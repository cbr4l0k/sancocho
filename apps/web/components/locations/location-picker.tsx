'use client';

import { usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';
import type { locationTypeValidator } from '@priamo/convex/validators';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { buildLocationOptions } from '@/lib/location-options';
import { useDebouncedValue } from '@/lib/use-debounced-value';

type LocationId = FunctionArgs<typeof api.locations.queries.getLocation>['locationId'];
type OrganizationId = FunctionArgs<typeof api.locations.queries.listLocations>['organizationId'];
type LocationType = typeof locationTypeValidator.type;

const locationTypes = [
  'airport',
  'hotel',
  'venue',
  'office',
  'station',
  'depot',
  'custom',
] as const satisfies readonly LocationType[];

/** A paginated picker whose active-location filters compose with cursor pagination. */
export function LocationPicker({
  organizationId,
  value,
  onChange,
  disabled = false,
}: {
  organizationId: OrganizationId;
  value: LocationId | undefined;
  onChange: (locationId: LocationId) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const [search, setSearch] = useState('');
  const [type, setType] = useState<LocationType | ''>('');
  const debouncedSearch = useDebouncedValue(search);
  const locations = usePaginatedQuery(
    api.locations.queries.listLocations,
    {
      organizationId,
      status: 'active',
      ...(debouncedSearch === '' ? {} : { search: debouncedSearch }),
      ...(type === '' ? {} : { type }),
    },
    { initialNumItems: 50 },
  );
  const selected = useQuery(api.locations.queries.getLocation, value === undefined ? 'skip' : { locationId: value });
  const options = buildLocationOptions({ loaded: locations.results, selected });
  const archivedSelected = options.find((option) => option.isArchived);
  const activeOptions = options.filter((option) => !option.isArchived);
  const hasActiveFilters = search.trim() !== '' || type !== '';

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
          {t('locations.search')}
          <input
            className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
            value={search}
            disabled={disabled}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
          {t('locations.typeFilter')}
          <select
            className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
            value={type}
            disabled={disabled}
            onChange={(event) => {
              const candidate = locationTypes.find((item) => item === event.target.value);
              setType(candidate ?? '');
            }}
          >
            <option value="">{t('locations.allTypes')}</option>
            {locationTypes.map((item) => (
              <option key={item} value={item}>
                {t(`locations.types.${item}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {archivedSelected === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-input border border-line bg-ground-2 px-3 py-2">
          <span className="text-sm text-ink">{archivedSelected.location.name}</span>
          <StatusChip kind="archival" status="archived" />
          <span className="text-xs text-ink-3">{t('locations.selectedArchived')}</span>
        </div>
      )}
      {locations.status === 'Exhausted' && activeOptions.length === 0 ? (
        <EmptyState
          tone={hasActiveFilters ? 'filtered' : 'empty'}
          title={t(hasActiveFilters ? 'locations.noMatchesTitle' : 'locations.emptyTitle')}
          description={t(hasActiveFilters ? 'locations.noMatchesBody' : 'locations.emptyBody')}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {activeOptions.map(({ location }) => (
            <Button
              key={location._id}
              size="sm"
              selected={value === location._id}
              disabled={disabled}
              onClick={() => onChange(location._id)}
            >
              {location.name} · {t(`locations.types.${location.type}`)}
            </Button>
          ))}
        </div>
      )}
      {locations.status !== 'Exhausted' ? (
        <Button size="sm" disabled={disabled} onClick={() => locations.loadMore(50)}>
          {t('locations.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
