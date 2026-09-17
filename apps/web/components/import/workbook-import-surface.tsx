'use client';

import { usePaginatedQuery, useQueries, useQuery, type RequestForQueries } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

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
import { moneyDisplay } from '@/lib/money';
import {
  distinctRateLookupRequests,
  isRateLookupResult,
  rateLookupKey,
  rateLookupResultsToRates,
  type RateLookupResult,
} from '@/lib/rate-lookup-result';
import { roleAtLeast } from '@/lib/roles';
import { readWorkbook, type WorkbookSheet } from '@/lib/workbook-file';
import { mappingProblems, type ColumnTarget, type MappingProblem, type VersionField, type WorkbookMapping } from '@/lib/workbook-mapping';
import {
  buildWorkbookPlan,
  type PlannedRow,
  type RowProblem,
  type WorkbookCatalogues,
  type WorkbookPlan,
  type WorkbookRow,
} from '@/lib/workbook-plan';

type EventId = FunctionArgs<typeof api.events.queries.getEventDetail>['eventId'];

const pageSize = 200;
const previewCellCount = 3;
function cellText(cell: WorkbookRow['cells'][number] | undefined): string {
  if (cell === undefined || cell === null) return '';
  return String(cell);
}

function targetValue(target: ColumnTarget): string {
  return target.kind === 'field' ? `field:${target.fieldDefinitionId}` : target.kind;
}

