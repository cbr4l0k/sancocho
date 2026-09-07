'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { ProjectWindowHint, ServiceDateTime, ServiceDynamicField } from '@/components/services/service-fields';
import { Button } from '@/components/ui/button';
import { Field, FieldControl, FieldGroup, FieldLabel, FieldSpanFull } from '@/components/ui/field';
import { Panel, PanelBody } from '@/components/ui/panel';
import { LocaleLink, useLocaleHref } from '@/i18n/locale-link';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import {
  emptyFieldValueFormState,
  fromServiceFieldValue,
  toServiceFieldValue,
  type FieldValueFormState,
} from '@/lib/field-value-form';
import { projectWindowDateBounds, projectWindowProblem } from '@/lib/project-window';
import { roleAtLeast } from '@/lib/roles';
import { serviceFieldProblem } from '@/lib/service-form-checks';
import { timestampFromParts, type TimestampParts } from '@/lib/timestamps';

type ProjectId = FunctionArgs<typeof api.projects.queries.getProject>['projectId'];
type ServiceKindVersionId = FunctionArgs<typeof api.serviceKinds.fields.queries.listServiceKindFields>['serviceKindVersionId'];
type ServiceKindField = FunctionReturnType<typeof api.serviceKinds.fields.queries.listServiceKindFields>[number];

/**
 * Creating a service is one form on one screen.
 *
 * It used to be three stacked panels revealed in sequence — pick a project from
 * a wall of buttons, then pick a service kind from another wall, and only then did any
 * input appear — which meant you could not see what a service actually required
 * until you had already committed to two choices, and the picker issued one
 * `getServiceKind` query per listed service kind to find out which of them were even
 * usable. Now the whole shape of the record is visible immediately: project and
 * service kind are two selects at the top, the fields below them fill in as soon as a
 * service kind is chosen, and the server answers "which service kinds are usable" in a
 * single paginated query.
 */
