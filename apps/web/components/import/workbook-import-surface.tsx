'use client';

import { useMutation, usePaginatedQuery, useQueries, useQuery, type RequestForQueries } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeaderCell } from '@/components/ui/table';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { formatFieldValue } from '@/lib/field-value-format';
import { importRow } from '@/lib/import-row';
import {
  importSnapshot,
  rateResultForWrite,
  rowRateResult,
  type ImportSnapshot,
} from '@/lib/import-snapshot';
import {
  canConfirmImport,
  canSetImportRowAction,
  importRowIsBlocked,
  importRowSkipReason,
  importSelectionCounts,
  initialImportRowAction,
  nextImportRowIndex,
  recordImportRowOutcome,
  runSummary,
  startImportRun,
  stopImportRun,
  type ImportRowAction,
  type ImportRowOutcome,
  type ImportRunState,
} from '@/lib/import-run';
import { moneyDisplay } from '@/lib/money';
import {
  distinctRateLookupRequests,
  rateLookupCollectionState,
  rateLookupQueryArgs,
  rateLookupResultsToRates,
  type RateLookupResult,
} from '@/lib/rate-lookup-result';
import { roleAtLeast } from '@/lib/roles';
import { readWorkbook, type WorkbookSheet } from '@/lib/workbook-file';
import {
  mappingProblems,
  targetFromValue,
  targetValue,
  type ColumnTarget,
  type MappingProblem,
  type VersionField,
  type WorkbookMapping,
} from '@/lib/workbook-mapping';
import {
  buildWorkbookPlan,
  summarizePlan,
  type PlannedRow,
  type RowProblem,
  type WorkbookCatalogues,
  type WorkbookPlan,
  type WorkbookRow,
} from '@/lib/workbook-plan';

type EventId = FunctionArgs<typeof api.events.queries.getEventDetail>['eventId'];
type ServiceKindVersionId = FunctionArgs<typeof api.services.mutations.createServiceFromServiceKind>['serviceKindVersionId'];
type FieldDefinitionId = FunctionArgs<typeof api.services.mutations.createServiceFromServiceKind>['values'][number]['fieldDefinitionId'];
type ProviderId = FunctionArgs<typeof api.assignments.mutations.createAssignment>['providerId'];
type CostCentreId = NonNullable<FunctionArgs<typeof api.assignments.mutations.createAssignment>['costCentreId']>;
type VehicleClassId = FunctionArgs<typeof api.assignments.mutations.createAssignmentRevision>['vehicleClassId'];

const pageSize = 200;
const previewCellCount = 3;
function cellText(cell: WorkbookRow['cells'][number] | undefined): string {
  if (cell === undefined || cell === null) return '';
  return String(cell);
}

