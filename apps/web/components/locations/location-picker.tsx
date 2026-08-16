'use client';

import { usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@sancocho/convex/api';
import type { locationTypeValidator } from '@sancocho/convex/validators';

import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/status-chip';
import { buildLocationOptions } from '@/lib/location-options';

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

/** A paginated picker: search and type filtering intentionally apply only to rows already loaded. */
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
  const locations = usePaginatedQuery(api.locations.queries.listLocations, { organizationId }, { initialNumItems: 50 });
  const selected = useQuery(api.locations.queries.getLocation, value === undefined ? 'skip' : { locationId: value });
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const activeLocations = locations.results.filter(
    (location) =>
      location.status === 'active' &&
      (type === '' || location.type === type) &&
      (normalizedSearch === '' || location.name.toLocaleLowerCase().includes(normalizedSearch)),
  );
  const options = buildLocationOptions({ loaded: activeLocations, selected });
  const archivedSelected = options.find((option) => option.isArchived);
  const activeOptions = options.filter((option) => !option.isArchived);

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
      <p className="text-xs text-ink-3">{t('locations.loadedFilterNotice')}</p>
      {archivedSelected === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-input border border-line bg-ground-2 px-3 py-2">
          <span className="text-sm text-ink">{archivedSelected.location.name}</span>
          <StatusChip kind="archival" status="archived" />
          <span className="text-xs text-ink-3">{t('locations.selectedArchived')}</span>
        </div>
      )}
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
      {locations.status !== 'Exhausted' ? (
        <Button size="sm" disabled={disabled} onClick={() => locations.loadMore(50)}>
          {t('locations.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
