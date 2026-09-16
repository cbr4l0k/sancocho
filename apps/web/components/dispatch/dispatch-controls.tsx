'use client';

import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, useSyncExternalStore } from 'react';

import { api } from '@priamo/convex/api';
import { executionStatusTransitions } from '@priamo/convex/assignments/execution';

import { Button } from '@/components/ui/button';
import { LocaleLink } from '@/i18n/locale-link';
import { assignmentActions, type AssignmentActor } from '@/lib/assignment-actions';
import { executionSubmitProblem } from '@/lib/assignment-execution';
import { readExecutionStatus } from '@/lib/assignment-flow';
import type { DispatchDay } from '@/lib/dispatch-day';
import { browserDispatchDay, dispatchDayNavigation } from '@/lib/dispatch-day';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';

type CoordinatorEntry = FunctionReturnType<typeof api.assignments.queries.listDispatchDay>['page'][number];
type ProviderEntry = FunctionReturnType<typeof api.assignments.queries.listProviderDispatchDay>['page'][number];
type DispatchAssignment = CoordinatorEntry['rows'][number]['assignment'] | ProviderEntry['assignment'];

const subscribeToBrowser = (): (() => void) => () => undefined;

/** Defers local-midnight arithmetic until the viewer's browser exists. */
export function useBrowserDispatchDay(key: string | undefined): DispatchDay | undefined {
  const browser = useSyncExternalStore(subscribeToBrowser, () => true, () => false);
  if (!browser) return undefined;
  return browserDispatchDay(key, new Date());
}

export function DispatchDayNavigation({ day, path }: { day: DispatchDay; path: '/dispatch' | '/portal/dispatch' }) {
  const t = useTranslations('dispatch');
  const navigation = dispatchDayNavigation(day, path);
  return (
    <nav className="dispatch-no-print flex flex-wrap items-center gap-2" aria-label={t('dayNavigation')}>
      <Button size="sm" variant="secondary" render={<LocaleLink to={navigation.previous.href} />}>
        {t('previousDay')}
      </Button>
      <time className="rounded-pill bg-ground-2 px-4 py-2 font-mono text-sm text-ink" dateTime={day.key}>{day.key}</time>
      <Button size="sm" variant="secondary" render={<LocaleLink to={navigation.next.href} />}>
        {t('nextDay')}
      </Button>
    </nav>
  );
}

export function DispatchExecutionEditor({
  actor,
  assignment,
  onMessage,
}: {
  actor: AssignmentActor;
  assignment: DispatchAssignment;
  onMessage: (message: string | null) => void;
}) {
  const t = useTranslations('dispatch');
  const rootT = useTranslations();
  const transition = useMutation(api.assignments.mutations.transitionAssignmentExecution);
  const next = executionStatusTransitions[assignment.executionStatus];
  const [status, setStatus] = useState<(typeof next)[number] | undefined>(next[0]);
  const [plate, setPlate] = useState(assignment.vehiclePlateOverride ?? '');
  const [driverName, setDriverName] = useState(assignment.driverName ?? '');
  const [driverPhone, setDriverPhone] = useState(assignment.driverPhone ?? '');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const actions = assignmentActions(actor, {
    serviceWritable: true,
    hasRevisionHistory: false,
    revision: null,
    executionStatus: assignment.executionStatus,
  });

  if (!actions.has('transitionExecution') || status === undefined) return null;
  const selectedStatus = status;
  const needsVehicle = selectedStatus !== 'unassigned' && selectedStatus !== 'notExecuted';
  const submitProblem = executionSubmitProblem({
    status: selectedStatus,
    fleetVehicleId: assignment.fleetVehicleId,
    vehiclePlateOverride: plate,
    driverName,
    notExecutedReason: reason,
  });

  async function submit(): Promise<void> {
    setSubmitting(true);
    try {
      await transition({
        assignmentId: assignment._id,
        status: selectedStatus,
        ...(assignment.fleetVehicleId === undefined && plate.trim() !== ''
          ? { vehiclePlateOverride: plate.trim() }
          : {}),
        ...(driverName.trim() === '' ? {} : { driverName: driverName.trim() }),
        ...(driverPhone.trim() === '' ? {} : { driverPhone: driverPhone.trim() }),
        ...(selectedStatus === 'notExecuted' ? { notExecutedReason: reason.trim() } : {}),
      });
      onMessage(null);
    } catch (error) {
      onMessage(rootT(errorMessageKey(presentConvexError(error))));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <details className="dispatch-no-print mt-2 min-w-48 text-left">
      <summary className="cursor-pointer text-xs font-medium text-ink underline decoration-line-strong underline-offset-4">
        {t('editExecution')}
      </summary>
      <div className="mt-3 flex flex-col gap-2 rounded-input border border-line bg-ground-2 p-3">
        <label className="flex flex-col gap-1 text-xs text-ink-3">
          {t('executionStatus')}
          <select className="h-[38px] rounded-input border border-line bg-well px-3 text-sm text-ink" value={status} disabled={submitting} onChange={(event) => setStatus(readExecutionStatus(next, event.target.value))}>
            {next.map((item) => <option key={item} value={item}>{rootT(`vocab.executionStatuses.${item}`)}</option>)}
          </select>
        </label>
        {needsVehicle ? assignment.fleetVehicleId === undefined ? (
          <label className="flex flex-col gap-1 text-xs text-ink-3">{t('plate')}<input className="h-[38px] rounded-input border border-line bg-well px-3 text-sm text-ink" value={plate} disabled={submitting} onChange={(event) => setPlate(event.target.value)} /></label>
        ) : <p className="text-xs text-ink-2">{t('assignedVehiclePreserved')}</p> : null}
        {selectedStatus === 'confirmed' || selectedStatus === 'dispatched' || selectedStatus === 'completed' ? (
          <>
            <label className="flex flex-col gap-1 text-xs text-ink-3">{t('driver')}<input className="h-[38px] rounded-input border border-line bg-well px-3 text-sm text-ink" value={driverName} disabled={submitting} onChange={(event) => setDriverName(event.target.value)} /></label>
            <label className="flex flex-col gap-1 text-xs text-ink-3">{t('driverPhone')}<input className="h-[38px] rounded-input border border-line bg-well px-3 text-sm text-ink" value={driverPhone} disabled={submitting} onChange={(event) => setDriverPhone(event.target.value)} /></label>
          </>
        ) : null}
        {selectedStatus === 'notExecuted' ? <label className="flex flex-col gap-1 text-xs text-ink-3">{t('notExecutedReason')}<textarea className="min-h-20 rounded-input border border-line bg-well px-3 py-2 text-sm text-ink" value={reason} disabled={submitting} onChange={(event) => setReason(event.target.value)} /></label> : null}
        <Button size="sm" disabled={submitProblem !== undefined || submitting} onClick={submit}>{t('saveExecution')}</Button>
      </div>
    </details>
  );
}
