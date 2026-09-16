'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { api } from '@priamo/convex/api';
import { executionStatusTransitions } from '@priamo/convex/assignments/execution';

import { VehicleClassPicker } from '@/components/fleet/vehicle-class-picker';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ProviderPicker } from '@/components/providers/provider-picker';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Panel, PanelActions, PanelBody, PanelDescription, PanelHeader, PanelTitle,
} from '@/components/ui/panel';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { StatusChip } from '@/components/ui/status-chip';
import {
  Table, TableBody, TableCell, TableHead, TableHeaderCell, TableLoadMore, TableRow, TableRowHeaderCell,
} from '@/components/ui/table';
import { formatDateTime, formatNumber } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { assignmentActions } from '@/lib/assignment-actions';
import { executionSubmitProblem } from '@/lib/assignment-execution';
import {
  assignmentRateState,
  nextAssignmentPosition,
  parseQuantity,
  readExecutionStatus,
  readModality,
  repriceAssignment,
} from '@/lib/assignment-flow';
import {
  assignmentSummary, serviceTotals, type AssignmentPanelRow, type RateModality,
} from '@/lib/assignment-summary';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { formatMoneyParts } from '@/lib/money';
import { rateModalities } from '@/lib/rate-grid';

type ServiceId = FunctionArgs<typeof api.assignments.queries.listServiceAssignmentRows>['serviceId'];
type ProviderId = FunctionArgs<typeof api.assignments.queries.resolveAssignmentRate>['providerId'];
type VehicleClassId = FunctionArgs<typeof api.assignments.queries.resolveAssignmentRate>['vehicleClassId'];
type Revision = FunctionReturnType<typeof api.assignments.queries.listAssignmentRevisions>['page'][number];

export function AssignmentsPanel({ serviceId, serviceWritable }: { serviceId: ServiceId; serviceWritable: boolean }) {
  const t = useTranslations('assignments');
  const rootT = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const rows = useQuery(api.assignments.queries.listServiceAssignmentRows, { serviceId });
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (rows === undefined || currentOrganization === null) {
    return <Panel emphasis="focal" aria-busy="true"><PanelHeader><Skeleton className="h-7 w-64" /></PanelHeader><PanelBody><SkeletonText /></PanelBody></Panel>;
  }
  const actor = { kind: 'member', role: currentOrganization.role } as const;
  const mayAdd = assignmentActions(actor, {
    serviceWritable,
    hasRevisionHistory: false,
    revision: null,
    executionStatus: 'completed',
  }).has('addAssignment');
  const totals = serviceTotals(rows);

  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <div><PanelTitle>{t('title')}</PanelTitle><PanelDescription>{t('description')}</PanelDescription></div>
        {mayAdd && !adding && rows.length > 0 ? <PanelActions><Button onClick={() => setAdding(true)}>{t('add')}</Button></PanelActions> : null}
      </PanelHeader>
      {message === null ? null : <div role="alert" className="mx-5 mt-4 rounded-input border border-tone-stop/40 bg-ground-2 px-4 py-3 text-sm text-tone-stop sm:mx-6">{message}</div>}
      {adding ? (
        <PanelBody><AssignmentTermsForm serviceId={serviceId} rows={rows} onCancel={() => setAdding(false)} onMessage={setMessage} /></PanelBody>
      ) : rows.length === 0 ? (
        <PanelBody><EmptyState tone="empty" title={t('emptyTitle')} description={t('emptyBody')} action={mayAdd ? <Button onClick={() => setAdding(true)}>{t('add')}</Button> : undefined} /></PanelBody>
      ) : (
        <>
          <div className="overflow-x-auto pt-5">
            <Table>
              <TableHead><TableRow>
                <TableHeaderCell align="end">{t('position')}</TableHeaderCell><TableHeaderCell>{t('provider')}</TableHeaderCell>
                <TableHeaderCell>{t('vehicleClass')}</TableHeaderCell><TableHeaderCell>{t('modality')}</TableHeaderCell>
                <TableHeaderCell align="end">{t('quantity')}</TableHeaderCell><TableHeaderCell align="end">{t('unitAmount')}</TableHeaderCell>
                <TableHeaderCell align="end">{t('lineTotal')}</TableHeaderCell><TableHeaderCell>{t('costCentre')}</TableHeaderCell>
                <TableHeaderCell>{t('execution')}</TableHeaderCell><TableHeaderCell>{t('terms')}</TableHeaderCell>
              </TableRow></TableHead>
              <TableBody>{rows.map((row) => <AssignmentRow key={row.assignment._id} row={row} serviceId={serviceId} serviceWritable={serviceWritable} onMessage={setMessage} />)}</TableBody>
            </Table>
          </div>
          <PanelBody className="border-t border-line">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{t('totals')}</p>
                {totals.length === 0 ? <p className="mt-1 text-sm text-ink-2">{t('unpriced')}</p> : totals.map((total) => <p key={total.currency} className="mt-1 font-mono text-sm text-ink">{t('totalLine', { currency: total.currency, ...formatMoneyParts(locale, total.minorUnits) })}</p>)}
              </div>
              <p className="text-xs text-ink-3">{rootT('table.loaded', { count: rows.length })}</p>
            </div>
          </PanelBody>
        </>
      )}
    </Panel>
  );
}

