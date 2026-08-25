'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { api } from '@priamo/convex/api';
import type { locationTypeValidator } from '@priamo/convex/validators';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelBodyFlush, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
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
import { validateLocationCoordinates } from '@/lib/location-coordinates';
import { roleAtLeast } from '@/lib/roles';
import { useDebouncedValue } from '@/lib/use-debounced-value';

type Location = FunctionReturnType<typeof api.locations.queries.listLocations>['page'][number];
type LocationId = FunctionArgs<typeof api.locations.queries.getLocation>['locationId'];
type LocationType = typeof locationTypeValidator.type;
type EditorState = { mode: 'create' } | { mode: 'edit'; location: Location } | null;
type Confirmation = { mode: 'archive' | 'delete'; location: Location } | null;

const locationTypes = [
  'airport',
  'hotel',
  'venue',
  'office',
  'station',
  'depot',
  'custom',
] as const satisfies readonly LocationType[];

export function LocationsSurface() {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<LocationType | ''>('');
  const debouncedSearch = useDebouncedValue(search);
  const hasActiveFilters = search.trim() !== '' || typeFilter !== '';
  const locations = usePaginatedQuery(
    api.locations.queries.listLocations,
    currentOrganization === null
      ? 'skip'
      : {
          organizationId: currentOrganization.organization._id,
          ...(debouncedSearch === '' ? {} : { search: debouncedSearch }),
          ...(typeFilter === '' ? {} : { type: typeFilter }),
        },
    { initialNumItems: 25 },
  );
  const create = useMutation(api.locations.mutations.createLocation);
  const update = useMutation(api.locations.mutations.updateLocation);
  const archive = useMutation(api.locations.mutations.archiveLocation);
  const remove = useMutation(api.locations.mutations.deleteLocation);
  const [editor, setEditor] = useState<EditorState>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canManage = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'admin');

  if (currentOrganization === null) return null;

  async function confirm(): Promise<void> {
    if (confirmation === null) return;
    try {
      if (confirmation.mode === 'archive') await archive({ locationId: confirmation.location._id });
      else await remove({ locationId: confirmation.location._id });
      setConfirmation(null);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={
          canManage && editor === null ? (
            <Button variant="primary" onClick={() => setEditor({ mode: 'create' })}>
              {t('locations.create')}
            </Button>
          ) : undefined
        }
      />
      {message === null ? null : <Alert>{message}</Alert>}
      {editor === null ? null : (
        <LocationEditor
          key={editor.mode === 'create' ? 'create' : editor.location._id}
          location={editor.mode === 'edit' ? editor.location : undefined}
          organizationId={currentOrganization.organization._id}
          onClose={() => setEditor(null)}
          onCreate={create}
          onUpdate={update}
        />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
          {t('locations.search')}
          <input
            className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
          {t('locations.typeFilter')}
          <select
            className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
            value={typeFilter}
            onChange={(event) => {
              const candidate = locationTypes.find((item) => item === event.target.value);
              setTypeFilter(candidate ?? '');
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
      {locations.status === 'Exhausted' && locations.results.length === 0 ? (
        <EmptyState
          tone={hasActiveFilters ? 'filtered' : 'empty'}
          title={t(hasActiveFilters ? 'locations.noMatchesTitle' : 'locations.emptyTitle')}
          description={t(hasActiveFilters ? 'locations.noMatchesBody' : 'locations.emptyBody')}
        />
      ) : (
        <LocationTable
          locations={locations.results}
          loading={locations.status === 'LoadingFirstPage'}
          canManage={canManage}
          onEdit={(location) => setEditor({ mode: 'edit', location })}
          onArchive={(location) => setConfirmation({ mode: 'archive', location })}
          onDelete={(location) => setConfirmation({ mode: 'delete', location })}
        />
      )}
      <TableLoadMore status={locations.status} loadedCount={locations.results.length} onLoadMore={locations.loadMore} />
      {confirmation === null ? null : (
        <LocationConfirmation mode={confirmation.mode} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
      )}
    </div>
  );
}

export function LocationDetailSurface({ locationId }: { locationId: LocationId }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const location = useQuery(api.locations.queries.getLocation, { locationId });
  const update = useMutation(api.locations.mutations.updateLocation);
  const archive = useMutation(api.locations.mutations.archiveLocation);
  const remove = useMutation(api.locations.mutations.deleteLocation);
  const [editing, setEditing] = useState(false);
  const [confirmation, setConfirmation] = useState<'archive' | 'delete' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canManage = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'admin');
  if (location === undefined) return null;

  async function confirm(): Promise<void> {
    if (confirmation === null) return;
    try {
      if (confirmation === 'archive') await archive({ locationId });
      else await remove({ locationId });
      setConfirmation(null);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        badge={<StatusChip emphasis="loud" kind="archival" status={location.status} />}
        actions={
          canManage && location.status === 'active' && !editing ? (
            <>
              <Button onClick={() => setEditing(true)}>{t('locations.edit')}</Button>
              <Button variant="danger" onClick={() => setConfirmation('archive')}>
                {t('locations.archive')}
              </Button>
            </>
          ) : undefined
        }
      />
      {message === null ? null : <Alert>{message}</Alert>}
      {/* The editor takes the details panel's place rather than appending after
       * it, so pressing Edit never opens a form below the fold. */}
      {editing ? (
        <LocationEditor location={location} onClose={() => setEditing(false)} onCreate={undefined} onUpdate={update} />
      ) : (
        <LocationDetails location={location} />
      )}
      {location.status === 'archived' ? (
        <p className="rounded-input border border-line px-4 py-3 text-sm text-ink-2">{t('locations.archivedNotice')}</p>
      ) : null}
      {canManage && location.status === 'archived' ? (
        <Button className="self-start" variant="danger" onClick={() => setConfirmation('delete')}>
          {t('locations.delete')}
        </Button>
      ) : null}
      {confirmation === null ? null : (
        <LocationConfirmation mode={confirmation} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
      )}
    </div>
  );
}

function LocationTable({
  locations,
  loading,
  canManage,
  onEdit,
  onArchive,
  onDelete,
}: {
  locations: readonly Location[];
  loading: boolean;
  canManage: boolean;
  onEdit: (location: Location) => void;
  onArchive: (location: Location) => void;
  onDelete: (location: Location) => void;
}) {
  const t = useTranslations();
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('locations.listTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBodyFlush>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('locations.name')}</TableHeaderCell>
              <TableHeaderCell>{t('locations.type')}</TableHeaderCell>
              <TableHeaderCell>{t('locations.address')}</TableHeaderCell>
              <TableHeaderCell>{t('locations.coordinates')}</TableHeaderCell>
              <TableHeaderCell>{t('locations.status')}</TableHeaderCell>
              {canManage ? <TableHeaderCell /> : null}
            </TableRow>
          </TableHead>
          {loading ? (
            <TableSkeletonRows columns={canManage ? 6 : 5} />
          ) : (
            <TableBody>
              {locations.map((location) => (
                <TableRow key={location._id}>
                  <TableRowHeaderCell>
                    <LocaleLink
                      className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
                      to={`/settings/locations/${location._id}`}
                    >
                      {location.name}
                    </LocaleLink>
                  </TableRowHeaderCell>
                  <TableCell>{t(`locations.types.${location.type}`)}</TableCell>
                  <TableCell>{location.address ?? t('locations.notSet')}</TableCell>
                  <TableCell mono>
                    {location.latitude === undefined
                      ? t('locations.notSet')
                      : `${location.latitude}, ${location.longitude}`}
                  </TableCell>
                  <TableCell>
                    <StatusChip kind="archival" status={location.status} />
                  </TableCell>
                  {canManage ? (
                    <TableCell align="end">
                      <div className="flex flex-wrap justify-end gap-1">
                        {location.status === 'active' ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => onEdit(location)}>
                              {t('locations.edit')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => onArchive(location)}>
                              {t('locations.archive')}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="danger" onClick={() => onDelete(location)}>
                            {t('locations.delete')}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          )}
        </Table>
      </PanelBodyFlush>
    </Panel>
  );
}

function LocationDetails({ location }: { location: Location }) {
  const t = useTranslations();
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('locations.detailsTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Readout label={t('locations.type')} value={t(`locations.types.${location.type}`)} />
        <Readout label={t('locations.address')} value={location.address ?? t('locations.notSet')} />
        <Readout
          label={t('locations.latitude')}
          value={location.latitude === undefined ? t('locations.notSet') : String(location.latitude)}
        />
        <Readout
          label={t('locations.longitude')}
          value={location.longitude === undefined ? t('locations.notSet') : String(location.longitude)}
        />
      </PanelBody>
    </Panel>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{label}</span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}

function LocationEditor({
  location,
  organizationId,
  onClose,
  onCreate,
  onUpdate,
}: {
  location?: Location | undefined;
  organizationId?: FunctionArgs<typeof api.locations.mutations.createLocation>['organizationId'] | undefined;
  onClose: () => void;
  onCreate: ReturnType<typeof useMutation<typeof api.locations.mutations.createLocation>> | undefined;
  onUpdate: ReturnType<typeof useMutation<typeof api.locations.mutations.updateLocation>>;
}) {
  const t = useTranslations();
  const [name, setName] = useState(location?.name ?? '');
  const [type, setType] = useState<LocationType>(location?.type ?? 'custom');
  const [address, setAddress] = useState(location?.address ?? '');
  const [latitude, setLatitude] = useState(location?.latitude === undefined ? '' : String(location.latitude));
  const [longitude, setLongitude] = useState(location?.longitude === undefined ? '' : String(location.longitude));
  const [error, setError] = useState<string | null>(null);
  const existing = location !== undefined;
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const coordinates = validateLocationCoordinates({ latitude, longitude });
    if (!coordinates.valid) {
      setError(t('errors.locationCoordinatesInvalid'));
      return;
    }
    try {
      const values = {
        name,
        type,
        ...(address === '' ? {} : { address }),
        ...(coordinates.coordinates === undefined ? {} : coordinates.coordinates),
      };
      if (existing && location !== undefined) await onUpdate({ locationId: location._id, ...values });
      else if (organizationId !== undefined && onCreate !== undefined) await onCreate({ organizationId, ...values });
      onClose();
    } catch (caught) {
      setError(t(errorMessageKey(presentConvexError(caught))));
    }
  }
  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>{t(existing ? 'locations.editTitle' : 'locations.createTitle')}</PanelTitle>
          <PanelDescription>{t('locations.coordinatesHelp')}</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label={t('locations.name')} value={name} setValue={setName} required />
            <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
              {t('locations.type')}
              <select
                className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
                value={type}
                onChange={(event) => {
                  const next = locationTypes.find((item) => item === event.target.value);
                  if (next !== undefined) setType(next);
                }}
              >
                {locationTypes.map((item) => (
                  <option key={item} value={item}>
                    {t(`locations.types.${item}`)}
                  </option>
                ))}
              </select>
            </label>
            <Input label={t('locations.address')} value={address} setValue={setAddress} />
            <Input label={t('locations.latitude')} value={latitude} setValue={setLatitude} type="number" />
            <Input label={t('locations.longitude')} value={longitude} setValue={setLongitude} type="number" />
          </div>
          {error === null ? null : (
            <p role="alert" className="text-sm text-tone-stop">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary">
              {t('locations.save')}
            </Button>
            <Button type="button" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </PanelBody>
    </Panel>
  );
}

function Input({
  label,
  value,
  setValue,
  required = false,
  type = 'text',
}: {
  label: string;
  value: string;
  setValue: (value: string) => void;
  required?: boolean;
  type?: 'text' | 'number';
}) {
  return (
    <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
      {label}
      <input
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
        type={type}
        value={value}
        required={required}
        step={type === 'number' ? 'any' : undefined}
        onChange={(event) => setValue(event.target.value)}
      />
    </label>
  );
}

function LocationConfirmation({
  mode,
  onConfirm,
  onCancel,
}: {
  mode: 'archive' | 'delete';
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const archive = mode === 'archive';
  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>{t(archive ? 'locations.archiveTitle' : 'locations.deleteTitle')}</PanelTitle>
          <PanelDescription>{t(archive ? 'locations.archiveWarning' : 'locations.deleteWarning')}</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="flex-row flex-wrap">
        <Button variant="danger" onClick={onConfirm}>
          {t(archive ? 'locations.archiveConfirm' : 'locations.deleteConfirm')}
        </Button>
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
      </PanelBody>
    </Panel>
  );
}
function Alert({ children }: { children: string }) {
  return (
    <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">
      {children}
    </p>
  );
}