export function WorkbookImportSurface({ eventId }: { eventId: EventId }) {
  const t = useTranslations('workbookImport');
  const rootT = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const organizationId = currentOrganization?.organization._id;
  const readSequence = useRef(0);
  const [sheets, setSheets] = useState<readonly WorkbookSheet[]>();
  const [fileName, setFileName] = useState('');
  const [fileProblem, setFileProblem] = useState(false);
  const [reading, setReading] = useState(false);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [sheetConfirmed, setSheetConfirmed] = useState(false);
  const [versionId, setVersionId] = useState<string>();
  const [headerRowNumber, setHeaderRowNumber] = useState(1);
  const [mapping, setMapping] = useState<WorkbookMapping>([]);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [importRunning, setImportRunning] = useState(false);

  const detail = useQuery(api.events.queries.getEventDetail, { eventId });
  const serviceKinds = usePaginatedQuery(
    api.serviceKinds.queries.listPublishedServiceKinds,
    organizationId === undefined ? 'skip' : { organizationId },
    { initialNumItems: pageSize },
  );
  const locations = usePaginatedQuery(
    api.locations.queries.listLocations,
    organizationId === undefined ? 'skip' : { organizationId, status: 'active' },
    { initialNumItems: pageSize },
  );
  const providers = usePaginatedQuery(
    api.providers.queries.listProviders,
    organizationId === undefined ? 'skip' : { organizationId, status: 'active' },
    { initialNumItems: pageSize },
  );
  const vehicleClasses = usePaginatedQuery(
    api.vehicles.queries.listVehicleClasses,
    organizationId === undefined ? 'skip' : { organizationId, status: 'active' },
    { initialNumItems: pageSize },
  );
  const costCentres = usePaginatedQuery(
    api.costCentres.queries.listCostCentres,
    organizationId === undefined ? 'skip' : { organizationId, status: 'active' },
    { initialNumItems: pageSize },
  );
  const existingServices = usePaginatedQuery(
    api.services.queries.listEventServices,
    { eventId },
    { initialNumItems: pageSize },
  );

  const selectedKind = serviceKinds.results.find((entry) => entry.publishedVersion._id === versionId);
  const selectedVersionId = selectedKind?.publishedVersion._id;
  const fields = useQuery(
    api.serviceKinds.fields.queries.listServiceKindFields,
    selectedVersionId === undefined ? 'skip' : { serviceKindVersionId: selectedVersionId },
  );
  const definitions = useQuery(
    api.fields.queries.getFieldDefinitionsByIds,
    fields === undefined || organizationId === undefined
      ? 'skip'
      : { organizationId, fieldDefinitionIds: fields.map((field) => field.fieldDefinitionId) },
  );

  const selectedSheet = sheets?.[sheetIndex];
  const columnCount = selectedSheet === undefined
    ? 0
    : selectedSheet.rows.reduce((largest, row) => Math.max(largest, row.length), 0);
  const header = selectedSheet?.rows[headerRowNumber - 1] ?? [];
  const dataRows: readonly WorkbookRow[] = (selectedSheet?.rows.slice(headerRowNumber) ?? []).map((cells, index) => ({
    rowNumber: headerRowNumber + index + 1,
    cells,
  }));
  const versionFields = (fields ?? []).map((field) => ({
    fieldDefinitionId: field.fieldDefinitionId,
    required: field.required,
    config: field.config,
    ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    ...(field.defaultLocationId === undefined ? {} : { defaultLocationId: field.defaultLocationId }),
  }));
  const fieldLabels = new Map((definitions ?? []).map((definition) => [definition._id, definition.label]));
  const currentMappingProblems = mappingProblems(mapping, versionFields);
  const catalogueQueries = [locations, providers, vehicleClasses, costCentres, existingServices] as const;
  const cataloguesComplete = catalogueQueries.every((query) => query.status === 'Exhausted');
  const catalogues: WorkbookCatalogues = {
    locations: locations.results.map((item) => ({ id: item._id, name: item.name })),
    providers: providers.results.map((item) => ({ id: item._id, name: item.name })),
    vehicleClasses: vehicleClasses.results.map((item) => ({ id: item._id, name: item.name })),
    costCentres: costCentres.results.map((item) => ({ id: item._id, name: item.name })),
    existingServices: existingServices.results.map((item) => ({ id: item._id, name: item.name, startsAt: item.startsAt })),
    rates: [],
  };
  const canPreview = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');
  const canConfigure = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'admin');
  const mappingReady = mapping.length === columnCount && currentMappingProblems.length === 0;
  const basePlan = buildWorkbookPlan({ rows: dataRows, mapping, versionFields, catalogues });
  const rateRequests = previewRequested ? distinctRateLookupRequests(basePlan.rows) : [];
  const providerIds = new Map(providers.results.map((item) => [String(item._id), item._id]));
  const vehicleClassIds = new Map(vehicleClasses.results.map((item) => [String(item._id), item._id]));
  const queryArgs = previewRequested && canPreview
    ? rateLookupQueryArgs(rateRequests, providerIds, vehicleClassIds)
    : { ready: [], missing: [] };
  const priceQueries: RequestForQueries = Object.fromEntries(queryArgs.ready.map((entry) => [entry.key, {
    query: api.assignments.queries.resolveProspectiveRate,
    args: { eventId, providerId: entry.providerId, vehicleClassId: entry.vehicleClassId, modality: entry.modality },
  }]));
  const rawRateResults: Readonly<Record<string, unknown>> = useQueries(priceQueries);
  // `useQueries` yields an Error for a query that threw, and an Error is not
  // `undefined` — so a bare presence check would let a failed lookup through as
  // though pricing had succeeded, and the row would be written as unpriced.
  //
  // A request whose catalogue entry is missing is a failure, not a pending query:
  // nothing will ever fill its key, so calling it `'loading'` hangs the preview.
  const pricingState = queryArgs.missing.length > 0
    ? 'error'
    : rateLookupCollectionState(rateRequests, rawRateResults);
  const rates = rateLookupResultsToRates(rateRequests, rawRateResults);
  const plan = buildWorkbookPlan({ rows: dataRows, mapping, versionFields, catalogues: { ...catalogues, rates } });

  if (currentOrganization === null || organizationId === undefined || detail === undefined) return null;

  async function chooseFile(file: File | undefined): Promise<void> {
    if (importRunning) return;
    const sequence = readSequence.current + 1;
    readSequence.current = sequence;
    setFileName(file?.name ?? '');
    setFileProblem(false);
    setSheets(undefined);
    setSheetConfirmed(false);
    setVersionId(undefined);
    setMapping([]);
    setPreviewRequested(false);
    if (file === undefined) return;
    setReading(true);
    const result = await readWorkbook(file);
    if (readSequence.current !== sequence) return;
    setReading(false);
    if (!result.ok) {
      setFileProblem(true);
      return;
    }
    setSheets(result.sheets);
    setSheetIndex(0);
    setHeaderRowNumber(1);
  }

  function resetMapping(nextHeaderRow: number): void {
    setHeaderRowNumber(nextHeaderRow);
    setMapping(Array.from({ length: columnCount }, () => ({ kind: 'ignored' })));
    setPreviewRequested(false);
  }

  function loadMoreCatalogues(): void {
    for (const query of catalogueQueries) {
      if (query.status === 'CanLoadMore') query.loadMore(pageSize);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel emphasis="focal">
        <PanelHeader>
          <div>
            <PanelTitle>{t('title')}</PanelTitle>
            <PanelDescription>{t('description', { event: detail.event.name })}</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody>
          <Field>
            <FieldLabel required>{t('file')}</FieldLabel>
            <FieldControl
              render={<input type="file" disabled={importRunning} />}
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => chooseFile(event.target.files?.[0])}
            />
            <FieldDescription>{t('localOnly')}</FieldDescription>
          </Field>
          {reading ? <p className="text-sm text-ink-3">{t('reading', { file: fileName })}</p> : null}
          {fileProblem ? <p role="alert" className="text-sm text-tone-stop">{t('invalidWorkbook')}</p> : null}
          {sheets === undefined ? null : sheets.length === 0 ? (
            <EmptyState title={t('noSheets')} />
          ) : (
            <ul className="grid gap-2 text-sm text-ink-2 sm:grid-cols-2">
              {sheets.map((sheet) => (
                <li key={sheet.sheet} className="rounded-input border border-line bg-ground-2 px-3 py-2">
                  <span className="text-ink">{sheet.sheet}</span> · {t('rowCount', { count: sheet.rows.length })}
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

      {sheets === undefined || sheets.length === 0 ? null : (
        <StepPanel title={t('sheet')} description={t('sheetDescription')}>
          <Field>
            <FieldLabel required>{t('sheet')}</FieldLabel>
            <FieldControl
              render={<select disabled={importRunning} />}
              value={selectedSheet?.sheet ?? ''}
              onChange={(event) => {
                const nextSheetIndex = sheets.findIndex((sheet) => sheet.sheet === event.target.value);
                setSheetIndex(nextSheetIndex < 0 ? 0 : nextSheetIndex);
                setSheetConfirmed(false);
                setVersionId(undefined);
                setMapping([]);
                setPreviewRequested(false);
              }}
            >
              {sheets.map((sheet) => <option key={sheet.sheet} value={sheet.sheet}>{sheet.sheet}</option>)}
            </FieldControl>
          </Field>
          <Button type="button" variant="primary" disabled={importRunning} onClick={() => setSheetConfirmed(true)}>
            {t('confirmSheet')}
          </Button>
        </StepPanel>
      )}

      {!sheetConfirmed ? null : (
        <StepPanel title={t('serviceKind')} description={t('serviceKindDescription')}>
          <Field>
            <FieldLabel required>{t('serviceKind')}</FieldLabel>
            <FieldControl
              render={<select disabled={importRunning} />}
              value={selectedVersionId ?? ''}
              onChange={(event) => {
                const selected = serviceKinds.results.find((item) => item.publishedVersion._id === event.target.value);
                setVersionId(selected?.publishedVersion._id);
                setMapping([]);
                setPreviewRequested(false);
              }}
            >
              <option value="">{t('choose')}</option>
              {serviceKinds.results.map((entry) => (
                <option key={entry.publishedVersion._id} value={entry.publishedVersion._id}>
                  {entry.serviceKind.name} · {t('version', { version: entry.publishedVersion.versionNumber })}
                </option>
              ))}
            </FieldControl>
          </Field>
          {serviceKinds.status === 'CanLoadMore' ? (
            <Button type="button" size="sm" disabled={importRunning} onClick={() => serviceKinds.loadMore(pageSize)}>{rootT('table.loadMore')}</Button>
          ) : null}
        </StepPanel>
      )}

      {selectedVersionId === undefined || fields === undefined || definitions === undefined || selectedSheet === undefined ? null : (
        <>
          <StepPanel title={t('headerRow')} description={t('headerDescription')}>
            <Field>
              <FieldLabel required>{t('headerRow')}</FieldLabel>
              <FieldControl
                type="number"
                min={1}
                max={Math.max(1, selectedSheet.rows.length)}
                disabled={importRunning}
                value={headerRowNumber}
                onChange={(event) => {
                  if (
                    !Number.isSafeInteger(event.target.valueAsNumber) ||
                    event.target.valueAsNumber < 1 ||
                    event.target.valueAsNumber > selectedSheet.rows.length
                  ) return;
                  resetMapping(event.target.valueAsNumber);
                }}
              />
            </Field>
          </StepPanel>

          <StepPanel title={t('mapping')} description={t('mappingDescription')}>
            <div className="grid gap-3">
              {Array.from({ length: columnCount }, (_, column) => (
                <div key={column} className="grid gap-3 rounded-input border border-line bg-ground-2 p-3 md:grid-cols-[minmax(0,1fr)_minmax(14rem,0.8fr)]">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{cellText(header[column]) || t('unnamedColumn', { column: column + 1 })}</p>
                    <p className="mt-1 break-words text-xs text-ink-3">
                      {dataRows.slice(0, previewCellCount).map((row) => cellText(row.cells[column])).filter((value) => value !== '').join(' · ') || t('noSampleValues')}
                    </p>
                  </div>
                  <Field>
                    <FieldLabel>{t('target')}</FieldLabel>
                    <FieldControl
                      render={<select disabled={importRunning} />}
                      value={targetValue(mapping[column] ?? { kind: 'ignored' })}
                      onChange={(event) => {
                        const next = Array.from({ length: columnCount }, (_, index) => mapping[index] ?? { kind: 'ignored' as const });
                        next[column] = targetFromValue(event.target.value, versionFields.map((field) => field.fieldDefinitionId));
                        setMapping(next);
                        setPreviewRequested(false);
                      }}
                    >
                      <option value="ignored">{t('targetsIgnored')}</option>
                      <option value="serviceName">{t('targetsServiceName')}</option>
                      <option value="startsAtDate">{t('targetsStartsAtDate')}</option>
                      <option value="startsAtTime">{t('targetsStartsAtTime')}</option>
                      <option value="endsAtDate">{t('targetsEndsAtDate')}</option>
                      <option value="endsAtTime">{t('targetsEndsAtTime')}</option>
                      <option value="provider">{t('targetsProvider')}</option>
                      <option value="vehicleClass">{t('targetsVehicleClass')}</option>
                      <option value="modality">{t('targetsModality')}</option>
                      <option value="quantity">{t('targetsQuantity')}</option>
                      <option value="costCentre">{t('targetsCostCentre')}</option>
                      <option value="workbookAmount">{t('targetsWorkbookAmount')}</option>
                      {versionFields.map((field) => (
                        <option key={field.fieldDefinitionId} value={`field:${field.fieldDefinitionId}`}>
                          {t('targetsField', { field: fieldLabels.get(field.fieldDefinitionId) ?? rootT('common.notAvailable') })}
                        </option>
                      ))}
                    </FieldControl>
                  </Field>
                </div>
              ))}
            </div>
            {currentMappingProblems.length === 0 ? null : (
              <ul className="space-y-1 text-sm text-tone-stop">
                {currentMappingProblems.map((problem, index) => (
                  <li key={`${problem.kind}-${index}`}>{mappingProblemText(problem, t, fieldLabels)}</li>
                ))}
              </ul>
            )}
            {!canPreview ? <p className="text-sm text-ink-3">{t('plannerRequired')}</p> : null}
            {!cataloguesComplete ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-ink-3">{t('cataloguesIncomplete')}</p>
                {catalogueQueries.some((query) => query.status === 'CanLoadMore') ? (
                  <Button type="button" size="sm" disabled={importRunning} onClick={loadMoreCatalogues}>{t('loadMoreCatalogues')}</Button>
                ) : null}
              </div>
            ) : null}
            <Button
              type="button"
              variant={previewRequested ? 'secondary' : 'primary'}
              disabled={importRunning || !mappingReady || !cataloguesComplete || !canPreview || dataRows.length === 0}
              onClick={() => setPreviewRequested(true)}
            >
              {t('preview')}
            </Button>
          </StepPanel>
        </>
      )}

      {!previewRequested || selectedVersionId === undefined || fields === undefined ? null : pricingState !== 'complete' ? (
        <Panel><PanelBody>
          <p className={pricingState === 'error' ? 'text-sm text-tone-stop' : 'text-sm text-ink-3'}>
            {t(pricingState === 'error' ? 'pricingFailed' : 'pricing')}
          </p>
        </PanelBody></Panel>
      ) : (
        <Preview
          plan={plan}
          eventId={eventId}
          serviceKindVersionId={selectedVersionId}
          fieldDefinitionIds={new Map(fields.map((item) => [String(item.fieldDefinitionId), item.fieldDefinitionId]))}
          providerIds={providerIds}
          vehicleClassIds={vehicleClassIds}
          costCentreIds={new Map(costCentres.results.map((item) => [String(item._id), item._id]))}
          onRunningChange={setImportRunning}
          fieldLabels={fieldLabels}
          providerNames={new Map(providers.results.map((item) => [item._id, item.name]))}
          vehicleClassNames={new Map(vehicleClasses.results.map((item) => [item._id, item.name]))}
          costCentreNames={new Map(costCentres.results.map((item) => [item._id, item.name]))}
          locationNames={new Map(locations.results.map((item) => [item._id, item.name]))}
          versionFields={versionFields}
          rateResults={rawRateResults}
          canConfigure={canConfigure}
          locale={locale}
        />
      )}
    </div>
  );
}

function StepPanel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Panel>
      <PanelHeader><div><PanelTitle>{title}</PanelTitle><PanelDescription>{description}</PanelDescription></div></PanelHeader>
      <PanelBody>{children}</PanelBody>
    </Panel>
  );
}

type Translator = ReturnType<typeof useTranslations<'workbookImport'>>;

function mappingProblemText(problem: MappingProblem, t: Translator, labels: ReadonlyMap<string, string>): string {
  switch (problem.kind) {
    case 'duplicateTarget': return t('mappingDuplicate', { columns: problem.columns.map((column) => column + 1).join(', ') });
    case 'requiredTargetUnmapped': return t('mappingRequired', { target: targetLabel(problem.target, t) });
    case 'requiredFieldUnmapped': return t('mappingRequired', { target: labels.get(problem.fieldDefinitionId) ?? problem.fieldDefinitionId });
    case 'timeWithoutDate': return t('mappingTimeWithoutDate', { target: targetLabel(problem.target, t) });
    case 'endWithoutStart': return t('mappingEndWithoutStart');
    case 'partialAssignment': return t('mappingPartialAssignment', { targets: problem.missing.map((target) => targetLabel(target, t)).join(', ') });
    case 'workbookAmountWithoutAssignment': return t('mappingAmountWithoutAssignment');
  }
}

function targetLabel(target: string, t: Translator): string {
  const labels: Readonly<Record<string, string>> = {
    serviceName: t('targetsServiceName'), startsAtDate: t('targetsStartsAtDate'), startsAtTime: t('targetsStartsAtTime'),
    endsAtDate: t('targetsEndsAtDate'), endsAtTime: t('targetsEndsAtTime'), provider: t('targetsProvider'),
    vehicleClass: t('targetsVehicleClass'), modality: t('targetsModality'), quantity: t('targetsQuantity'),
    costCentre: t('targetsCostCentre'), location: t('targetsLocation'), workbookAmount: t('targetsWorkbookAmount'),
  };
  return labels[target] ?? target;
}

function Preview({
  plan: livePlan,
  eventId,
  serviceKindVersionId,
  fieldDefinitionIds,
  providerIds,
  vehicleClassIds,
  costCentreIds,
  onRunningChange,
  fieldLabels,
  providerNames,
  vehicleClassNames,
  costCentreNames,
  locationNames,
  versionFields,
  rateResults,
  canConfigure,
  locale,
}: {
  plan: WorkbookPlan;
  eventId: EventId;
  serviceKindVersionId: ServiceKindVersionId;
  fieldDefinitionIds: ReadonlyMap<string, FieldDefinitionId>;
  providerIds: ReadonlyMap<string, ProviderId>;
  vehicleClassIds: ReadonlyMap<string, VehicleClassId>;
  costCentreIds: ReadonlyMap<string, CostCentreId>;
  onRunningChange: (running: boolean) => void;
  fieldLabels: ReadonlyMap<string, string>;
  providerNames: ReadonlyMap<string, string>;
  vehicleClassNames: ReadonlyMap<string, string>;
  costCentreNames: ReadonlyMap<string, string>;
  locationNames: ReadonlyMap<string, string>;
  versionFields: readonly VersionField[];
  rateResults: Readonly<Record<string, unknown>>;
  canConfigure: boolean;
  locale: ReturnType<typeof useCanonicalLocale>;
}) {
  const t = useTranslations('workbookImport');
  const createService = useMutation(api.services.mutations.createServiceFromServiceKind);
  const createAssignment = useMutation(api.assignments.mutations.createAssignment);
  const createRevision = useMutation(api.assignments.mutations.createAssignmentRevision);
  const acceptRevision = useMutation(api.assignments.mutations.acceptAssignmentRevision);
  const stopRequestedRef = useRef(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [running, setRunning] = useState(false);
  const [runState, setRunState] = useState<ImportRunState>();
  const [actions, setActions] = useState<ReadonlyMap<number, ImportRowAction>>(() => new Map(
    livePlan.rows.map((row) => [row.rowNumber, initialImportRowAction(row, rowRateResult(row, rateResults))]),
  ));
  /**
   * One snapshot pins the rows AND their rates. `existingServices` is a live query
   * over the very Event being written into, so without the freeze the panel drifts
   * from "Will create: 100" to "Already exists: 100" beside a report reading
   * "Created: 100", and every created row grows a "matches an existing Service" note
   * for the Service it just created.
   */
  const liveSnapshot = importSnapshot(
    livePlan,
    (row) => rowRateResult(row, rateResults),
    (row) => actions.get(row.rowNumber) ?? initialImportRowAction(row, rowRateResult(row, rateResults)),
  );
  const [frozen, setFrozen] = useState<ImportSnapshot>();
  const view = frozen ?? liveSnapshot;
  const plan = view.plan;
  const itemsByRow = new Map(view.items.map((item) => [item.row.rowNumber, item]));
  const selectionCounts = importSelectionCounts(view.items);
  const summary = runState === undefined ? undefined : runSummary(runState);
  // Recomputed from the operator's current selections, so the panel agrees with the
  // confirmation counts below it rather than describing the untouched defaults.
  const planSummary = summarizePlan(
    plan.rows,
    (row) => itemsByRow.get(row.rowNumber)?.action ?? row.defaultAction,
  );

  /**
   * A tab closed between `createService` and `createAssignment` leaves a Service with
   * no Assignment AND no report row recording it — the one half-import the report
   * cannot describe. There is no rollback, so a warning is the only guard available.
   */
  useEffect(() => {
    if (!running) return undefined;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [running]);

  async function runImport(): Promise<void> {
    if (running || selectionCounts.services === 0) return;
    setFrozen(view);
    const items = view.items;
    stopRequestedRef.current = false;
    setStopRequested(false);
    setRunning(true);
    onRunningChange(true);
    let nextState = startImportRun(items.length);
    setRunState(nextState);
    let nextIndex = nextImportRowIndex(nextState);
    while (nextIndex !== undefined) {
      if (stopRequestedRef.current) {
        nextState = stopImportRun(nextState);
        setRunState(nextState);
        break;
      }
      const item = items[nextIndex];
      if (item === undefined) break;
      const outcome: ImportRowOutcome = item.action === 'skip'
        ? { kind: 'skipped', rowNumber: item.row.rowNumber, reason: importRowSkipReason(item.row, item.rateResult) }
        : await importRow(
          { createService, createAssignment, createRevision, acceptRevision },
          {
            row: item.row,
            rateResult: rateResultForWrite(item.rateResult),
            eventId,
            serviceKindVersionId,
            fieldDefinitionIds,
            providerIds,
            vehicleClassIds,
            costCentreIds,
          },
        );
      nextState = recordImportRowOutcome(nextState, outcome);
      setRunState(nextState);
      nextIndex = nextImportRowIndex(nextState);
    }
    setRunning(false);
    onRunningChange(false);
  }

  function requestStop(): void {
    stopRequestedRef.current = true;
    setStopRequested(true);
  }

  function updateAction(row: PlannedRow, action: ImportRowAction): void {
    const item = itemsByRow.get(row.rowNumber);
    if (runState !== undefined || item === undefined || !canSetImportRowAction(row, item.rateResult, action)) return;
    setActions((current) => new Map(current).set(row.rowNumber, action));
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader><PanelTitle>{t('summary')}</PanelTitle></PanelHeader>
        <PanelBody>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Metric label={t('willCreate')} value={plan.summary.willCreate} />
            <Metric label={t('selectedForCreation')} value={planSummary.selectedForCreation} />
            <Metric label={t('alreadyExists')} value={plan.summary.alreadyExists} />
            <Metric label={t('blocked')} value={plan.summary.blockedByErrors} />
            <Metric label={t('rateDiffers')} value={planSummary.rateDiffers} />
            <Metric label={t('unpriced')} value={planSummary.willBeUnpriced} />
          </dl>
          {planSummary.currencies.length === 0 ? null : (
            <ul className="space-y-2 border-t border-line pt-4 text-sm text-ink-2">
              {planSummary.currencies.map((figure) => (
                <li key={figure.currency}>{t('currencyFigure', {
                  currency: figure.currency,
                  workbook: moneyText(locale, figure.workbookMinorUnits, figure.currency),
                  card: moneyText(locale, figure.cardMinorUnits, figure.currency),
                })}</li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader><PanelTitle>{t('rows')}</PanelTitle></PanelHeader>
        <Table>
          <TableHead><TableRow>
            <TableHeaderCell>{t('excelRow')}</TableHeaderCell>
            <TableHeaderCell>{t('service')}</TableHeaderCell>
            <TableHeaderCell>{t('assignment')}</TableHeaderCell>
            <TableHeaderCell>{t('rateComparison')}</TableHeaderCell>
            <TableHeaderCell>{t('outcome')}</TableHeaderCell>
          </TableRow></TableHead>
          <TableBody>
            {view.items.map((item, index) => (
              <PreviewRow
                key={item.row.rowNumber}
                row={item.row}
                fieldLabels={fieldLabels}
                providerNames={providerNames}
                vehicleClassNames={vehicleClassNames}
                costCentreNames={costCentreNames}
                locationNames={locationNames}
                versionFields={versionFields}
                rateResult={item.rateResult}
                locale={locale}
                action={item.action}
                actionLocked={runState !== undefined}
                outcome={runState?.outcomes.find((outcome) => outcome.rowNumber === item.row.rowNumber)}
                current={running && runState?.outcomes.length === index}
                onAction={(action) => updateAction(item.row, action)}
              />
            ))}
          </TableBody>
        </Table>
      </Panel>

      {canConfirmImport(runState, selectionCounts) ? (
        <Panel emphasis="focal">
          <PanelHeader><div><PanelTitle>{t('confirmTitle')}</PanelTitle><PanelDescription>{t('confirmCounts', selectionCounts)}</PanelDescription></div></PanelHeader>
          <PanelBody><Button type="button" variant="primary" onClick={runImport}>{t('confirmImport')}</Button></PanelBody>
        </Panel>
      ) : null}

      {runState === undefined ? null : (
        <Panel emphasis="focal" aria-live="polite">
          <PanelHeader><div><PanelTitle>{running ? t('runningTitle') : t('reportTitle')}</PanelTitle><PanelDescription>{running ? t('progress', { processed: runState.outcomes.length, total: runState.totalRows }) : t(runState.stopped ? 'stoppedDescription' : 'reportDescription')}</PanelDescription></div></PanelHeader>
          <PanelBody>
            <progress className="h-2 w-full accent-accent" value={runState.outcomes.length} max={runState.totalRows} />
            {summary === undefined ? null : (
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                <Metric label={t('createdCount')} value={summary.created} />
                <Metric label={t('skippedCount')} value={summary.skipped} />
                <Metric label={t('failedCount')} value={summary.failedService} />
                <Metric label={t('halfImportedCount')} value={summary.halfImported} />
                <Metric label={t('untouchedCount')} value={summary.untouched} />
              </dl>
            )}
            {!running ? null : <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="danger" disabled={stopRequested} onClick={requestStop}>{t('stopAfterRow')}</Button>{stopRequested ? <p className="text-sm text-ink-3">{t('stopRequested')}</p> : null}</div>}
          </PanelBody>
          <Table>
            <TableHead><TableRow><TableHeaderCell>{t('excelRow')}</TableHeaderCell><TableHeaderCell>{t('service')}</TableHeaderCell><TableHeaderCell>{t('reportOutcome')}</TableHeaderCell><TableHeaderCell>{t('details')}</TableHeaderCell></TableRow></TableHead>
            <TableBody>{plan.rows.map((row, index) => {
              const outcome = runState.outcomes[index];
              return <ReportRow key={row.rowNumber} row={row} outcome={outcome} running={running && index === runState.outcomes.length} />;
            })}</TableBody>
          </Table>
        </Panel>
      )}

      <Panel>
        <PanelHeader><div><PanelTitle>{t('unresolvedReferences')}</PanelTitle><PanelDescription>{t(canConfigure ? 'referencesAdminRemedy' : 'referencesPlannerRemedy')}</PanelDescription></div></PanelHeader>
        <PanelBody>
          {plan.unresolvedReferences.length === 0 ? <p className="text-sm text-ink-3">{t('none')}</p> : (
            <ul className="space-y-2 text-sm text-ink-2">
              {plan.unresolvedReferences.map((reference) => (
                <li key={`${reference.kind}-${reference.name}`}><span className="font-medium text-ink">{reference.name}</span> · {targetLabel(reference.kind, t)} · {t('rowsList', { rows: reference.rows.join(', ') })}</li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader><div><PanelTitle>{t('unresolvedOptions')}</PanelTitle><PanelDescription>{t('optionsRemedy')}</PanelDescription></div></PanelHeader>
        <PanelBody>
          {plan.unresolvedOptions.length === 0 ? <p className="text-sm text-ink-3">{t('none')}</p> : (
            <ul className="space-y-2 text-sm text-ink-2">
              {plan.unresolvedOptions.map((option) => (
                <li key={`${option.fieldDefinitionId}-${option.label}`}><span className="font-medium text-ink">{option.label}</span> · {fieldLabels.get(option.fieldDefinitionId) ?? option.fieldDefinitionId} · {t('rowsList', { rows: option.rows.join(', ') })}</li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

function PreviewRow({
  row,
  fieldLabels,
  providerNames,
  vehicleClassNames,
  costCentreNames,
  locationNames,
  versionFields,
  rateResult,
  locale,
  action,
  actionLocked,
  outcome,
  current,
  onAction,
}: {
  row: PlannedRow;
  fieldLabels: ReadonlyMap<string, string>;
  providerNames: ReadonlyMap<string, string>;
  vehicleClassNames: ReadonlyMap<string, string>;
  costCentreNames: ReadonlyMap<string, string>;
  locationNames: ReadonlyMap<string, string>;
  versionFields: readonly VersionField[];
  rateResult: RateLookupResult | Error | undefined;
  locale: ReturnType<typeof useCanonicalLocale>;
  action: ImportRowAction;
  actionLocked: boolean;
  outcome: ImportRowOutcome | undefined;
  current: boolean;
  onAction: (action: ImportRowAction) => void;
}) {
  const t = useTranslations('workbookImport');
  const rootT = useTranslations();
  const lookupResult = rateResultForWrite(rateResult);
  const comparison = row.amountComparison;
  // The raw value, not the narrowed one: an errored lookup blocks the row, and
  // offering "create" for it contradicts `canSetImportRowAction`.
  const blocked = importRowIsBlocked(row, rateResult);
  return (
    <TableRow>
      <TableRowHeaderCell className="font-mono text-xs tabular-nums">{row.rowNumber}</TableRowHeaderCell>
      <TableCell>
        {row.service === undefined ? <span className="text-ink-3">{t('notAvailable')}</span> : (
          <div>
            <p className="font-medium text-ink">{row.service.name}</p>
            <p className="text-xs text-ink-3">{formatDateTime(locale, row.service.startsAt)}{row.service.endsAt === undefined ? '' : ` – ${formatDateTime(locale, row.service.endsAt)}`}</p>
            {row.service.values.length === 0 ? null : (
              <dl className="mt-2 space-y-1 text-xs">
                {row.service.values.map((item) => {
                  const field = versionFields.find((candidate) => candidate.fieldDefinitionId === item.fieldDefinitionId);
                  const locationName = item.value.kind === 'location' ? locationNames.get(item.value.locationId) : undefined;
                  return <div key={item.fieldDefinitionId}><dt className="inline text-ink-3">{fieldLabels.get(item.fieldDefinitionId) ?? item.fieldDefinitionId}: </dt><dd className="inline text-ink">{field === undefined ? t('notAvailable') : formatFieldValue(locale, field.config, item.value, t('notAvailable'), locationName)}</dd></div>;
                })}
              </dl>
            )}
          </div>
        )}
      </TableCell>
      <TableCell>
        {row.rateLookup === undefined ? <span className="text-ink-3">{t('notMapped')}</span> : (
          <div className="text-xs">
            <p>{providerNames.get(row.rateLookup.providerId) ?? t('notAvailable')}</p>
            <p>{vehicleClassNames.get(row.rateLookup.vehicleClassId) ?? t('notAvailable')} · {t(`modalities.${row.rateLookup.modality}`)} · {t('quantityValue', { quantity: row.rateLookup.quantity })}</p>
            {row.assignment?.create.costCentreId === undefined ? null : <p>{costCentreNames.get(row.assignment.create.costCentreId) ?? t('notAvailable')}</p>}
          </div>
        )}
      </TableCell>
      <TableCell>
        {comparison?.currency === undefined || comparison.cardUnitMinorUnits === undefined ? (
          <span className="text-ink-3">{rateOutcome(lookupResult, t)}</span>
        ) : (
          <div className="text-xs">
            <p>{t('workbookRate', { amount: moneyText(locale, comparison.workbookMinorUnits, comparison.currency) })}</p>
            {/* Both figures, labelled: a `Valor` column beside a `Cant` column may hold
                either, and the committed amount is always the line total. */}
            <p>{t('cardUnitRate', { amount: moneyText(locale, comparison.cardUnitMinorUnits, comparison.currency) })}</p>
            {comparison.cardLineMinorUnits === undefined ? null : (
              <p>{t('cardLineTotal', {
                amount: moneyText(locale, comparison.cardLineMinorUnits, comparison.currency),
                quantity: comparison.quantity ?? 1,
              })}</p>
            )}
            {comparison.differs
              ? <p className="mt-1 text-tone-hold">{t('rateWarning')}</p>
              : comparison.matches === undefined ? null
                : <p className="mt-1 text-ink-3">{t(comparison.matches === 'unit' ? 'rateMatchesUnit' : 'rateMatchesLine')}</p>}
          </div>
        )}
      </TableCell>
      <TableCell>
        <label className="flex flex-col gap-1 text-xs text-ink-3">
          <span>{t('rowAction')}</span>
          <select
            className="h-[30px] rounded-input border border-line bg-well px-2 text-sm text-ink disabled:opacity-60"
            value={action}
            disabled={actionLocked}
            onChange={(event) => onAction(event.target.value === 'create' ? 'create' : 'skip')}
          >
            <option value="create" disabled={blocked}>{t('createOutcome')}</option>
            <option value="skip">{t('skipOutcome')}</option>
          </select>
        </label>
        {current ? <p className="mt-1 text-xs text-tone-hold">{t('rowRunning')}</p> : null}
        {outcome === undefined ? null : <p className={`mt-1 text-xs ${outcomeTone(outcome)}`}>{outcomeLabel(outcome, t)}</p>}
        {outcome === undefined || !('errorKey' in outcome) ? null : <p className="mt-1 text-xs text-ink-2">{rootT(outcome.errorKey)}</p>}
        {row.existingServiceId === undefined ? null : <p className="text-xs text-ink-3">{t('duplicateExisting')}</p>}
        {lookupResult?.kind !== 'ambiguous' ? null : <p className="mt-1 text-xs text-tone-stop">{t('ambiguousBlocked')}</p>}
        {row.problems.length === 0 ? null : (
          <ul className="mt-1 space-y-1 text-xs text-tone-stop">
            {row.problems.map((problem, index) => <li key={`${problem.kind}-${index}`}>{rowProblemText(problem, t, fieldLabels)}</li>)}
          </ul>
        )}
      </TableCell>
    </TableRow>
  );
}

function outcomeTone(outcome: ImportRowOutcome): string {
  if (outcome.kind === 'created') return 'text-tone-go';
  if (outcome.kind === 'failedAssignment' || outcome.kind === 'failedRevision') return 'text-tone-hold';
  if (outcome.kind === 'failedService') return 'text-tone-stop';
  return 'text-ink-3';
}

function outcomeLabel(outcome: ImportRowOutcome, t: Translator): string {
  switch (outcome.kind) {
    case 'created':
      if (outcome.assignment === 'priced') return t('createdPriced');
      if (outcome.assignment === 'unpriced') return t('createdUnpriced');
      return t('createdServiceOnly');
    case 'skipped':
      if (outcome.reason === 'blocked') return t('skippedBlocked');
      if (outcome.reason === 'existingService') return t('skippedExisting');
      return t('skippedSelected');
    case 'failedService': return t('failedService');
    case 'failedAssignment': return t('failedAssignment');
    case 'failedRevision': return t(outcome.step === 'acceptance' ? 'failedAcceptance' : 'failedRevision');
  }
}

function ReportRow({ row, outcome, running }: {
  row: PlannedRow;
  outcome: ImportRowOutcome | undefined;
  running: boolean;
}) {
  const t = useTranslations('workbookImport');
  const rootT = useTranslations();
  const detail = outcome === undefined
    ? t(running ? 'rowRunning' : 'untouchedRow')
    : 'errorKey' in outcome
      ? rootT(outcome.errorKey)
      : outcome.kind === 'skipped'
        ? outcomeLabel(outcome, t)
        : outcome.kind === 'created'
          ? outcomeLabel(outcome, t)
          : '';
  return (
    <TableRow>
      <TableRowHeaderCell className="font-mono text-xs tabular-nums">{row.rowNumber}</TableRowHeaderCell>
      <TableCell>{row.service?.name ?? t('notAvailable')}</TableCell>
      <TableCell><span className={outcome === undefined ? running ? 'text-tone-hold' : 'text-ink-3' : outcomeTone(outcome)}>{outcome === undefined ? t(running ? 'rowRunning' : 'untouchedOutcome') : outcomeLabel(outcome, t)}</span></TableCell>
      <TableCell className={outcome !== undefined && 'errorKey' in outcome ? outcomeTone(outcome) : 'text-ink-2'}>{detail}</TableCell>
    </TableRow>
  );
}

function rateOutcome(result: RateLookupResult | undefined, t: Translator): string {
  if (result === undefined) return t('unpricedRate');
  if (result.kind === 'ambiguous') return t('ambiguousRate', { count: result.candidates.length });
  if (result.kind === 'unpriceable') return t(result.reason === 'noRateLine' ? 'noRateLine' : 'rateCardLimitExceeded');
  return t('rateResolved');
}

function rowProblemText(problem: RowProblem, t: Translator, labels: ReadonlyMap<string, string>): string {
  switch (problem.kind) {
    case 'mappingInvalid': return t('rowMappingInvalid');
    case 'missingServiceName': return t('rowMissingServiceName');
    case 'startsAt': return t('rowStartsAt', { problem: t(`cellProblems.${problem.problem}`) });
    case 'endsAt': return t('rowEndsAt', { problem: t(`cellProblems.${problem.problem}`) });
    case 'endsBeforeStart': return t('rowEndsBeforeStart');
    case 'field': return t('rowField', { field: labels.get(problem.fieldDefinitionId) ?? problem.fieldDefinitionId, problem: t(`cellProblems.${problem.problem}`) });
    case 'unknownField': return t('rowUnknownField', { field: problem.fieldDefinitionId });
    case 'assignment': return t('rowAssignment', { target: targetLabel(problem.target, t), problem: assignmentProblemText(problem.problem, t) });
    case 'workbookAmount': return t('rowWorkbookAmount', { problem: moneyProblemText(problem.problem, t) });
  }
}

function assignmentProblemText(problem: string, t: Translator): string {
  if (problem === 'unresolvedReference') return t('assignmentProblems.unresolvedReference');
  if (problem === 'unknownModality') return t('assignmentProblems.unknownModality');
  if (problem === 'notPositiveInteger') return t('assignmentProblems.notPositiveInteger');
  return problem;
}

function moneyProblemText(problem: string, t: Translator): string {
  if (problem === 'invalid') return t('moneyProblems.invalid');
  if (problem === 'negative') return t('moneyProblems.negative');
  if (problem === 'tooManyDecimalPlaces') return t('moneyProblems.tooManyDecimalPlaces');
  if (problem === 'outOfRange') return t('moneyProblems.outOfRange');
  return problem;
}

function moneyText(locale: ReturnType<typeof useCanonicalLocale>, minorUnits: number, currency: WorkbookPlan['summary']['currencies'][number]['currency']): string {
  const display = moneyDisplay(locale, minorUnits, currency);
  return display.kind === 'unset' ? '' : `${display.currency} ${display.amount}`;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><dt className="text-micro uppercase text-ink-3">{label}</dt><dd className="font-mono text-2xl text-ink">{value}</dd></div>;
}