function AssignmentRow({ row, serviceId, serviceWritable, onMessage }: {
  row: AssignmentPanelRow; serviceId: ServiceId; serviceWritable: boolean; onMessage: (message: string | null) => void;
}) {
  const t = useTranslations('assignments');
  const rootT = useTranslations();
  const locale = useCanonicalLocale();
  const { currentOrganization } = useCurrentOrganization();
  const [expanded, setExpanded] = useState(false);
  const [repricing, setRepricing] = useState(false);
  const summary = assignmentSummary(row);
  const terms = summary.kind === 'unpriced' ? null : summary.terms;
  if (currentOrganization === null) return null;
  const actions = assignmentActions({ kind: 'member', role: currentOrganization.role }, {
    serviceWritable,
    hasRevisionHistory: row.latestRevision !== null,
    revision: row.latestRevision,
    executionStatus: row.assignment.executionStatus,
  });
  return (
    <>
      <TableRow>
        <TableCell align="end" mono>{row.assignment.position + 1}</TableCell>
        <TableRowHeaderCell>{row.provider?.name ?? t('notSet')}</TableRowHeaderCell>
        <TableCell>{terms?.vehicleClassName ?? t('notSet')}</TableCell>
        <TableCell>{terms === null ? t('notSet') : rootT(`common.modalities.${terms.modality}`)}</TableCell>
        <TableCell align="end" mono>{terms === null ? t('notSet') : formatNumber(locale, terms.quantity)}</TableCell>
        <TableCell align="end" mono>{terms === null ? t('notSet') : money(locale, terms.unitAmount, terms.currency)}</TableCell>
        <TableCell align="end" mono>{terms === null ? t('notSet') : money(locale, terms.lineTotal, terms.currency)}</TableCell>
        <TableCell>{row.costCentre === null ? t('notSet') : `${row.costCentre.key} · ${row.costCentre.name}`}</TableCell>
        <TableCell><StatusChip kind="execution" status={row.assignment.executionStatus} /></TableCell>
        <TableCell><div className="flex flex-col items-start gap-2">
          {summary.kind === 'agreed' && row.currentRevision !== null ? <StatusChip kind="assignmentRevision" status={row.currentRevision.status} /> : summary.kind === 'proposed' ? <StatusChip kind="assignmentRevision" status={summary.status} /> : <span className="text-xs text-ink-3">{t('unpriced')}</span>}
          <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>{expanded ? t('hideHistory') : t('history')}</Button>
        </div></TableCell>
      </TableRow>
      {expanded ? <TableRow><TableCell colSpan={10}><div className="grid gap-4 py-2 lg:grid-cols-2">
        <div className="rounded-input border border-line bg-ground-2 p-4"><p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{t('commercialActions')}</p>
          <CommercialActions row={row} actions={actions} onReprice={() => setRepricing(true)} onMessage={onMessage} />
          {repricing ? <div className="mt-4"><AssignmentTermsForm serviceId={serviceId} rows={[row]} assignment={row} onCancel={() => setRepricing(false)} onMessage={onMessage} /></div> : null}
        </div>
        <div className="rounded-input border border-line bg-ground-2 p-4"><p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">{t('executionActions')}</p>
          <ExecutionActions row={row} enabled={actions.has('transitionExecution')} onMessage={onMessage} />
        </div>
      </div><RevisionHistory row={row} serviceWritable={serviceWritable} onMessage={onMessage} /></TableCell></TableRow> : null}
    </>
  );
}

