'use client';

import { useMutation, usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { api } from '@priamo/convex/api';

import { useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import { mayRemoveServiceRelationship, relationshipTargetOptions } from '@/lib/service-relationships';

type ServiceId = FunctionArgs<typeof api.services.queries.getService>['serviceId'];
type ProjectId = FunctionArgs<typeof api.projects.queries.getProject>['projectId'];
type RelationshipType = FunctionArgs<typeof api.relationships.mutations.createRelationship>['type'];
type Relationship = FunctionReturnType<typeof api.relationships.queries.listOutgoingRelationships>['page'][number];
type Project = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number];
type Service = FunctionReturnType<typeof api.services.queries.listProjectServices>['page'][number];

const relationshipTypes = ['dependsOn', 'follows', 'parentOf', 'relatedTo'] as const satisfies readonly RelationshipType[];
type CoversExactly<Listed extends RelationshipType, Union> = [Union] extends [Listed] ? true : never;
const _relationshipTypesInSync: CoversExactly<(typeof relationshipTypes)[number], RelationshipType> = true;
void _relationshipTypesInSync;

export function ServiceRelationships({ serviceId, canEdit }: { serviceId: ServiceId; canEdit: boolean }) {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const outgoing = usePaginatedQuery(
    api.relationships.queries.listOutgoingRelationships,
    { serviceId },
    { initialNumItems: 25 },
  );
  const incoming = usePaginatedQuery(
    api.relationships.queries.listIncomingRelationships,
    { serviceId },
    { initialNumItems: 25 },
  );
  const projects = usePaginatedQuery(
    api.projects.queries.listProjects,
    currentOrganization === null ? 'skip' : { organizationId: currentOrganization.organization._id },
    { initialNumItems: 25 },
  );
  const [removal, setRemoval] = useState<Relationship | null>(null);
  const remove = useMutation(api.relationships.mutations.removeRelationship);
  const [message, setMessage] = useState<string | null>(null);

  async function confirmRemoval(): Promise<void> {
    if (removal === null) return;
    try {
      await remove({ relationshipId: removal._id });
      setRemoval(null);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('relationships.title')}</PanelTitle>
      </PanelHeader>
      <PanelBodyFlush>
        {message === null ? null : <p role="alert" className="mx-5 mt-5 rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop sm:mx-6">{message}</p>}
        {canEdit ? <RelationshipForm serviceId={serviceId} projects={projects.results} projectsStatus={projects.status} loadProjects={projects.loadMore} /> : null}
        <RelationshipGroup
          direction="outgoing"
          relationships={outgoing.results}
          status={outgoing.status}
          onLoadMore={outgoing.loadMore}
          canEdit={canEdit}
          onRemove={setRemoval}
        />
        <RelationshipGroup
          direction="incoming"
          relationships={incoming.results}
          status={incoming.status}
          onLoadMore={incoming.loadMore}
          canEdit={canEdit}
          onRemove={setRemoval}
        />
        {removal === null ? null : (
          <Panel emphasis="inset" className="m-5 sm:m-6">
            <PanelBody className="gap-4 p-4">
              <div>
                <p className="text-sm font-semibold text-ink">{t('relationships.removeTitle')}</p>
                <RelationshipSentence direction="outgoing" relationship={removal} />
                <p className="mt-1 text-sm text-ink-2">{t('relationships.removeWarning')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" onClick={confirmRemoval}>{t('relationships.removeConfirm')}</Button>
                <Button onClick={() => setRemoval(null)}>{t('common.cancel')}</Button>
              </div>
            </PanelBody>
          </Panel>
        )}
      </PanelBodyFlush>
    </Panel>
  );
}

function RelationshipGroup({
  direction,
  relationships,
  status,
  onLoadMore,
  canEdit,
  onRemove,
}: {
  direction: 'outgoing' | 'incoming';
  relationships: readonly Relationship[];
  status: ReturnType<typeof usePaginatedQuery<typeof api.relationships.queries.listOutgoingRelationships>>['status'];
  onLoadMore: (pageSize: number) => void;
  canEdit: boolean;
  onRemove: (relationship: Relationship) => void;
}) {
  const t = useTranslations();
  const outgoing = direction === 'outgoing';
  const mayRemove = mayRemoveServiceRelationship(direction, canEdit);
  const title = outgoing ? t('relationships.outgoingTitle') : t('relationships.incomingTitle');

  return (
    <section className="border-t border-line" aria-labelledby={`relationship-${direction}-title`}>
      <div className="flex flex-col gap-1 px-5 pt-5 sm:px-6">
        <h3 id={`relationship-${direction}-title`} className="text-sm font-semibold text-ink">{title}</h3>
        {outgoing ? null : <p className="text-xs text-ink-3">{t('relationships.managedFromSource')}</p>}
      </div>
      {status !== 'LoadingFirstPage' && relationships.length === 0 ? (
        <EmptyState title={outgoing ? t('relationships.outgoingEmpty') : t('relationships.incomingEmpty')} />
      ) : (
        <Table>
          <TableHead>
            <TableRow className="bg-ground-3 hover:bg-ground-3">
              <TableHeaderCell>{t('relationships.link')}</TableHeaderCell>
              {mayRemove ? (
                <TableHeaderCell align="end">
                  <span className="sr-only">{t('relationships.actions')}</span>
                </TableHeaderCell>
              ) : null}
            </TableRow>
          </TableHead>
          {status === 'LoadingFirstPage' ? (
            <TableSkeletonRows columns={mayRemove ? 2 : 1} />
          ) : (
            <TableBody>
              {relationships.map((relationship) => (
                <TableRow key={relationship._id}>
                  <TableRowHeaderCell>
                    <RelationshipSentence direction={direction} relationship={relationship} />
                  </TableRowHeaderCell>
                  {mayRemove ? (
                    <TableCell align="end">
                      <Button size="sm" variant="danger" onClick={() => onRemove(relationship)}>{t('relationships.remove')}</Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          )}
        </Table>
      )}
      <TableLoadMore status={status} loadedCount={relationships.length} onLoadMore={onLoadMore} />
    </section>
  );
}

function RelationshipSentence({ direction, relationship }: { direction: 'outgoing' | 'incoming'; relationship: Relationship }) {
  const t = useTranslations();
  const counterpart = (
    <LocaleLink className="underline decoration-line-strong underline-offset-4 hover:decoration-accent" to={`/services/${relationship.counterpartService._id}`}>
      {relationship.counterpartService.name}
    </LocaleLink>
  );
  const type = <strong className="font-semibold">{t(`relationships.types.${relationship.type}`)}</strong>;
  const thisService = <span>{t('relationships.thisService')}</span>;

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-2">
      {direction === 'outgoing' ? <>{thisService} {type} <span aria-hidden="true">→</span> {counterpart}</> : <>{counterpart} {type} <span aria-hidden="true">→</span> {thisService}</>}
      <StatusChip kind="service" status={relationship.counterpartService.status} />
    </div>
  );
}

function RelationshipForm({
  serviceId,
  projects,
  projectsStatus,
  loadProjects,
}: {
  serviceId: ServiceId;
  projects: readonly Project[];
  projectsStatus: ReturnType<typeof usePaginatedQuery<typeof api.projects.queries.listProjects>>['status'];
  loadProjects: (pageSize: number) => void;
}) {
  const t = useTranslations();
  const [projectId, setProjectId] = useState<ProjectId>();
  const [targetId, setTargetId] = useState<ServiceId>();
  const [type, setType] = useState<RelationshipType>('dependsOn');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const create = useMutation(api.relationships.mutations.createRelationship);
  const targetServices = usePaginatedQuery(
    api.services.queries.listProjectServices,
    projectId === undefined ? 'skip' : { projectId },
    { initialNumItems: 25 },
  );
  // An archived target project is refused by createRelationship, so it is not
  // offered. UI checks are affordances only; the mutation remains authoritative.
  const targetProjects = projects.filter((project) => project.status !== 'archived');
  const targetOptions = relationshipTargetOptions<Service>(targetServices.results, serviceId);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (targetId === undefined) return;
    setSubmitting(true);
    setError(null);
    try {
      await create({ sourceServiceId: serviceId, targetServiceId: targetId, type });
      setTargetId(undefined);
    } catch (caught) {
      const key = errorMessageKey(presentConvexError(caught));
      setError(t(key === 'errors.conflict' ? 'relationships.duplicate' : key));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-5 py-5 sm:px-6">
      <h3 className="text-sm font-semibold text-ink">{t('relationships.createTitle')}</h3>
      <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel required>{t('relationships.targetProject')}</FieldLabel>
            <FieldControl
              render={<select />}
              required
              value={projectId ?? ''}
              onChange={(event) => {
                setProjectId(targetProjects.find((project) => project._id === event.target.value)?._id);
                setTargetId(undefined);
              }}
            >
              <option value="">{t('relationships.selectPlaceholder')}</option>
              {targetProjects.map((project) => <option key={project._id} value={project._id}>{project.name}</option>)}
            </FieldControl>
            {projectsStatus === 'CanLoadMore' ? <Button type="button" size="sm" variant="link" onClick={() => loadProjects(25)}>{t('table.loadMore')}</Button> : null}
          </Field>
          <Field>
            <FieldLabel required>{t('relationships.targetService')}</FieldLabel>
            <FieldControl
              render={<select />}
              required
              disabled={projectId === undefined}
              value={targetId ?? ''}
              onChange={(event) => setTargetId(targetOptions.find((service) => service._id === event.target.value)?._id)}
            >
              <option value="">{t('relationships.selectPlaceholder')}</option>
              {targetOptions.map((service) => <option key={service._id} value={service._id}>{service.name}</option>)}
            </FieldControl>
            {targetServices.status === 'Exhausted' && projectId !== undefined && targetOptions.length === 0 ? <p className="text-xs text-ink-3">{t('relationships.noTargetServices')}</p> : null}
            {targetServices.status === 'CanLoadMore' ? <Button type="button" size="sm" variant="link" onClick={() => targetServices.loadMore(25)}>{t('table.loadMore')}</Button> : null}
          </Field>
          <Field>
            <FieldLabel required>{t('relationships.type')}</FieldLabel>
            <FieldControl
              render={<select />}
              required
              value={type}
              onChange={(event) => {
                const selected = relationshipTypes.find((relationshipType) => relationshipType === event.target.value);
                if (selected !== undefined) setType(selected);
              }}
            >
              {relationshipTypes.map((relationshipType) => <option key={relationshipType} value={relationshipType}>{t(`relationships.types.${relationshipType}`)}</option>)}
            </FieldControl>
          </Field>
        </FieldGroup>
        {error === null ? null : <p role="alert" className="text-xs text-tone-stop">{error}</p>}
        <Button type="submit" variant="primary" disabled={targetId === undefined || submitting} className="self-start">{t('relationships.create')}</Button>
      </form>
    </div>
  );
}