export function ServiceCreateSurface({ initialProjectId }: { initialProjectId?: string }) {
  const t = useTranslations();
  const router = useRouter();
  const localeHref = useLocaleHref();
  const { currentOrganization } = useCurrentOrganization();
  const organizationId = currentOrganization?.organization._id;

  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    organizationId === undefined ? 'skip' : { organizationId },
    { initialNumItems: 100 },
  );
  const serviceKinds = usePaginatedQuery(
    api.serviceKinds.queries.listPublishedServiceKinds,
    organizationId === undefined ? 'skip' : { organizationId },
    { initialNumItems: 100 },
  );

  const [chosenProjectId, setChosenProjectId] = useState<ProjectId>();
  const [chosenVersionId, setChosenVersionId] = useState<ServiceKindVersionId>();
  const [name, setName] = useState('');
  const [start, setStart] = useState<TimestampParts>({ date: '', time: '' });
  const [end, setEnd] = useState<TimestampParts>({ date: '', time: '' });
  const [values, setValues] = useState<Map<string, FieldValueFormState>>(new Map());
  const [message, setMessage] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  // A project cannot take new services once it is completed or archived, so it
  // is not offered rather than offered-and-rejected.
  const selectableProjects = projects.results.filter(
    (project) => project.status !== 'archived' && project.status !== 'completed',
  );
  /* `initialProjectId` arrives from the query string, so it is matched against
   * loaded projects rather than trusted: only an id the server already returned
   * for this organization can end up in the mutation. */
  const selectedProject =
    selectableProjects.find((project) => project._id === (chosenProjectId ?? initialProjectId)) ??
    (selectableProjects.length === 1 ? selectableProjects[0] : undefined);
  const selectedServiceKind =
    serviceKinds.results.find((entry) => entry.publishedVersion._id === chosenVersionId) ??
    (serviceKinds.results.length === 1 ? serviceKinds.results[0] : undefined);
  const serviceKindVersionId = selectedServiceKind?.publishedVersion._id;

  const fields = useQuery(
    api.serviceKinds.fields.queries.listServiceKindFields,
    serviceKindVersionId === undefined ? 'skip' : { serviceKindVersionId },
  );
  const definitions = useQuery(
    api.fields.queries.getFieldDefinitionsByIds,
    fields === undefined || organizationId === undefined
      ? 'skip'
      : { organizationId, fieldDefinitionIds: fields.map((field) => field.fieldDefinitionId) },
  );

  const create = useMutation(api.services.mutations.createServiceFromServiceKind);
  const canCreate = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'planner');

  if (currentOrganization === null || organizationId === undefined) return null;

  const labels = new Map((definitions ?? []).map((definition) => [definition._id, definition.label]));
  const visibleFields = (fields ?? []).filter((field) => field.visible);

  function fieldState(field: ServiceKindField): FieldValueFormState {
    return (
      values.get(field.fieldDefinitionId) ??
      (field.defaultValue === undefined
        ? emptyFieldValueFormState(field.config.kind)
        : fromServiceFieldValue(field.defaultValue))
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedProject === undefined || serviceKindVersionId === undefined) return;

    const startsAt = timestampFromParts(start);
    const endsAt = end.date === '' && end.time === '' ? undefined : timestampFromParts(end);
    if (
      startsAt === undefined ||
      (endsAt === undefined && !(end.date === '' && end.time === '')) ||
      (endsAt !== undefined && endsAt < startsAt)
    ) {
      setMessage(t('errors.serviceDatesInvalid'));
      return;
    }
    // The chosen project's window is the other half of the date rule. Checked
    // here so the mistake is named on the form rather than arriving as a
    // rejected mutation; `validateServiceWithinProjectWindow` still decides.
    const outside = projectWindowProblem(selectedProject, startsAt, endsAt);
    if (outside !== undefined) {
      setMessage(t(outside === 'before' ? 'errors.serviceBeforeProjectWindow' : 'errors.serviceAfterProjectWindow'));
      return;
    }

    for (const field of visibleFields) {
      const problem = serviceFieldProblem(
        field.config,
        toServiceFieldValue(fieldState(field)),
        field.required,
        field.defaultValue !== undefined,
      );
      if (problem !== undefined) {
        setMessage(t('services.fieldInvalid'));
        return;
      }
    }

    const submitted = visibleFields.flatMap((field) => {
      const value = toServiceFieldValue(fieldState(field));
      return value === undefined ? [] : [{ fieldDefinitionId: field.fieldDefinitionId, value }];
    });

    setSubmitting(true);
    setMessage(undefined);
    try {
      const serviceId = await create({
        projectId: selectedProject._id,
        serviceKindVersionId,
        name,
        startsAt,
        ...(endsAt === undefined ? {} : { endsAt }),
        values: submitted,
      });
      router.push(localeHref(`/services/${serviceId}`));
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    } finally {
      setSubmitting(false);
    }
  }

  const ready = canCreate && selectedProject !== undefined && serviceKindVersionId !== undefined;

  return (
    <div className="flex flex-col gap-6">
      {canCreate ? null : <p className="text-sm text-ink-3">{t('services.permissionNotice')}</p>}
      <Panel emphasis="focal">
        <PanelBody>
          <form className="flex flex-col gap-6" onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel required>{t('services.project')}</FieldLabel>
                <FieldControl
                  render={<select />}
                  required
                  className="text-sm normal-case tracking-normal"
                  value={selectedProject?._id ?? ''}
                  onChange={(event) =>
                    setChosenProjectId(
                      selectableProjects.find((project) => project._id === event.target.value)?._id,
                    )
                  }
                >
                  <option value="">{t('services.selectPlaceholder')}</option>
                  {selectableProjects.map((project) => (
                    <option key={project._id} value={project._id}>
                      {project.name}
                    </option>
                  ))}
                </FieldControl>
                {projects.status === 'Exhausted' && selectableProjects.length === 0 ? (
                  <p className="text-xs text-ink-3">{t('services.noProjectsHint')}</p>
                ) : null}
                {/* The query is paginated, so a tenant past the first page needs
                 * a way to reach the rest — a `<select>` cannot scroll-load. */}
                {projects.status === 'CanLoadMore' ? (
                  <Button type="button" variant="link" size="sm" onClick={() => projects.loadMore(100)}>
                    {t('services.loadMore')}
                  </Button>
                ) : null}
              </Field>
              <Field>
                <FieldLabel required>{t('services.serviceKind')}</FieldLabel>
                <FieldControl
                  render={<select />}
                  required
                  className="text-sm normal-case tracking-normal"
                  value={serviceKindVersionId ?? ''}
                  onChange={(event) => {
                    setChosenVersionId(
                      serviceKinds.results.find((entry) => entry.publishedVersion._id === event.target.value)
                        ?.publishedVersion._id,
                    );
                    // A different service kind means a different field set; values
                    // keyed by the previous service kind's fields must not carry over.
                    setValues(new Map());
                  }}
                >
                  <option value="">{t('services.selectPlaceholder')}</option>
                  {serviceKinds.results.map((entry) => (
                    <option key={entry.serviceKind._id} value={entry.publishedVersion._id}>
                      {entry.serviceKind.name}
                    </option>
                  ))}
                </FieldControl>
                {serviceKinds.status === 'Exhausted' && serviceKinds.results.length === 0 ? (
                  <p className="text-xs text-ink-3">{t('services.noServiceKindsHint')}</p>
                ) : null}
                {serviceKinds.status === 'CanLoadMore' ? (
                  <Button type="button" variant="link" size="sm" onClick={() => serviceKinds.loadMore(100)}>
                    {t('services.loadMore')}
                  </Button>
                ) : null}
              </Field>
            </FieldGroup>

            <hr className="border-0 border-t border-line" />

            <FieldGroup>
              <FieldSpanFull>
                <Field>
                  <FieldLabel required>{t('services.name')}</FieldLabel>
                  <FieldControl required value={name} onChange={(event) => setName(event.target.value)} />
                </Field>
              </FieldSpanFull>
              {selectedProject === undefined ? null : <ProjectWindowHint project={selectedProject} />}
              <ServiceDateTime
                label={t('services.startsAt')}
                value={start}
                onChange={setStart}
                required
                bounds={selectedProject === undefined ? undefined : projectWindowDateBounds(selectedProject)}
              />
              <ServiceDateTime
                label={t('services.endsAt')}
                value={end}
                onChange={setEnd}
                bounds={selectedProject === undefined ? undefined : projectWindowDateBounds(selectedProject)}
              />
              {serviceKindVersionId === undefined ? (
                <FieldSpanFull>
                  <p className="text-sm text-ink-3">{t('services.chooseServiceKindHint')}</p>
                </FieldSpanFull>
              ) : (
                visibleFields.map((field) => (
                  <ServiceDynamicField
                    key={field._id}
                    field={field}
                    label={labels.get(field.fieldDefinitionId) ?? t('common.notAvailable')}
                    value={fieldState(field)}
                    organizationId={organizationId}
                    hasDefault={field.defaultValue !== undefined}
                    onChange={(next) => setValues((old) => new Map(old).set(field.fieldDefinitionId, next))}
                  />
                ))
              )}
            </FieldGroup>

            {message === undefined ? null : (
              <p role="alert" className="text-sm text-tone-stop">
                {message}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={!ready || submitting}>
                {t('services.create')}
              </Button>
              <Button type="button" render={<LocaleLink to="/services" />}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        </PanelBody>
      </Panel>
    </div>
  );
}