function CommercialActions({ row, actions, onReprice, onMessage }: {
  row: AssignmentPanelRow; actions: ReadonlySet<import('@/lib/assignment-actions').AssignmentAction>;
  onReprice: () => void; onMessage: (message: string | null) => void;
}) {
  const t = useTranslations('assignments');
  const rootT = useTranslations();
  const accept = useMutation(api.assignments.mutations.acceptAssignmentRevision);
  const decline = useMutation(api.assignments.mutations.declineAssignmentRevision);
  const remove = useMutation(api.assignments.mutations.removeAssignment);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [removing, setRemoving] = useState(false);
  const revisionId = row.latestRevision?._id;
  async function run(work: () => Promise<unknown>): Promise<void> {
    try { await work(); onMessage(null); setDeclining(false); setRemoving(false); }
    catch (error) { onMessage(rootT(errorMessageKey(presentConvexError(error)))); }
  }
  return <div className="mt-3 flex flex-col gap-3">
    <div className="flex flex-wrap gap-2">
      {actions.has('acceptTerms') && revisionId !== undefined ? <Button size="sm" onClick={() => run(() => accept({ revisionId }))}>{t('accept')}</Button> : null}
      {actions.has('declineTerms') ? <Button size="sm" variant="secondary" onClick={() => setDeclining(true)}>{t('decline')}</Button> : null}
      {actions.has('reprice') ? <Button size="sm" variant="secondary" onClick={onReprice}>{t('reprice')}</Button> : null}
      {actions.has('removeAssignment') ? <Button size="sm" variant="danger" onClick={() => setRemoving(true)}>{t('remove')}</Button> : null}
    </div>
    {declining && revisionId !== undefined ? <div className="flex flex-col gap-2"><label className="text-xs font-medium text-ink">{t('declineReasonLabel')}</label><textarea className="min-h-20 rounded-input border border-line bg-well px-3 py-2 text-sm" value={reason} onChange={(event) => setReason(event.target.value)} /><div className="flex gap-2"><Button size="sm" variant="danger" disabled={reason.trim() === ''} onClick={() => run(() => decline({ revisionId, reason: reason.trim() }))}>{t('decline')}</Button><Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>{rootT('common.cancel')}</Button></div>{reason.trim() === '' ? <p className="text-xs text-tone-stop">{t('declineReasonRequired')}</p> : null}</div> : null}
    {removing ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="danger" onClick={() => run(() => remove({ assignmentId: row.assignment._id }))}>{t('confirmRemove')}</Button><Button size="sm" onClick={() => setRemoving(false)}>{t('cancelRemove')}</Button></div> : null}
    {[...actions].some((action) => action !== 'transitionExecution') ? null : <p className="text-xs text-ink-3">{t('actionsUnavailable')}</p>}
  </div>;
}

