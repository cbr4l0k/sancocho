'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';

import { api } from '@priamo/convex/api';

import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusChip } from '@/components/ui/status-chip';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { formatMoneyParts, moneyInputText } from '@/lib/money';
import {
  assembleRateGrid,
  currencies,
  rateCellTransition,
  rateModalities,
  type Currency,
  type RateGridClass,
  type RateGridCell,
} from '@/lib/rate-grid';

type RateCardVersionId = FunctionArgs<typeof api.rateCards.queries.getRateCardVersion>['rateCardVersionId'];
type RateLine = FunctionReturnType<typeof api.rateCards.queries.getRateCardVersion>['rateLines'][number];
type VehicleClass = FunctionReturnType<typeof api.vehicles.queries.listVehicleClasses>['page'][number];
type ProviderStatus = FunctionReturnType<typeof api.providers.queries.getProvider>['status'];

export function RateGridEditor({ rateCardVersionId, providerStatus, onPublish }: {
  rateCardVersionId: RateCardVersionId;
  providerStatus: ProviderStatus | undefined;
  onPublish: () => Promise<void>;
}) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  const details = useQuery(api.rateCards.queries.getRateCardVersion, { rateCardVersionId });
  const classes = usePaginatedQuery(
    api.vehicles.queries.listVehicleClasses,
    details === undefined ? 'skip' : { organizationId: details.version.organizationId },
    { initialNumItems: 100 },
  );
  const updateVersion = useMutation(api.rateCards.mutations.updateRateCardVersion);
  const addLine = useMutation(api.rateCards.mutations.addRateLine);
  const updateLine = useMutation(api.rateCards.mutations.updateRateLine);
  const removeLine = useMutation(api.rateCards.mutations.removeRateLine);
  const [message, setMessage] = useState<string | null>(null);
  const { loadMore: loadMoreClasses, status: classesStatus } = classes;

  useEffect(() => {
    if (classesStatus === 'CanLoadMore') loadMoreClasses(100);
  }, [classesStatus, loadMoreClasses]);

  async function action(run: () => Promise<unknown>): Promise<void> {
    try {
      setMessage(null);
      await run();
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  // A partial row axis would make an unloaded Class indistinguishable from a
  // Class with no rates, so the grid is withheld until every Class page is in hand.
  if (details === undefined || classesStatus !== 'Exhausted') {
    return <div aria-busy="true"><Skeleton className="h-40 w-full" /></div>;
  }

  // This component is mounted only for a draft. Keep the invariant local too,
  // so a future caller cannot turn it into an editor for immutable history (I2).
  if (details.version.status !== 'draft') return null;
  const grid = assembleRateGrid(classes.results, rateModalities, details.rateLines);
  const rows = grid.ok ? grid.rows : recoverableRows(classes.results, details.rateLines);
  const archivedClassIds = new Set(
    classes.results.filter((vehicleClass) => vehicleClass.status === 'archived').map((vehicleClass) => vehicleClass._id),
  );
  const publishBlock = providerStatus === undefined
    ? 'providerLoading'
    : providerStatus === 'archived'
      ? 'providerArchived'
      : details.rateLines.length === 0
        ? 'empty'
        : details.rateLines.some((line) => archivedClassIds.has(line.vehicleClassId))
          ? 'archivedClass'
          : grid.ok
            ? null
            : 'invalidGrid';

  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div>
          <PanelTitle>{t('rateCards.gridTitle')}</PanelTitle>
          <p className="mt-1 text-xs text-ink-3">{t('rateCards.gridDescription')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <CurrencyEditor
            key={details.version.currency}
            currency={details.version.currency}
            rateCount={details.rateLines.length}
            onSave={(currency) => action(() => updateVersion({ rateCardVersionId, currency }))}
          />
          <Button type="button" variant="primary" disabled={publishBlock !== null} onClick={() => void onPublish()}>
            {t('rateCards.publishDraft', { version: details.version.versionNumber })}
          </Button>
        </div>
      </PanelHeader>
      <PanelBody>
        {message === null ? null : <p role="alert" className="text-sm text-tone-stop">{message}</p>}
        {publishBlock === null ? null : (
          <p className="text-sm text-ink-2">{t(`rateCards.publishBlocks.${publishBlock}`)}</p>
        )}
        {grid.ok ? null : (
          <p role="alert" className="text-sm text-tone-warn">{t(`rateCards.gridWarnings.${grid.reason}`)}</p>
        )}
        <div className="overflow-x-auto rounded-input border border-line">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-ground-3 text-micro uppercase text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left align-bottom">{t('rateCards.vehicleClass')}</th>
                {rateModalities.map((modality) => (
                  <th key={modality} className="min-w-48 px-3 py-2 text-left align-bottom">
                    {t(`common.modalities.${modality}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.vehicleClass._id} className="border-t border-line align-top">
                  <th scope="row" className="px-3 py-3 text-left font-semibold text-ink">
                    <span className="flex flex-wrap items-center gap-2">
                      {row.vehicleClass.name}
                      {row.vehicleClass.status === 'archived' ? (
                        <StatusChip kind="archival" status="archived" />
                      ) : null}
                    </span>
                    {row.vehicleClass.status === 'archived' ? (
                      <span className="mt-1 block text-xs font-normal text-ink-3">
                        {t('rateCards.archivedClassRatesOnlyClear')}
                      </span>
                    ) : null}
                  </th>
                  {row.cells.map((cell) => (
                    <td key={`${cell.vehicleClassId}:${cell.modality}`} className="px-3 py-3">
                      <RateCellEditor
                        key={`${cell.line?._id ?? 'empty'}:${cell.line?.unitAmount ?? 'empty'}`}
                        cell={cell}
                        vehicleClass={row.vehicleClass}
                        locale={locale}
                        onClear={() => {
                          const line = cell.line;
                          if (line !== undefined) void action(() => removeLine({ rateLineId: line._id }));
                        }}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const submitted = String(new FormData(event.currentTarget).get('amount') ?? '');
                          const line = cell.line;
                          const transition = rateCellTransition(line?.unitAmount, submitted);
                          if (transition.kind === 'invalid') {
                            setMessage(t(`rateCards.moneyProblems.${transition.problem}`));
                            return;
                          }
                          if (transition.kind === 'noop') return;
                          if (transition.kind === 'add') {
                            void action(() => addLine({
                              rateCardVersionId,
                              vehicleClassId: cell.vehicleClassId,
                              modality: cell.modality,
                              unitAmount: transition.unitAmount,
                            }));
                          } else if (transition.kind === 'update' && line !== undefined) {
                            // Grid coordinates are the cell identity. Sending Class or modality
                            // here could accidentally move a line onto a neighbouring cell.
                            void action(() => updateLine({ rateLineId: line._id, unitAmount: transition.unitAmount }));
                          } else if (transition.kind === 'remove' && line !== undefined) {
                            void action(() => removeLine({ rateLineId: line._id }));
                          }
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelBody>
    </Panel>
  );
}

function RateCellEditor({ cell, vehicleClass, locale, onClear, onSubmit }: {
  cell: RateGridCell<VehicleClass['_id'], RateLine['_id']>;
  vehicleClass: RateGridClass<VehicleClass['_id']>;
  locale: ReturnType<typeof useCanonicalLocale>;
  onClear: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const t = useTranslations();
  const [text, setText] = useState(cell.line === undefined ? '' : moneyInputText(cell.line.unitAmount));
  const displayed = cell.line === undefined ? null : formatMoneyParts(locale, cell.line.unitAmount).amount;
  if (vehicleClass.status === 'archived') {
    if (displayed === null) return null;
    return (
      <div className="flex min-w-44 flex-col gap-2">
        <span className="font-mono text-sm text-ink">{displayed}</span>
        <Button type="button" size="sm" variant="danger" onClick={onClear}>{t('rateCards.clearRate')}</Button>
      </div>
    );
  }
  return (
    <form className="flex min-w-44 flex-col gap-2" onSubmit={onSubmit}>
      <span className="text-xs text-ink-3">
        {displayed === null ? t('rateCards.emptyCell') : displayed}
      </span>
      <input
        aria-label={t('rateCards.cellAmount', { class: vehicleClass.name, modality: t(`common.modalities.${cell.modality}`) })}
        className="h-[38px] rounded-input border border-line bg-well px-3 font-mono text-sm text-ink"
        name="amount"
        inputMode="decimal"
        placeholder={t('rateCards.emptyCell')}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button type="submit" size="sm">{t('common.save')}</Button>
    </form>
  );
}

function CurrencyEditor({ currency, rateCount, onSave }: {
  currency: Currency;
  rateCount: number;
  onSave: (currency: Currency) => Promise<void>;
}) {
  const t = useTranslations();
  const [selected, setSelected] = useState(currency);
  const [confirming, setConfirming] = useState(false);
  return <div className="flex flex-col gap-2">
    <div className="flex items-end gap-2">
    <label className="flex flex-col gap-1 text-xs text-ink-2">
      {t('rateCards.currency')}
      <select
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm text-ink"
        value={selected}
        onChange={(event) => {
          const next = currencies.find((candidate) => candidate === event.target.value);
          if (next !== undefined) setSelected(next);
        }}
      >
        {currencies.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
    <Button type="button" size="sm" disabled={selected === currency} onClick={() => {
      if (rateCount === 0) void onSave(selected);
      else setConfirming(true);
    }}>
      {t('common.save')}
    </Button>
    </div>
    {confirming ? (
      <div className="max-w-md rounded-input border border-tone-warn/40 bg-ground-2 p-3">
        <p className="text-sm text-ink-2">
          {t('rateCards.currencyChangeWarning', { count: rateCount, from: currency, to: selected })}
        </p>
        <div className="mt-2 flex gap-2">
          <Button type="button" size="sm" variant="primary" onClick={() => {
            void onSave(selected).then(() => setConfirming(false));
          }}>{t('rateCards.confirmCurrencyChange')}</Button>
          <Button type="button" size="sm" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
        </div>
      </div>
    ) : null}
  </div>;
}

function recoverableRows(
  vehicleClasses: readonly VehicleClass[],
  rateLines: readonly RateLine[],
): readonly import('@/lib/rate-grid').RateGridRow<VehicleClass['_id'], RateLine['_id']>[] {
  const classIds = new Set(vehicleClasses.map((vehicleClass) => vehicleClass._id));
  const seen = new Set<string>();
  const recoverable = rateLines.filter((line) => {
    const key = `${line.vehicleClassId}\u0000${line.modality}`;
    if (!classIds.has(line.vehicleClassId) || !rateModalities.includes(line.modality) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const recovered = assembleRateGrid(vehicleClasses, rateModalities, recoverable);
  if (recovered.ok) return recovered.rows;
  return vehicleClasses.map((vehicleClass) => ({
    vehicleClass,
    cells: rateModalities.map((modality) => ({ vehicleClassId: vehicleClass._id, modality, line: undefined })),
  }));
}
