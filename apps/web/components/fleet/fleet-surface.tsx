'use client';

import { useMutation, usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';

import { api } from '@priamo/convex/api';

import { VehicleClassPicker } from '@/components/fleet/vehicle-class-picker';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ProviderPicker } from '@/components/providers/provider-picker';
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
import { catalogueArgs, fleetCatalogueArgs } from '@/lib/catalogue-filters';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { roleAtLeast } from '@/lib/roles';
import { archivalStatuses, type ArchivalStatus } from '@/lib/status';
import { optionalTextMutationValue, storedOptionalText } from '@/lib/stored-optional-text';
import { useDebouncedValue } from '@/lib/use-debounced-value';

type VehicleClass = FunctionReturnType<typeof api.vehicles.queries.listVehicleClasses>['page'][number];
type FleetVehicle = FunctionReturnType<typeof api.vehicles.queries.listFleetVehicles>['page'][number];
type Provider = FunctionReturnType<typeof api.providers.queries.listProviders>['page'][number];
type ProviderId = FleetVehicle['providerId'];
type VehicleClassId = FleetVehicle['vehicleClassId'];
type Editor =
  | { kind: 'class'; vehicleClass?: VehicleClass | undefined }
  | { kind: 'vehicle'; vehicle?: FleetVehicle | undefined }
  | null;
type ArchiveTarget = { kind: 'class'; row: VehicleClass } | { kind: 'vehicle'; row: FleetVehicle } | null;