function AssignmentTermsForm({ serviceId, rows, assignment, onCancel, onMessage }: {
  serviceId: ServiceId; rows: readonly AssignmentPanelRow[]; assignment?: AssignmentPanelRow | undefined;
  onCancel: () => void; onMessage: (message: string | null) => void;
}) {
  const t = useTranslations('assignments');
  const rootT = useTranslations();
  const locale = useCanonicalLocale();
  const [providerId, setProviderId] = useState<ProviderId | undefined>(assignment?.assignment.providerId);
  const [vehicleClassId, setVehicleClassId] = useState<VehicleClassId | undefined>(assignment?.latestRevision?.vehicleClassId);
  const [modality, setModality] = useState<RateModality | undefined>(assignment?.latestRevision?.modality);
  const [quantityText, setQuantityText] = useState(assignment?.latestRevision === null || assignment?.latestRevision === undefined ? '1' : String(assignment.latestRevision.quantity));
  const [submitting, setSubmitting] = useState(false);
  const createAssignment = useMutation(api.assignments.mutations.createAssignment);
  const createRevision = useMutation(api.assignments.mutations.createAssignmentRevision);
  const acceptRevision = useMutation(api.assignments.mutations.acceptAssignmentRevision);
  const quantity = parseQuantity(quantityText);
  const resolution = useQuery(api.assignments.queries.resolveAssignmentRate,
    providerId === undefined || vehicleClassId === undefined || modality === undefined || quantity === undefined
      ? 'skip' : { serviceId, providerId, vehicleClassId, modality });
  const state = assignmentRateState(resolution, quantity);
  async function submit(): Promise<void> {
    if (providerId === undefined || vehicleClassId === undefined || modality === undefined || quantity === undefined || state.kind !== 'resolved') return;
    setSubmitting(true); onMessage(null);
    try {
      if (assignment === undefined) {
        const position = nextAssignmentPosition(rows);
        // Deliberately sequential and non-atomic. On failure we stop without
        // retry or rollback; the live panel then shows the honest partial state.
        const assignmentId = await createAssignment({ serviceId, providerId, position });
        const revisionId = await createRevision({ assignmentId, vehicleClassId, modality, quantity, rateCardVersionId: state.rate.rateCardVersionId, rateLineId: state.rate.rateLineId });
        await acceptRevision({ revisionId });
      } else {
        await repriceAssignment({ assignmentId: assignment.assignment._id, vehicleClassId, modality, quantity, rate: state.rate, createRevision });
      }
      onCancel();
    } catch (error) { onMessage(rootT(errorMessageKey(presentConvexError(error)))); }
    finally { setSubmitting(false); }
  }
  return <div className="flex flex-col gap-4">
    <div><h3 className="text-lg font-bold text-ink">{assignment === undefined ? t('addTitle') : t('repriceTitle')}</h3><p className="text-sm text-ink-2">{assignment === undefined ? t('addDescription') : t('repriceDescription')}</p></div>
    {assignment === undefined ? <div><label className="mb-2 block text-xs font-medium">{t('chooseProvider')}</label><ProviderPicker value={providerId} onChange={setProviderId} disabled={submitting} /></div> : null}
    <div><label className="mb-2 block text-xs font-medium">{t('chooseVehicleClass')}</label><VehicleClassPicker value={vehicleClassId} onChange={setVehicleClassId} disabled={submitting} /></div>
    <label className="flex flex-col gap-2 text-xs font-medium">{t('chooseModality')}<select className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" value={modality ?? ''} disabled={submitting} onChange={(event) => setModality(readModality(event.target.value))}><option value="">{t('notSet')}</option>{rateModalities.map((item) => <option key={item} value={item}>{rootT(`common.modalities.${item}`)}</option>)}</select></label>
    <label className="flex flex-col gap-2 text-xs font-medium">{t('quantity')}<input inputMode="numeric" className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" value={quantityText} disabled={submitting} onChange={(event) => setQuantityText(event.target.value)} /></label>
    {quantity === undefined && quantityText !== '' ? <p className="text-xs text-tone-stop">{t('quantityInvalid')}</p> : null}
    <RateResolution state={state} />
    <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={submitting || state.kind !== 'resolved'} onClick={submit}>{assignment === undefined ? t('save') : t('confirmReprice')}</Button><Button variant="ghost" disabled={submitting} onClick={onCancel}>{rootT('common.cancel')}</Button></div>
  </div>;
}

function RateResolution({ state }: { state: ReturnType<typeof assignmentRateState> }) {
  const t = useTranslations('assignments'); const locale = useCanonicalLocale();
  if (state.kind === 'waiting') return <p className="rounded-input border border-line bg-ground-2 p-3 text-sm text-ink-2">{t('rateWaiting')}</p>;
  if (state.kind === 'configurationGap') return <div className="rounded-input border border-line bg-ground-2 p-3 text-sm text-ink-2"><p>{t(state.reason)}</p><p className="mt-1 text-xs text-ink-3">{t('submitBlocked')}</p></div>;
  if (state.kind === 'ambiguous') return <div className="rounded-input border border-line bg-ground-2 p-3 text-sm text-ink-2"><p>{t('ambiguousRate')}</p><ul className="mt-2 list-disc pl-5">{state.candidates.map((candidate) => <li key={candidate.rateCardVersionId}>{candidate.rateCardName} · {money(locale, candidate.unitAmount, candidate.currency)}</li>)}</ul><p className="mt-2">{t('ambiguousInstruction')}</p></div>;
  return <div className="rounded-input border border-line bg-ground-2 p-3"><p className="text-xs text-ink-3">{t('rateResolved')}</p><p className="mt-1 font-mono text-sm text-ink">{t('unitAmount')}: {money(locale, state.rate.unitAmount, state.rate.currency)} · {t('lineTotal')}: {money(locale, state.lineTotal, state.rate.currency)}</p></div>;
}

