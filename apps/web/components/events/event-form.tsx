'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { api } from '@priamo/convex/api';
import type { currencyValidator } from '@priamo/convex/validators';

import { LocationPicker } from '@/components/locations/location-picker';
import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ServiceDateTime } from '@/components/services/service-fields';
import { Button } from '@/components/ui/button';
import { Field, FieldControl, FieldGroup, FieldLabel, FieldSpanFull } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { useLocaleHref } from '@/i18n/locale-link';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { budgetInputProblem, moneyInputText, parseMoneyInput } from '@/lib/money';
import { projectWindowDateBounds, projectWindowProblem } from '@/lib/project-window';
import { roleAtLeast } from '@/lib/roles';
import { timestampFromParts, timestampToParts, type TimestampParts } from '@/lib/timestamps';

import { CostCentrePicker } from './cost-centre-picker';
import { MemberPicker } from './member-picker';

type Currency = typeof currencyValidator.type;
type EventDetail = FunctionReturnType<typeof api.events.queries.getEventDetail>;
type ProjectId = FunctionArgs<typeof api.events.mutations.createEvent>['projectId'];
type EventId = FunctionArgs<typeof api.events.mutations.updateEvent>['eventId'];
type LocationId = NonNullable<FunctionArgs<typeof api.events.mutations.createEvent>['venueLocationId']>;
type CostCentreId = NonNullable<FunctionArgs<typeof api.events.mutations.createEvent>['clientCostCentreId']>;
type UserId = NonNullable<FunctionArgs<typeof api.events.mutations.createEvent>['accountableUserId']>;

const currencies = ['COP', 'USD', 'EUR', 'MXN'] as const satisfies readonly Currency[];
const emptyTimestamp: TimestampParts = { date: '', time: '' };

