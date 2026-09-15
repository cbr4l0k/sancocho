'use client';

import { useMutation, usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { api } from '@priamo/convex/api';

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
import { catalogueArgs } from '@/lib/catalogue-filters';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { providerClaimAffordance } from '@/lib/provider-claim';
import { roleAtLeast } from '@/lib/roles';
import { archivalStatuses, type ArchivalStatus } from '@/lib/status';
import { optionalTextMutationValue, storedOptionalText } from '@/lib/stored-optional-text';
import { useDebouncedValue } from '@/lib/use-debounced-value';

type Provider = FunctionReturnType<typeof api.providers.queries.listProviders>['page'][number];
type Invitation = FunctionReturnType<typeof api.providers.queries.listProviderClaimInvitations>['page'][number];
type ClaimInvitation = Extract<Invitation, { kind: 'providerClaim' }>;
type EditorState = { mode: 'create' } | { mode: 'edit'; provider: Provider } | null;
type Confirmation = { mode: 'archive' | 'revokeClaim'; provider: Provider } | null;

export function ProvidersSurface() {
  const t = useTranslations();
  const { currentOrganization } = useCurrentOrganization();
  const organizationId = currentOrganization?.organization._id;
  const canManage = currentOrganization !== null && roleAtLeast(currentOrganization.role, 'admin');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ArchivalStatus | ''>('');
  const debouncedSearch = useDebouncedValue(search);
  const providers = usePaginatedQuery(
    api.providers.queries.listProviders,
    catalogueArgs(organizationId, { search: debouncedSearch, status }),
    { initialNumItems: 25 },
  );
  // Organization-wide and admin-only, because the backend publishes no
  // per-Provider claim invitation query. Viewers still get the Provider read
  // surface, but invitation state stays unknown and no write affordances render.
  //
  // Until every page is loaded, invite is withheld: the backend conflict is
  // address-scoped, not Provider-scoped, so a different email could otherwise
  // create a second live claim offer for the same Provider.
  const invitations = usePaginatedQuery(
    api.providers.queries.listProviderClaimInvitations,
    organizationId === undefined || !canManage ? 'skip' : { organizationId },
    { initialNumItems: 100 },
  );
  const create = useMutation(api.providers.mutations.createProvider);
  const update = useMutation(api.providers.mutations.updateProvider);
  const archive = useMutation(api.providers.mutations.archiveProvider);
  const invite = useMutation(api.providers.mutations.inviteProviderOrganization);
  const revokeInvitation = useMutation(api.providers.mutations.revokeProviderClaimInvitation);
  const revokeClaim = useMutation(api.providers.mutations.revokeProviderOrganizationClaim);
  const [editor, setEditor] = useState<EditorState>(null);
  const [inviting, setInviting] = useState<Provider | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (currentOrganization === null) return null;
  const hasFilters = search.trim() !== '' || status !== '';

  async function confirm(): Promise<void> {
    if (confirmation === null) return;
    try {
      if (confirmation.mode === 'archive') await archive({ providerId: confirmation.provider._id });
      else await revokeClaim({ providerId: confirmation.provider._id });
      setConfirmation(null);
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {canManage && editor === null ? (
        <PageHeader
          actions={
            <Button variant="primary" onClick={() => setEditor({ mode: 'create' })}>
              {t('providers.create')}
            </Button>
          }
        />
      ) : null}
      {message === null ? null : <Alert>{message}</Alert>}
      {editor === null ? null : (
        <ProviderEditor
          key={editor.mode === 'create' ? 'create' : editor.provider._id}
          provider={editor.mode === 'edit' ? editor.provider : undefined}
          organizationId={currentOrganization.organization._id}
          onClose={() => setEditor(null)}
          onCreate={create}
          onUpdate={update}
        />
      )}
      {inviting === null ? null : (
        <ProviderInvite provider={inviting} onClose={() => setInviting(null)} onInvite={invite} />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FilterLabel label={t('providers.search')}>
          <input
            className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </FilterLabel>
        <FilterLabel label={t('providers.statusFilter')}>
          <select
            className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
            value={status}
            onChange={(event) => setStatus(archivalStatuses.find((item) => item === event.target.value) ?? '')}
          >
            <option value="">{t('providers.allStatuses')}</option>
            {archivalStatuses.map((item) => (
              <option key={item} value={item}>
                {t(`fields.statuses.${item}`)}
              </option>
            ))}
          </select>
        </FilterLabel>
      </div>
      {providers.status === 'Exhausted' && providers.results.length === 0 ? (
        <EmptyState
          tone={hasFilters ? 'filtered' : 'empty'}
          title={t(hasFilters ? 'providers.noMatchesTitle' : 'providers.emptyTitle')}
          description={t(hasFilters ? 'providers.noMatchesBody' : 'providers.emptyBody')}
        />
      ) : (
        <ProviderTable
          providers={providers.results}
          invitations={invitations.results}
          invitationsExhausted={invitations.status === 'Exhausted'}
          loading={providers.status === 'LoadingFirstPage'}
          canManage={canManage}
          onEdit={(provider) => setEditor({ mode: 'edit', provider })}
          onArchive={(provider) => setConfirmation({ mode: 'archive', provider })}
          onInvite={setInviting}
          onRevokeInvitation={async (invitation) => {
            try {
              await revokeInvitation({ invitationId: invitation._id });
            } catch (error) {
              setMessage(t(errorMessageKey(presentConvexError(error))));
            }
          }}
          onRevokeClaim={(provider) => setConfirmation({ mode: 'revokeClaim', provider })}
        />
      )}
      <TableLoadMore status={providers.status} loadedCount={providers.results.length} onLoadMore={providers.loadMore} />
      {canManage && invitations.status === 'CanLoadMore' ? (
        <Button className="self-start" size="sm" onClick={() => invitations.loadMore(100)}>
          {t('table.loadMore')}
        </Button>
      ) : null}
      {confirmation === null ? null : (
        <ConfirmationPanel mode={confirmation.mode} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
      )}
    </div>
  );
}

function ProviderTable({
  providers,
  invitations,
  invitationsExhausted,
  loading,
  canManage,
  onEdit,
  onArchive,
  onInvite,
  onRevokeInvitation,
  onRevokeClaim,
}: {
  providers: readonly Provider[];
  invitations: readonly Invitation[];
  invitationsExhausted: boolean;
  loading: boolean;
  canManage: boolean;
  onEdit: (provider: Provider) => void;
  onArchive: (provider: Provider) => void;
  onInvite: (provider: Provider) => void;
  onRevokeInvitation: (invitation: ClaimInvitation) => Promise<void>;
  onRevokeClaim: (provider: Provider) => void;
}) {
  const t = useTranslations();
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{t('providers.listTitle')}</PanelTitle>
      </PanelHeader>
      <PanelBodyFlush>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('providers.name')}</TableHeaderCell>
              <TableHeaderCell>{t('providers.contactName')}</TableHeaderCell>
              <TableHeaderCell>{t('providers.status')}</TableHeaderCell>
              <TableHeaderCell>{t('providers.claimState')}</TableHeaderCell>
              {canManage ? <TableHeaderCell /> : null}
            </TableRow>
          </TableHead>
          {loading ? (
            <TableSkeletonRows columns={canManage ? 5 : 4} />
          ) : (
            <TableBody>
              {providers.map((provider) => {
                const invitation = invitations.find(
                  (item): item is ClaimInvitation => item.kind === 'providerClaim' && item.providerId === provider._id,
                );
                const affordance = providerClaimAffordance(provider.status, provider.claimState);
                return (
                  <TableRow key={provider._id}>
                    <TableRowHeaderCell>
                      <div className="flex flex-col gap-0.5">
                        <span>{provider.name}</span>
                        <span className="text-xs font-normal text-ink-3">
                          {storedOptionalText(provider.legalName, t('providers.notSet'))}
                        </span>
                      </div>
                    </TableRowHeaderCell>
                    <TableCell>
                      {storedOptionalText(
                        provider.contactName,
                        storedOptionalText(provider.contactEmail, t('providers.notSet')),
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusChip kind="archival" status={provider.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <StatusChip kind="providerClaim" status={provider.claimState} />
                        {invitation === undefined ? null : (
                          <span className="text-xs text-ink-3">
                            {t('providers.invitedEmail', { email: invitation.email })}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    {canManage ? (
                      <TableCell align="end">
                        <div className="flex flex-wrap justify-end gap-1">
                          {provider.status === 'active' ? (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => onEdit(provider)}>
                                {t('providers.edit')}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => onArchive(provider)}>
                                {t('providers.archive')}
                              </Button>
                            </>
                          ) : null}
                          {affordance === 'invite' && invitation === undefined && invitationsExhausted ? (
                            <Button size="sm" variant="ghost" onClick={() => onInvite(provider)}>
                              {t('providers.invite')}
                            </Button>
                          ) : null}
                          {invitation !== undefined ? (
                            <Button size="sm" variant="ghost" onClick={() => onRevokeInvitation(invitation)}>
                              {t('providers.revokeInvitation')}
                            </Button>
                          ) : null}
                          {affordance === 'revokeClaim' ? (
                            <Button size="sm" variant="danger" onClick={() => onRevokeClaim(provider)}>
                              {t('providers.revokeClaim')}
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          )}
        </Table>
      </PanelBodyFlush>
      {/* A coordinator may know the published claim state and invited email, but cannot name the linked
          Provider Organization: organizations.getOrganization requires membership by design (I9). */}
    </Panel>
  );
}

function ProviderEditor({
  provider,
  organizationId,
  onClose,
  onCreate,
  onUpdate,
}: {
  provider?: Provider | undefined;
  organizationId: FunctionArgs<typeof api.providers.mutations.createProvider>['organizationId'];
  onClose: () => void;
  onCreate: ReturnType<typeof useMutation<typeof api.providers.mutations.createProvider>>;
  onUpdate: ReturnType<typeof useMutation<typeof api.providers.mutations.updateProvider>>;
}) {
  const t = useTranslations();
  const [name, setName] = useState(provider?.name ?? '');
  const [legalName, setLegalName] = useState(provider?.legalName ?? '');
  const [taxId, setTaxId] = useState(provider?.taxId ?? '');
  const [contactName, setContactName] = useState(provider?.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(provider?.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(provider?.contactPhone ?? '');
  const [notes, setNotes] = useState(provider?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const legalNameValue = optionalTextMutationValue(legalName, provider?.legalName);
    const taxIdValue = optionalTextMutationValue(taxId, provider?.taxId);
    const contactNameValue = optionalTextMutationValue(contactName, provider?.contactName);
    const contactEmailValue = optionalTextMutationValue(contactEmail, provider?.contactEmail);
    const contactPhoneValue = optionalTextMutationValue(contactPhone, provider?.contactPhone);
    const notesValue = optionalTextMutationValue(notes, provider?.notes);
    const values = {
      name,
      ...(legalNameValue === undefined ? {} : { legalName: legalNameValue }),
      ...(taxIdValue === undefined ? {} : { taxId: taxIdValue }),
      ...(contactNameValue === undefined ? {} : { contactName: contactNameValue }),
      ...(contactEmailValue === undefined ? {} : { contactEmail: contactEmailValue }),
      ...(contactPhoneValue === undefined ? {} : { contactPhone: contactPhoneValue }),
      ...(notesValue === undefined ? {} : { notes: notesValue }),
    };
    try {
      if (provider === undefined) await onCreate({ organizationId, ...values });
      else await onUpdate({ providerId: provider._id, ...values });
      onClose();
    } catch (caught) {
      setError(t(errorMessageKey(presentConvexError(caught))));
    }
  }

  return (
    <EditorPanel title={t(provider === undefined ? 'providers.createTitle' : 'providers.editTitle')}>
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label={t('providers.name')} value={name} setValue={setName} required />
          <Input label={t('providers.legalName')} value={legalName} setValue={setLegalName} />
          <Input label={t('providers.taxId')} value={taxId} setValue={setTaxId} />
          <Input label={t('providers.contactName')} value={contactName} setValue={setContactName} />
          <Input label={t('providers.contactEmail')} value={contactEmail} setValue={setContactEmail} type="email" />
          <Input label={t('providers.contactPhone')} value={contactPhone} setValue={setContactPhone} type="tel" />
          <label className={`${labelClass} sm:col-span-2`}>
            {t('providers.notes')}
            <textarea
              className={textAreaClass}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
        </div>
        {error === null ? null : <Alert>{error}</Alert>}
        <EditorActions saveLabel={t('providers.save')} onClose={onClose} />
      </form>
    </EditorPanel>
  );
}

function ProviderInvite({
  provider,
  onClose,
  onInvite,
}: {
  provider: Provider;
  onClose: () => void;
  onInvite: ReturnType<typeof useMutation<typeof api.providers.mutations.inviteProviderOrganization>>;
}) {
  const t = useTranslations();
  const [email, setEmail] = useState(provider.contactEmail ?? '');
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      await onInvite({ providerId: provider._id, email });
      onClose();
    } catch (caught) {
      setError(t(errorMessageKey(presentConvexError(caught))));
    }
  }
  return (
    <EditorPanel title={t('providers.inviteTitle')} description={t('providers.inviteHint')}>
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <Input label={t('providers.inviteEmail')} value={email} setValue={setEmail} type="email" required />
        {error === null ? null : <Alert>{error}</Alert>}
        <EditorActions saveLabel={t('providers.invite')} onClose={onClose} />
      </form>
    </EditorPanel>
  );
}

function ConfirmationPanel({
  mode,
  onCancel,
  onConfirm,
}: {
  mode: 'archive' | 'revokeClaim';
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations();
  const archive = mode === 'archive';
  return (
    <EditorPanel
      title={t(archive ? 'providers.archiveTitle' : 'providers.revokeClaimTitle')}
      description={t(archive ? 'providers.archiveWarning' : 'providers.revokeClaimWarning')}
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" onClick={onConfirm}>
          {t(archive ? 'providers.archiveConfirm' : 'providers.revokeClaim')}
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
  children: React.ReactNode;
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
  required?: boolean | undefined;
  type?: 'text' | 'email' | 'tel' | undefined;
}) {
  return (
    <label className={labelClass}>
      {label}
      <input
        className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm normal-case tracking-normal"
        type={type}
        value={value}
        required={required}
        onChange={(event) => setValue(event.target.value)}
      />
    </label>
  );
}

function EditorActions({ saveLabel, onClose }: { saveLabel: string; onClose: () => void }) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="primary">
        {saveLabel}
      </Button>
      <Button type="button" onClick={onClose}>
        {t('common.cancel')}
      </Button>
    </div>
  );
}

function FilterLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2">
      {label}
      {children}
    </label>
  );
}

function Alert({ children }: { children: string }) {
  return (
    <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">
      {children}
    </p>
  );
}

const labelClass =
  'flex flex-col gap-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-ink-2';
const textAreaClass =
  'min-h-24 rounded-input border border-line bg-ground-2 px-3 py-2 text-sm normal-case tracking-normal';