function RevisionHistory({ row, serviceWritable, onMessage }: {
  row: AssignmentPanelRow;
  serviceWritable: boolean;
  onMessage: (message: string | null) => void;
}) {
  const t = useTranslations('assignments'); const rootT = useTranslations(); const locale = useCanonicalLocale();
  const revisions = usePaginatedQuery(
    api.assignments.queries.listAssignmentRevisions,
    { assignmentId: row.assignment._id },
    { initialNumItems: 10 },
  );
  return <div className="mt-4 border-t border-line pt-4"><h3 className="text-sm font-semibold text-ink">{t('historyTitle')}</h3>
    {revisions.status === 'LoadingFirstPage' ? <SkeletonText className="mt-3" /> : revisions.results.length === 0 ? <p className="mt-2 text-sm text-ink-3">{t('historyEmpty')}</p> : <div className="mt-3 overflow-x-auto"><Table><TableHead><TableRow><TableHeaderCell>{t('revision', { number: '' })}</TableHeaderCell><TableHeaderCell>{t('terms')}</TableHeaderCell><TableHeaderCell align="end">{t('quantity')}</TableHeaderCell><TableHeaderCell align="end">{t('unitAmount')}</TableHeaderCell><TableHeaderCell align="end">{t('lineTotal')}</TableHeaderCell><TableHeaderCell>{t('proposer')}</TableHeaderCell><TableHeaderCell>{t('recordedAt')}</TableHeaderCell><TableHeaderCell>{t('revisionDetail')}</TableHeaderCell></TableRow></TableHead><TableBody>{revisions.results.map((revision) => <RevisionHistoryRow key={revision._id} revision={revision} row={row} serviceWritable={serviceWritable} onMessage={onMessage} />)}</TableBody></Table></div>}
    <TableLoadMore loadedCount={revisions.results.length} status={revisions.status} onLoadMore={revisions.loadMore} />
    <span className="sr-only">{rootT('common.notAvailable')} {formatNumber(locale, revisions.results.length)}</span>
  </div>;
}

function RevisionHistoryRow({ revision, row, serviceWritable, onMessage }: {
  revision: Revision;
  row: AssignmentPanelRow;
  serviceWritable: boolean;
  onMessage: (message: string | null) => void;
}) {
  const t = useTranslations('assignments'); const locale = useCanonicalLocale();
  const wasAccepted = revision.acceptedAt !== undefined || ('acceptedByUserId' in revision && revision.acceptedByUserId !== undefined);
  return <TableRow><TableRowHeaderCell>{t('revision', { number: revision.revisionNumber })}</TableRowHeaderCell><TableCell><StatusChip kind="assignmentRevision" status={revision.status} /></TableCell><TableCell align="end" mono>{formatNumber(locale, revision.quantity)}</TableCell><TableCell align="end" mono>{money(locale, revision.unitAmount, revision.currency)}</TableCell><TableCell align="end" mono>{money(locale, revision.lineTotal, revision.currency)}</TableCell><TableCell>{revision.proposedOnBehalfOfProviderId === undefined ? t('coordinator') : t('providerActor')}</TableCell><TableCell mono><div>{formatDateTime(locale, revision._creationTime)}</div>{revision.acceptedAt === undefined ? null : <div className="mt-1 text-xs text-ink-3">{t('acceptedAt', { value: formatDateTime(locale, revision.acceptedAt) })}</div>}</TableCell><TableCell><div>{revision.declinedReason ?? (wasAccepted ? t('acceptedBy') : t('notSet'))}</div><MemberRevisionActions revision={revision} row={row} serviceWritable={serviceWritable} onMessage={onMessage} /></TableCell></TableRow>;
}

function MemberRevisionActions({ revision, row, serviceWritable, onMessage }: {
  revision: Revision;
  row: AssignmentPanelRow;
  serviceWritable: boolean;
  onMessage: (message: string | null) => void;
}) {
  const t = useTranslations('assignments');
  const rootT = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const accept = useMutation(api.assignments.mutations.acceptAssignmentRevision);
  const decline = useMutation(api.assignments.mutations.declineAssignmentRevision);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  if (currentOrganization === null) return null;
  const actions = assignmentActions({ kind: 'member', role: currentOrganization.role }, {
    serviceWritable,
    hasRevisionHistory: true,
    revision,
    executionStatus: row.assignment.executionStatus,
  });
  if (!actions.has('acceptTerms') && !actions.has('declineTerms')) return null;
  async function run(work: () => Promise<unknown>): Promise<void> {
    try { await work(); onMessage(null); setDeclining(false); }
    catch (error) { onMessage(rootT(errorMessageKey(presentConvexError(error)))); }
  }
  return <div className="mt-2 flex min-w-48 flex-col gap-2"><div className="flex flex-wrap gap-2">{actions.has('acceptTerms') ? <Button size="sm" onClick={() => run(() => accept({ revisionId: revision._id }))}>{t('accept')}</Button> : null}{actions.has('declineTerms') ? <Button size="sm" variant="danger" onClick={() => setDeclining(true)}>{t('decline')}</Button> : null}</div>{declining ? <div className="flex flex-col gap-2"><textarea aria-label={t('declineReasonLabel')} className="min-h-20 rounded-input border border-line bg-well px-3 py-2 text-sm" value={reason} onChange={(event) => setReason(event.target.value)} /><Button size="sm" variant="danger" disabled={reason.trim() === ''} onClick={() => run(() => decline({ revisionId: revision._id, reason: reason.trim() }))}>{t('decline')}</Button>{reason.trim() === '' ? <p className="text-xs text-tone-stop">{t('declineReasonRequired')}</p> : null}</div> : null}</div>;
}