export function EventForm({
  detail,
  initialProjectId,
  onCancel,
}: {
  detail?: EventDetail | undefined;
  initialProjectId?: string | undefined;
  onCancel?: (() => void) | undefined;
}) {
  const t = useTranslations();
  const router = useRouter();
  const localeHref = useLocaleHref();
  const { currentOrganization } = useCurrentOrganization();
  const original = detail?.event;
  const organizationId = currentOrganization?.organization._id;
  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    organizationId === undefined ? 'skip' : { organizationId },
    { initialNumItems: 100 },
  );
  const [chosenProjectId, setChosenProjectId] = useState<ProjectId | undefined>();
  const projectId =
    chosenProjectId ??
    detail?.project._id ??
    projects.results.find((candidate) => candidate._id === initialProjectId)?._id;
  const project = useQuery(api.projects.queries.getProject, projectId === undefined ? 'skip' : { projectId });
  const [name, setName] = useState(original?.name ?? '');
  const [start, setStart] = useState<TimestampParts>(
    original === undefined ? emptyTimestamp : timestampToParts(original.startsAt),
  );
  const [end, setEnd] = useState<TimestampParts>(
    original?.endsAt === undefined ? emptyTimestamp : timestampToParts(original.endsAt),
  );
  const [venueId, setVenueId] = useState<LocationId | undefined>(original?.venueLocationId);
  const [costCentreId, setCostCentreId] = useState<CostCentreId | undefined>(original?.clientCostCentreId);
  const [accountableUserId, setAccountableUserId] = useState<UserId | undefined>(original?.accountableUserId);
  const [budgetAmount, setBudgetAmount] = useState(
    original?.budgetAmount === undefined ? '' : moneyInputText(original.budgetAmount),
  );
  const [budgetCurrency, setBudgetCurrency] = useState<Currency | ''>(original?.budgetCurrency ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const createEvent = useMutation(api.events.mutations.createEvent);
  const updateEvent = useMutation(api.events.mutations.updateEvent);

  if (currentOrganization === null) return null;
  if (!roleAtLeast(currentOrganization.role, 'planner')) {
    return (
      <Panel>
        <PanelBody>
          <p className="text-sm text-ink-2">{t('events.permissionNotice')}</p>
        </PanelBody>
      </Panel>
    );
  }

  async function submit(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    const startsAt = timestampFromParts(start);
    const endsAt = end.date === '' && end.time === '' ? undefined : timestampFromParts(end);
    if (name.trim() === '') {
      setMessage(t('events.invalidName'));
      return;
    }
    if (
      projectId === undefined ||
      project === undefined ||
      startsAt === undefined ||
      ((end.date !== '' || end.time !== '') && endsAt === undefined)
    ) {
      setMessage(t('events.invalidWindow'));
      return;
    }
    if (endsAt !== undefined && endsAt < startsAt) {
      setMessage(t('events.invalidWindow'));
      return;
    }
    if (projectWindowProblem(project, startsAt, endsAt) !== undefined) {
      setMessage(t('events.outsideProjectWindow'));
      return;
    }
    const budgetProblem = budgetInputProblem(budgetAmount, budgetCurrency);
    if (budgetProblem !== undefined) {
      setMessage(t(budgetProblem.kind === 'incomplete' ? 'events.budgetIncomplete' : 'events.invalidBudget'));
      return;
    }
    const parsedBudget = budgetAmount.trim() === '' ? undefined : parseMoneyInput(budgetAmount);
    if (parsedBudget !== undefined && !parsedBudget.ok) {
      setMessage(t('events.invalidBudget'));
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      if (original === undefined) {
        const eventId = await createEvent({
          projectId,
          name,
          startsAt,
          ...(endsAt === undefined ? {} : { endsAt }),
          ...(venueId === undefined ? {} : { venueLocationId: venueId }),
          ...(costCentreId === undefined ? {} : { clientCostCentreId: costCentreId }),
          ...(accountableUserId === undefined ? {} : { accountableUserId }),
          ...(parsedBudget === undefined || !parsedBudget.ok || budgetCurrency === ''
            ? {}
            : { budgetAmount: parsedBudget.minorUnits, budgetCurrency }),
        });
        // `router.push`, not `window.location.assign`: a hard navigation would
        // tear down the Convex client and re-fetch the whole shell to land on a
        // route this app can render in place. `service-create-surface` does the
        // same after its create.
        router.push(localeHref(`/events/${eventId}`));
      } else {
        const eventId: EventId = original._id;
        await updateEvent({
          eventId,
          ...(name === original.name ? {} : { name }),
          ...(startsAt === original.startsAt ? {} : { startsAt }),
          ...(endsAt === original.endsAt ? {} : { endsAt: endsAt ?? null }),
          ...(venueId === original.venueLocationId ? {} : { venueLocationId: venueId ?? null }),
          ...(costCentreId === original.clientCostCentreId ? {} : { clientCostCentreId: costCentreId ?? null }),
          ...(accountableUserId === original.accountableUserId ? {} : { accountableUserId: accountableUserId ?? null }),
          ...(parsedBudget === undefined
            ? original.budgetAmount === undefined
              ? {}
              : { budgetAmount: null, budgetCurrency: null }
            : !parsedBudget.ok || budgetCurrency === ''
              ? {}
              : parsedBudget.minorUnits === original.budgetAmount && budgetCurrency === original.budgetCurrency
                ? {}
                : { budgetAmount: parsedBudget.minorUnits, budgetCurrency }),
        });
        onCancel?.();
      }
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    } finally {
      setSubmitting(false);
    }
  }

  const bounds = project === undefined ? undefined : projectWindowDateBounds(project);
  return (
    <Panel emphasis="focal">
      <PanelHeader>
        <PanelTitle>{t(original === undefined ? 'events.createTitle' : 'events.editTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel required>{t('events.name')}</FieldLabel>
              <FieldControl required value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel required>{t('events.project')}</FieldLabel>
              <FieldControl
                render={<select />}
                required
                disabled={original !== undefined}
                value={projectId ?? ''}
                onChange={(event) =>
                  setChosenProjectId(projects.results.find((item) => item._id === event.target.value)?._id)
                }
              >
                <option value="">{t('events.selectPlaceholder')}</option>
                {projects.results
                  .filter((item) => item.status === 'draft' || item.status === 'active')
                  .map((item) => (
                    <option key={item._id} value={item._id}>
                      {item.name}
                    </option>
                  ))}
              </FieldControl>
            </Field>
            <ServiceDateTime label={t('events.startsAt')} value={start} onChange={setStart} required bounds={bounds} />
            <ServiceDateTime label={t('events.endsAt')} value={end} onChange={setEnd} bounds={bounds} />
            <FieldSpanFull>
              <Field>
                <FieldLabel>{t('events.venue')}</FieldLabel>
                <LocationPicker
                  fixedType="venue"
                  organizationId={currentOrganization.organization._id}
                  value={venueId}
                  onChange={setVenueId}
                />
                {venueId === undefined ? null : (
                  <Button type="button" size="sm" onClick={() => setVenueId(undefined)}>
                    {t('common.clear')}
                  </Button>
                )}
              </Field>
            </FieldSpanFull>
            <FieldSpanFull>
              <Field>
                <FieldLabel>{t('events.costCentre')}</FieldLabel>
                <CostCentrePicker
                  organizationId={currentOrganization.organization._id}
                  value={costCentreId}
                  onChange={setCostCentreId}
                />
                {costCentreId === undefined ? null : (
                  <Button type="button" size="sm" onClick={() => setCostCentreId(undefined)}>
                    {t('common.clear')}
                  </Button>
                )}
              </Field>
            </FieldSpanFull>
            <Field>
              <FieldLabel>{t('events.budgetAmount')}</FieldLabel>
              <FieldControl
                inputMode="decimal"
                value={budgetAmount}
                onChange={(event) => setBudgetAmount(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>{t('events.budgetCurrency')}</FieldLabel>
              <FieldControl
                render={<select />}
                value={budgetCurrency}
                onChange={(event) => setBudgetCurrency(currencies.find((item) => item === event.target.value) ?? '')}
              >
                <option value="">{t('events.selectPlaceholder')}</option>
                {currencies.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </FieldControl>
            </Field>
            <FieldSpanFull>
              <Field>
                <FieldLabel>{t('events.accountable')}</FieldLabel>
                <MemberPicker
                  organizationId={currentOrganization.organization._id}
                  value={accountableUserId}
                  onChange={setAccountableUserId}
                />
                {accountableUserId === undefined ? null : (
                  <Button type="button" size="sm" onClick={() => setAccountableUserId(undefined)}>
                    {t('common.clear')}
                  </Button>
                )}
              </Field>
            </FieldSpanFull>
          </FieldGroup>
          {message === null ? null : (
            <p role="alert" className="text-sm text-tone-stop">
              {message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={submitting}>
              {t('events.save')}
            </Button>
            <Button type="button" onClick={onCancel ?? (() => window.history.back())}>
              {t('events.cancel')}
            </Button>
          </div>
        </form>
      </PanelBody>
    </Panel>
  );
}