function targetFromValue(value: string, fieldDefinitionIds: readonly string[]): ColumnTarget {
  const fieldDefinitionId = fieldDefinitionIds.find((id) => value === `field:${id}`);
  if (fieldDefinitionId !== undefined) return { kind: 'field', fieldDefinitionId };
  const fixed = [
    'ignored', 'serviceName', 'startsAtDate', 'startsAtTime', 'endsAtDate', 'endsAtTime',
    'provider', 'vehicleClass', 'modality', 'quantity', 'costCentre', 'workbookAmount',
  ] as const;
  const kind = fixed.find((candidate) => candidate === value);
  return kind === undefined ? { kind: 'ignored' } : { kind };
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
  const priceQueries = (() => {
    const requests: RequestForQueries = {};
    if (!previewRequested || !canPreview) return requests;
    for (const request of rateRequests) {
      const provider = providers.results.find((item) => item._id === request.providerId);
      const vehicleClass = vehicleClasses.results.find((item) => item._id === request.vehicleClassId);
      if (provider === undefined || vehicleClass === undefined) continue;
      requests[request.key] = {
        query: api.assignments.queries.resolveProspectiveRate,
        args: { eventId, providerId: provider._id, vehicleClassId: vehicleClass._id, modality: request.modality },
      };
    }
    return requests;
  })();
  const rawRateResults: Readonly<Record<string, unknown>> = useQueries(priceQueries);
  const pricingComplete = rateRequests.every((request) => rawRateResults[request.key] !== undefined);
  const rates = rateLookupResultsToRates(rateRequests, rawRateResults);
  const plan = buildWorkbookPlan({ rows: dataRows, mapping, versionFields, catalogues: { ...catalogues, rates } });

  if (currentOrganization === null || organizationId === undefined || detail === undefined) return null;

  async function chooseFile(file: File | undefined): Promise<void> {
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
              render={<input type="file" />}
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
              render={<select />}
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
          <Button type="button" variant="primary" onClick={() => setSheetConfirmed(true)}>
            {t('confirmSheet')}
          </Button>
        </StepPanel>
      )}

      {!sheetConfirmed ? null : (
        <StepPanel title={t('serviceKind')} description={t('serviceKindDescription')}>
          <Field>
            <FieldLabel required>{t('serviceKind')}</FieldLabel>
            <FieldControl
              render={<select />}
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
            <Button type="button" size="sm" onClick={() => serviceKinds.loadMore(pageSize)}>{rootT('table.loadMore')}</Button>
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
                      render={<select />}
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
                  <Button type="button" size="sm" onClick={loadMoreCatalogues}>{t('loadMoreCatalogues')}</Button>
                ) : null}
              </div>
            ) : null}
            <Button
              type="button"
              variant="primary"
              disabled={!mappingReady || !cataloguesComplete || !canPreview || dataRows.length === 0}
              onClick={() => setPreviewRequested(true)}
            >
              {t('preview')}
            </Button>
          </StepPanel>
        </>
      )}

      {!previewRequested ? null : !pricingComplete ? (
        <Panel><PanelBody><p className="text-sm text-ink-3">{t('pricing')}</p></PanelBody></Panel>
      ) : (
        <Preview
          plan={plan}
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
  plan,
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
  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader><PanelTitle>{t('summary')}</PanelTitle></PanelHeader>
        <PanelBody>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Metric label={t('willCreate')} value={plan.summary.willCreate} />
            <Metric label={t('alreadyExists')} value={plan.summary.alreadyExists} />
            <Metric label={t('blocked')} value={plan.summary.blockedByErrors} />
            <Metric label={t('rateDiffers')} value={plan.summary.rateDiffers} />
            <Metric label={t('unpriced')} value={plan.summary.willBeUnpriced} />
          </dl>
          {plan.summary.currencies.length === 0 ? null : (
            <ul className="space-y-2 border-t border-line pt-4 text-sm text-ink-2">
              {plan.summary.currencies.map((figure) => (
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
            {plan.rows.map((row) => (
              <PreviewRow
                key={row.rowNumber}
                row={row}
                fieldLabels={fieldLabels}
                providerNames={providerNames}
                vehicleClassNames={vehicleClassNames}
                costCentreNames={costCentreNames}
                locationNames={locationNames}
                versionFields={versionFields}
                rateResult={row.rateLookup === undefined ? undefined : rateResults[rateLookupKey(row.rateLookup)]}
                locale={locale}
              />
            ))}
          </TableBody>
        </Table>
      </Panel>

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

function PreviewRow({ row, fieldLabels, providerNames, vehicleClassNames, costCentreNames, locationNames, versionFields, rateResult, locale }: {
  row: PlannedRow;
  fieldLabels: ReadonlyMap<string, string>;
  providerNames: ReadonlyMap<string, string>;
  vehicleClassNames: ReadonlyMap<string, string>;
  costCentreNames: ReadonlyMap<string, string>;
  locationNames: ReadonlyMap<string, string>;
  versionFields: readonly VersionField[];
  rateResult: unknown;
  locale: ReturnType<typeof useCanonicalLocale>;
}) {
  const t = useTranslations('workbookImport');
  const lookupResult = isRateLookupResult(rateResult) ? rateResult : undefined;
  const comparison = row.amountComparison;
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
        {comparison?.currency === undefined || comparison.cardMinorUnits === undefined ? (
          <span className="text-ink-3">{rateOutcome(lookupResult, t)}</span>
        ) : (
          <div className="text-xs">
            <p>{t('workbookRate', { amount: moneyText(locale, comparison.workbookMinorUnits, comparison.currency) })}</p>
            <p>{t('cardRate', { amount: moneyText(locale, comparison.cardMinorUnits, comparison.currency) })}</p>
            {comparison.differs ? <p className="mt-1 text-tone-hold">{t('rateWarning')}</p> : null}
          </div>
        )}
      </TableCell>
      <TableCell>
        <p className={row.defaultAction === 'create' ? 'text-tone-go' : 'text-ink-3'}>{t(row.defaultAction === 'create' ? 'createOutcome' : 'skipOutcome')}</p>
        {row.existingServiceId === undefined ? null : <p className="text-xs text-ink-3">{t('duplicateExisting')}</p>}
        {row.problems.length === 0 ? null : (
          <ul className="mt-1 space-y-1 text-xs text-tone-stop">
            {row.problems.map((problem, index) => <li key={`${problem.kind}-${index}`}>{rowProblemText(problem, t, fieldLabels)}</li>)}
          </ul>
        )}
      </TableCell>
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