export function FleetSurface() {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const organizationId = currentOrganization?.organization._id;
  const [classSearch, setClassSearch] = useState('');
  const [classStatus, setClassStatus] = useState<ArchivalStatus | ''>('');
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [vehicleStatus, setVehicleStatus] = useState<ArchivalStatus | ''>('');
  const [providerId, setProviderId] = useState<ProviderId | ''>('');
  const [vehicleClassId, setVehicleClassId] = useState<VehicleClassId | ''>('');
  const debouncedClassSearch = useDebouncedValue(classSearch);
  const debouncedVehicleSearch = useDebouncedValue(vehicleSearch);
  const classes = usePaginatedQuery(
    api.vehicles.queries.listVehicleClasses,
    catalogueArgs(organizationId, { search: debouncedClassSearch, status: classStatus }),
    { initialNumItems: 25 },
  );
  const vehicles = usePaginatedQuery(
    api.vehicles.queries.listFleetVehicles,
    fleetCatalogueArgs(organizationId, {
      search: debouncedVehicleSearch,
      status: vehicleStatus,
      providerId,
      vehicleClassId,
    }),
    { initialNumItems: 25 },
  );
  const providerOptions = usePaginatedQuery(
    api.providers.queries.listProviders,
    organizationId === undefined ? 'skip' : { organizationId },
    { initialNumItems: 100 },
  );
  const classOptions = usePaginatedQuery(
    api.vehicles.queries.listVehicleClasses,
    organizationId === undefined ? 'skip' : { organizationId },
    { initialNumItems: 100 },
  );
  const createClass = useMutation(api.vehicles.mutations.createVehicleClass);
  const updateClass = useMutation(api.vehicles.mutations.updateVehicleClass);
  const archiveClass = useMutation(api.vehicles.mutations.archiveVehicleClass);
  const createVehicle = useMutation(api.vehicles.mutations.createFleetVehicle);
  const updateVehicle = useMutation(api.vehicles.mutations.updateFleetVehicle);
  const archiveVehicle = useMutation(api.vehicles.mutations.archiveFleetVehicle);
  const [editor, setEditor] = useState<Editor>(null);
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (currentOrganization === null) return null;
  const canManage = roleAtLeast(currentOrganization.role, 'admin');

  async function confirmArchive(): Promise<void> {
    if (archiveTarget === null) return;
    try {
      if (archiveTarget.kind === 'class') await archiveClass({ vehicleClassId: archiveTarget.row._id });
      else await archiveVehicle({ fleetVehicleId: archiveTarget.row._id });
      setArchiveTarget(null);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {message === null ? null : <Alert>{message}</Alert>}
      {editor?.kind === 'class' ? (
        <VehicleClassEditor
          vehicleClass={editor.vehicleClass}
          organizationId={currentOrganization.organization._id}
          onClose={() => setEditor(null)}
          onCreate={createClass}
          onUpdate={updateClass}
        />
      ) : null}
      {editor?.kind === 'vehicle' ? (
        <FleetVehicleEditor
          vehicle={editor.vehicle}
          organizationId={currentOrganization.organization._id}
          onClose={() => setEditor(null)}
          onCreate={createVehicle}
          onUpdate={updateVehicle}
        />
      ) : null}
      {/* Stacked sections keep both peer catalogues visible and independently pageable. Tabs would hide state and
          add navigation to a screen with only two closely related working sets; only Vehicles is the focal panel. */}
      <section className="flex flex-col gap-4">
        {canManage && editor === null ? (
          <PageHeader
            actions={<Button onClick={() => setEditor({ kind: 'class' })}>{t('fleet.createClass')}</Button>}
          />
        ) : null}
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>{t('fleet.classesTitle')}</PanelTitle>
              <PanelDescription>{t('fleet.classesDescription')}</PanelDescription>
            </div>
          </PanelHeader>
          <PanelBody>
            <CatalogueFilters
              search={classSearch}
              setSearch={setClassSearch}
              status={classStatus}
              setStatus={setClassStatus}
            />
          </PanelBody>
          {classes.status === 'Exhausted' && classes.results.length === 0 ? (
            <PanelBody>
              <EmptyState
                tone={classSearch.trim() !== '' || classStatus !== '' ? 'filtered' : 'empty'}
                title={t(
                  classSearch.trim() !== '' || classStatus !== '' ? 'fleet.noMatchesTitle' : 'fleet.classesEmptyTitle',
                )}
                description={t(
                  classSearch.trim() !== '' || classStatus !== '' ? 'fleet.noMatchesBody' : 'fleet.classesEmptyBody',
                )}
              />
            </PanelBody>
          ) : (
            <VehicleClassTable
              rows={classes.results}
              loading={classes.status === 'LoadingFirstPage'}
              canManage={canManage}
              onEdit={(vehicleClass) => setEditor({ kind: 'class', vehicleClass })}
              onArchive={(row) => setArchiveTarget({ kind: 'class', row })}
            />
          )}
        </Panel>
        <TableLoadMore status={classes.status} loadedCount={classes.results.length} onLoadMore={classes.loadMore} />
      </section>
      <section className="flex flex-col gap-4">
        {canManage && editor === null ? (
          <PageHeader
            actions={
              <Button variant="primary" onClick={() => setEditor({ kind: 'vehicle' })}>
                {t('fleet.createVehicle')}
              </Button>
            }
          />
        ) : null}
        <Panel emphasis={editor === null && archiveTarget === null ? 'focal' : 'module'}>
          <PanelHeader>
            <div>
              <PanelTitle>{t('fleet.vehiclesTitle')}</PanelTitle>
              <PanelDescription>{t('fleet.vehiclesDescription')}</PanelDescription>
            </div>
          </PanelHeader>
          <PanelBody>
            <VehicleFilters
              search={vehicleSearch}
              setSearch={setVehicleSearch}
              status={vehicleStatus}
              setStatus={setVehicleStatus}
              providerId={providerId}
              setProviderId={setProviderId}
              vehicleClassId={vehicleClassId}
              setVehicleClassId={setVehicleClassId}
              providers={providerOptions.results}
              classes={classOptions.results}
              providersCanLoadMore={providerOptions.status === 'CanLoadMore'}
              classesCanLoadMore={classOptions.status === 'CanLoadMore'}
              onLoadMoreProviders={() => providerOptions.loadMore(100)}
              onLoadMoreClasses={() => classOptions.loadMore(100)}
            />
          </PanelBody>
          {vehicles.status === 'Exhausted' && vehicles.results.length === 0 ? (
            <PanelBody>
              <EmptyState
                tone={
                  hasVehicleFilters(vehicleSearch, vehicleStatus, providerId, vehicleClassId) ? 'filtered' : 'empty'
                }
                title={t(
                  hasVehicleFilters(vehicleSearch, vehicleStatus, providerId, vehicleClassId)
                    ? 'fleet.noMatchesTitle'
                    : 'fleet.vehiclesEmptyTitle',
                )}
                description={t(
                  hasVehicleFilters(vehicleSearch, vehicleStatus, providerId, vehicleClassId)
                    ? 'fleet.noMatchesBody'
                    : 'fleet.vehiclesEmptyBody',
                )}
              />
            </PanelBody>
          ) : (
            <FleetVehicleTable
              rows={vehicles.results}
              providers={providerOptions.results}
              classes={classOptions.results}
              providersExhausted={providerOptions.status === 'Exhausted'}
              classesExhausted={classOptions.status === 'Exhausted'}
              loading={vehicles.status === 'LoadingFirstPage'}
              canManage={canManage}
              onEdit={(vehicle) => setEditor({ kind: 'vehicle', vehicle })}
              onArchive={(row) => setArchiveTarget({ kind: 'vehicle', row })}
            />
          )}
        </Panel>
        <TableLoadMore status={vehicles.status} loadedCount={vehicles.results.length} onLoadMore={vehicles.loadMore} />
      </section>
      {archiveTarget === null ? null : (
        <ConfirmationPanel onCancel={() => setArchiveTarget(null)} onConfirm={confirmArchive} />
      )}
    </div>
  );
}

function VehicleClassTable({
  rows,
  loading,
  canManage,
  onEdit,
  onArchive,
}: {
  rows: readonly VehicleClass[];
  loading: boolean;
  canManage: boolean;
  onEdit: (row: VehicleClass) => void;
  onArchive: (row: VehicleClass) => void;
}) {
  const t = useTranslations();
  return (
    <PanelBodyFlush>
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t('fleet.name')}</TableHeaderCell>
            <TableHeaderCell>{t('fleet.key')}</TableHeaderCell>
            <TableHeaderCell align="end">{t('fleet.passengerCapacity')}</TableHeaderCell>
            <TableHeaderCell>{t('fleet.cargoCapacityNote')}</TableHeaderCell>
            <TableHeaderCell>{t('fleet.status')}</TableHeaderCell>
            {canManage ? <TableHeaderCell /> : null}
          </TableRow>
        </TableHead>
        {loading ? (
          <TableSkeletonRows columns={canManage ? 6 : 5} />
        ) : (
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row._id}>
                <TableRowHeaderCell>{row.name}</TableRowHeaderCell>
                <TableCell mono>{row.key}</TableCell>
                <TableCell mono align="end">
                  {row.passengerCapacity ?? t('fleet.notSet')}
                </TableCell>
                <TableCell>{storedOptionalText(row.cargoCapacityNote, t('fleet.notSet'))}</TableCell>
                <TableCell>
                  <StatusChip kind="archival" status={row.status} />
                </TableCell>
                {canManage ? (
                  <TableCell align="end">
                    <RowActions
                      active={row.status === 'active'}
                      onEdit={() => onEdit(row)}
                      onArchive={() => onArchive(row)}
                    />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        )}
      </Table>
    </PanelBodyFlush>
  );
}

function FleetVehicleTable({
  rows,
  providers,
  classes,
  providersExhausted,
  classesExhausted,
  loading,
  canManage,
  onEdit,
  onArchive,
}: {
  rows: readonly FleetVehicle[];
  providers: readonly Provider[];
  classes: readonly VehicleClass[];
  providersExhausted: boolean;
  classesExhausted: boolean;
  loading: boolean;
  canManage: boolean;
  onEdit: (row: FleetVehicle) => void;
  onArchive: (row: FleetVehicle) => void;
}) {
  const t = useTranslations();
  return (
    <PanelBodyFlush>
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t('fleet.plate')}</TableHeaderCell>
            <TableHeaderCell>{t('fleet.label')}</TableHeaderCell>
            <TableHeaderCell>{t('fleet.provider')}</TableHeaderCell>
            <TableHeaderCell>{t('fleet.vehicleClass')}</TableHeaderCell>
            <TableHeaderCell align="end">{t('fleet.year')}</TableHeaderCell>
            <TableHeaderCell>{t('fleet.status')}</TableHeaderCell>
            {canManage ? <TableHeaderCell /> : null}
          </TableRow>
        </TableHead>
        {loading ? (
          <TableSkeletonRows columns={canManage ? 7 : 6} />
        ) : (
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row._id}>
                <TableRowHeaderCell>
                  <span className="font-mono">{row.plate}</span>
                </TableRowHeaderCell>
                <TableCell>{storedOptionalText(row.label, t('fleet.notSet'))}</TableCell>
                <TableCell>
                  {/* Provider and Class ids are required, so an unresolved id is never legitimately "not set". */}
                  {providers.find((provider) => provider._id === row.providerId)?.name ??
                    t(providersExhausted ? 'errors.notFound' : 'fleet.providerStillLoading')}
                </TableCell>
                <TableCell>
                  {classes.find((item) => item._id === row.vehicleClassId)?.name ??
                    t(classesExhausted ? 'errors.notFound' : 'fleet.classStillLoading')}
                </TableCell>
                <TableCell mono align="end">
                  {row.year ?? t('fleet.notSet')}
                </TableCell>
                <TableCell>
                  <StatusChip kind="archival" status={row.status} />
                </TableCell>
                {canManage ? (
                  <TableCell align="end">
                    <RowActions
                      active={row.status === 'active'}
                      onEdit={() => onEdit(row)}
                      onArchive={() => onArchive(row)}
                    />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        )}
      </Table>
    </PanelBodyFlush>
  );
}

function CatalogueFilters({
  search,
  setSearch,
  status,
  setStatus,
}: {
  search: string;
  setSearch: (value: string) => void;
  status: ArchivalStatus | '';
  setStatus: (value: ArchivalStatus | '') => void;
}) {
  const t = useTranslations();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <FilterLabel label={t('fleet.search')}>
        <input className={controlClass} value={search} onChange={(event) => setSearch(event.target.value)} />
      </FilterLabel>
      <StatusFilter value={status} onChange={setStatus} />
    </div>
  );
}