function ExecutionActions({ row, enabled, onMessage }: { row: AssignmentPanelRow; enabled: boolean; onMessage: (message: string | null) => void }) {
  const t = useTranslations('assignments'); const rootT = useTranslations();
  const transition = useMutation(api.assignments.mutations.transitionAssignmentExecution);
  const next = executionStatusTransitions[row.assignment.executionStatus];
  const [status, setStatus] = useState<(typeof next)[number] | undefined>(next[0]);
  const [plate, setPlate] = useState(row.assignment.vehiclePlateOverride ?? '');
  const [driverName, setDriverName] = useState(row.assignment.driverName ?? '');
  const [driverPhone, setDriverPhone] = useState(row.assignment.driverPhone ?? '');
  const [reason, setReason] = useState('');
  if (!enabled || status === undefined) return <p className="mt-3 text-xs text-ink-3">{t('actionsUnavailable')}</p>;
  const selectedStatus = status;
  const submitProblem = executionSubmitProblem({ status: selectedStatus, fleetVehicleId: row.assignment.fleetVehicleId, vehiclePlateOverride: plate, driverName, notExecutedReason: reason });
  async function submit(): Promise<void> { try { await transition({ assignmentId: row.assignment._id, status: selectedStatus, ...(row.assignment.fleetVehicleId === undefined && plate.trim() !== '' ? { vehiclePlateOverride: plate.trim() } : {}), ...(driverName.trim() === '' ? {} : { driverName: driverName.trim() }), ...(driverPhone.trim() === '' ? {} : { driverPhone: driverPhone.trim() }), ...(selectedStatus === 'notExecuted' ? { notExecutedReason: reason.trim() } : {}) }); onMessage(null); } catch (error) { onMessage(rootT(errorMessageKey(presentConvexError(error)))); } }
  return <div className="mt-3 flex flex-col gap-2"><p className="text-xs text-ink-3">{t('executionFieldsHelp')}</p><select className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" value={status} onChange={(event) => setStatus(readExecutionStatus(next, event.target.value))}>{next.map((item) => <option key={item} value={item}>{rootT(`vocab.executionStatuses.${item}`)}</option>)}</select>{(status === 'assigned' || status === 'confirmed' || status === 'dispatched' || status === 'completed') && row.assignment.fleetVehicleId === undefined ? <input className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" placeholder={t('vehiclePlate')} value={plate} onChange={(event) => setPlate(event.target.value)} /> : null}{status === 'confirmed' || status === 'dispatched' || status === 'completed' ? <><input className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" placeholder={t('driverName')} value={driverName} onChange={(event) => setDriverName(event.target.value)} /><input className="h-[38px] rounded-input border border-line bg-well px-3 text-sm" placeholder={t('driverPhone')} value={driverPhone} onChange={(event) => setDriverPhone(event.target.value)} /></> : null}{status === 'notExecuted' ? <textarea className="min-h-20 rounded-input border border-line bg-well px-3 py-2 text-sm" placeholder={t('notExecutedReason')} value={reason} onChange={(event) => setReason(event.target.value)} /> : null}<Button size="sm" disabled={submitProblem !== undefined} onClick={submit}>{t('transitionTo', { status: rootT(`vocab.executionStatuses.${status}`) })}</Button></div>;
}

function money(locale: ReturnType<typeof useCanonicalLocale>, amount: number, currency: string): string { return `${currency} ${formatMoneyParts(locale, amount).amount}`; }