function VehicleFilters({
  search,
  setSearch,
  status,
  setStatus,
  providerId,
  setProviderId,
  vehicleClassId,
  setVehicleClassId,
  providers,
  classes,
  providersCanLoadMore,
  classesCanLoadMore,
  onLoadMoreProviders,
  onLoadMoreClasses,
}: {
  search: string;
  setSearch: (value: string) => void;
  status: ArchivalStatus | '';
  setStatus: (value: ArchivalStatus | '') => void;
  providerId: ProviderId | '';
  setProviderId: (value: ProviderId | '') => void;
  vehicleClassId: VehicleClassId | '';
  setVehicleClassId: (value: VehicleClassId | '') => void;
  providers: readonly Provider[];
  classes: readonly VehicleClass[];
  providersCanLoadMore: boolean;
  classesCanLoadMore: boolean;
  onLoadMoreProviders: () => void;
  onLoadMoreClasses: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <FilterLabel label={t('fleet.search')}>
        <input className={controlClass} value={search} onChange={(event) => setSearch(event.target.value)} />
      </FilterLabel>
      <StatusFilter value={status} onChange={setStatus} />
      <div className="flex flex-col gap-2">
        <FilterLabel label={t('fleet.provider')}>
          <select
            className={controlClass}
            value={providerId}
            onChange={(event) => {
              setProviderId(providers.find((provider) => provider._id === event.target.value)?._id ?? '');
            }}
          >
            <option value="">{t('fleet.allProviders')}</option>
            {providers.map((provider) => (
              <option key={provider._id} value={provider._id}>
                {provider.name}
              </option>
            ))}
          </select>
        </FilterLabel>
        {providersCanLoadMore ? (
          <Button type="button" size="sm" onClick={onLoadMoreProviders}>
            {t('table.loadMore')}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <FilterLabel label={t('fleet.vehicleClass')}>
          <select
            className={controlClass}
            value={vehicleClassId}
            onChange={(event) => {
              setVehicleClassId(classes.find((item) => item._id === event.target.value)?._id ?? '');
            }}
          >
            <option value="">{t('fleet.allClasses')}</option>
            {classes.map((item) => (
              <option key={item._id} value={item._id}>
                {item.name}
              </option>
            ))}
          </select>
        </FilterLabel>
        {classesCanLoadMore ? (
          <Button type="button" size="sm" onClick={onLoadMoreClasses}>
            {t('table.loadMore')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function StatusFilter({
  value,
  onChange,
}: {
  value: ArchivalStatus | '';
  onChange: (value: ArchivalStatus | '') => void;
}) {
  const t = useTranslations();
  return (
    <FilterLabel label={t('fleet.statusFilter')}>
      <select
        className={controlClass}
        value={value}
        onChange={(event) => {
          onChange(archivalStatuses.find((item) => item === event.target.value) ?? '');
        }}
      >
        <option value="">{t('fleet.allStatuses')}</option>
        {archivalStatuses.map((item) => (
          <option key={item} value={item}>
            {t(`fields.statuses.${item}`)}
          </option>
        ))}
      </select>
    </FilterLabel>
  );
}

function VehicleClassEditor({
  vehicleClass,
  organizationId,
  onClose,
  onCreate,
  onUpdate,
}: {
  vehicleClass?: VehicleClass | undefined;
  organizationId: FunctionArgs<typeof api.vehicles.mutations.createVehicleClass>['organizationId'];
  onClose: () => void;
  onCreate: ReturnType<typeof useMutation<typeof api.vehicles.mutations.createVehicleClass>>;
  onUpdate: ReturnType<typeof useMutation<typeof api.vehicles.mutations.updateVehicleClass>>;
}) {
  const t = useTranslations();
  const [key, setKey] = useState(vehicleClass?.key ?? '');
  const [name, setName] = useState(vehicleClass?.name ?? '');
  const [description, setDescription] = useState(vehicleClass?.description ?? '');
  const [passengerCapacity, setPassengerCapacity] = useState(
    vehicleClass?.passengerCapacity === undefined ? '' : String(vehicleClass.passengerCapacity),
  );
  const [cargoCapacityNote, setCargoCapacityNote] = useState(vehicleClass?.cargoCapacityNote ?? '');
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const descriptionValue = optionalTextMutationValue(description, vehicleClass?.description);
    const cargoCapacityNoteValue = optionalTextMutationValue(cargoCapacityNote, vehicleClass?.cargoCapacityNote);
    const values = {
      name,
      ...(descriptionValue === undefined ? {} : { description: descriptionValue }),
      ...(passengerCapacity === '' ? {} : { passengerCapacity: Number(passengerCapacity) }),
      ...(cargoCapacityNoteValue === undefined ? {} : { cargoCapacityNote: cargoCapacityNoteValue }),
    };
    try {
      if (vehicleClass === undefined) await onCreate({ organizationId, key, ...values });
      else await onUpdate({ vehicleClassId: vehicleClass._id, ...values });
      onClose();
    } catch (caught) {
      setError(t(errorMessageKey(presentConvexError(caught))));
    }
  }
  return (
    <EditorPanel title={t(vehicleClass === undefined ? 'fleet.createClassTitle' : 'fleet.editClassTitle')}>
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label={t('fleet.key')} value={key} setValue={setKey} required disabled={vehicleClass !== undefined} />
          <Input label={t('fleet.name')} value={name} setValue={setName} required />
          <Input
            label={t('fleet.passengerCapacity')}
            value={passengerCapacity}
            setValue={setPassengerCapacity}
            type="number"
          />
          <Input label={t('fleet.cargoCapacityNote')} value={cargoCapacityNote} setValue={setCargoCapacityNote} />
          <TextArea label={t('fleet.description')} value={description} setValue={setDescription} />
        </div>
        {error === null ? null : <Alert>{error}</Alert>}
        <EditorActions onClose={onClose} />
      </form>
    </EditorPanel>
  );
}

function FleetVehicleEditor({
  vehicle,
  organizationId,
  onClose,
  onCreate,
  onUpdate,
}: {
  vehicle?: FleetVehicle | undefined;
  organizationId: FunctionArgs<typeof api.vehicles.mutations.createFleetVehicle>['organizationId'];
  onClose: () => void;
  onCreate: ReturnType<typeof useMutation<typeof api.vehicles.mutations.createFleetVehicle>>;
  onUpdate: ReturnType<typeof useMutation<typeof api.vehicles.mutations.updateFleetVehicle>>;
}) {
  const t = useTranslations();
  const [providerId, setProviderId] = useState<ProviderId | undefined>(vehicle?.providerId);
  const [vehicleClassId, setVehicleClassId] = useState<VehicleClassId | undefined>(vehicle?.vehicleClassId);
  const [plate, setPlate] = useState(vehicle?.plate ?? '');
  const [label, setLabel] = useState(vehicle?.label ?? '');
  const [year, setYear] = useState(vehicle?.year === undefined ? '' : String(vehicle.year));
  const [notes, setNotes] = useState(vehicle?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (providerId === undefined || vehicleClassId === undefined) return;
    const labelValue = optionalTextMutationValue(label, vehicle?.label);
    const notesValue = optionalTextMutationValue(notes, vehicle?.notes);
    const values = {
      plate,
      ...(labelValue === undefined ? {} : { label: labelValue }),
      ...(year === '' ? {} : { year: Number(year) }),
      ...(notesValue === undefined ? {} : { notes: notesValue }),
    };
    try {
      if (vehicle === undefined) await onCreate({ organizationId, providerId, vehicleClassId, ...values });
      else {
        // Unchanged references are omitted so editing another field does not
        // revalidate a Provider or Class that was archived after assignment.
        await onUpdate({
          fleetVehicleId: vehicle._id,
          ...values,
          ...(providerId === vehicle.providerId ? {} : { providerId }),
          ...(vehicleClassId === vehicle.vehicleClassId ? {} : { vehicleClassId }),
        });
      }
      onClose();
    } catch (caught) {
      setError(t(errorMessageKey(presentConvexError(caught))));
    }
  }
  return (
    <EditorPanel title={t(vehicle === undefined ? 'fleet.createVehicleTitle' : 'fleet.editVehicleTitle')}>
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label={t('fleet.plate')} value={plate} setValue={setPlate} required />
          <Input label={t('fleet.label')} value={label} setValue={setLabel} />
          <Input label={t('fleet.year')} value={year} setValue={setYear} type="number" />
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={labelClass}>{t('fleet.provider')}</span>
            <ProviderPicker value={providerId} onChange={setProviderId} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={labelClass}>{t('fleet.vehicleClass')}</span>
            <VehicleClassPicker value={vehicleClassId} onChange={setVehicleClassId} />
          </div>
          <TextArea label={t('fleet.notes')} value={notes} setValue={setNotes} />
        </div>
        {error === null ? null : <Alert>{error}</Alert>}
        <EditorActions onClose={onClose} disabled={providerId === undefined || vehicleClassId === undefined} />
      </form>
    </EditorPanel>
  );
}

function RowActions({ active, onEdit, onArchive }: { active: boolean; onEdit: () => void; onArchive: () => void }) {
  const t = useTranslations();
  return active ? (
    <div className="flex flex-wrap justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={onEdit}>
        {t('fleet.edit')}
      </Button>
      <Button size="sm" variant="ghost" onClick={onArchive}>
        {t('fleet.archive')}
      </Button>
    </div>
  ) : null;
}

function ConfirmationPanel({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => Promise<void> }) {
  const t = useTranslations();
  return (
    <EditorPanel title={t('fleet.archiveTitle')} description={t('fleet.archiveWarning')}>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" onClick={onConfirm}>
          {t('fleet.archiveConfirm')}
        </Button>
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </EditorPanel>
  );
}

function EditorPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>{title}</PanelTitle>
          {description === undefined ? null : <PanelDescription>{description}</PanelDescription>}
        </div>
      </PanelHeader>
      <PanelBody>{children}</PanelBody>
    </Panel>
  );
}

function EditorActions({ onClose, disabled = false }: { onClose: () => void; disabled?: boolean | undefined }) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="primary" disabled={disabled}>
        {t('fleet.save')}
      </Button>
      <Button type="button" onClick={onClose}>
        {t('common.cancel')}
      </Button>
    </div>
  );
}

function Input({
  label,
  value,
  setValue,
  type = 'text',
  required = false,
  disabled = false,
}: {
  label: string;
  value: string;
  setValue: (value: string) => void;
  type?: 'text' | 'number' | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  return (
    <label className={labelClass}>
      {label}
      <input
        className={controlClass}
        value={value}
        type={type}
        required={required}
        disabled={disabled}
        step={type === 'number' ? '1' : undefined}
        onChange={(event) => setValue(event.target.value)}
      />
    </label>
  );
}

function TextArea({ label, value, setValue }: { label: string; value: string; setValue: (value: string) => void }) {
  return (
    <label className={`${labelClass} sm:col-span-2`}>
      {label}
      <textarea
        className="min-h-24 rounded-input border border-line bg-ground-2 px-3 py-2 text-sm normal-case tracking-normal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </label>
  );
}

function FilterLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={labelClass}>
      {label}
      {children}
    </label>
  );
}

function hasVehicleFilters(
  search: string,
  status: ArchivalStatus | '',
  providerId: ProviderId | '',
  vehicleClassId: VehicleClassId | '',
): boolean {
  return search.trim() !== '' || status !== '' || providerId !== '' || vehicleClassId !== '';
}

function Alert({ children }: { children: string }) {
  return (
    <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">
      {children}
    </p>
  );
}

const labelClass = 'flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2';
const controlClass = 'h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal';
