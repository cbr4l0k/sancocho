'use client';

import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';

import { api } from '@priamo/convex/api';

import { RateGridEditor } from '@/components/rateCards/rate-grid-editor';
import { Button } from '@/components/ui/button';
import { Field, FieldControl, FieldLabel } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { StatusChip } from '@/components/ui/status-chip';
import { TableLoadMore } from '@/components/ui/table';
import { formatDateTime } from '@/i18n/formats';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';
import { currencies, rateVersionAffordances, type Currency } from '@/lib/rate-grid';

type RateCardId = FunctionArgs<typeof api.rateCards.queries.getRateCardDetail>['rateCardId'];
type RateCardDetail = FunctionReturnType<typeof api.rateCards.queries.getRateCardDetail>;
type RateCard = RateCardDetail['rateCard'];
type RateCardVersion = FunctionReturnType<typeof api.rateCards.queries.listRateCardVersions>['page'][number];
type Action = () => Promise<unknown>;

export function RateCardDetailSurface({ rateCardId }: { rateCardId: RateCardId }) {
  const t = useTranslations();
  const detail = useQuery(api.rateCards.queries.getRateCardDetail, { rateCardId });
  const versions = usePaginatedQuery(
    api.rateCards.queries.listRateCardVersions,
    { rateCardId },
    { initialNumItems: 25 },
  );
  const provider = useQuery(
    api.providers.queries.getProvider,
    detail === undefined ? 'skip' : { providerId: detail.rateCard.providerId },
  );
  const update = useMutation(api.rateCards.mutations.updateRateCardMetadata);
  const archive = useMutation(api.rateCards.mutations.archiveRateCard);
  const createDraft = useMutation(api.rateCards.mutations.createInitialDraftVersion);
  const cloneDraft = useMutation(api.rateCards.mutations.clonePublishedVersionToDraft);
  const publish = useMutation(api.rateCards.mutations.publishRateCardVersion);
  const retire = useMutation(api.rateCards.mutations.retireRateCardVersion);
  const [editing, setEditing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [confirmingRetire, setConfirmingRetire] = useState<RateCardVersion | null>(null);
  const [currency, setCurrency] = useState<Currency>('COP');
  const [message, setMessage] = useState<string | null>(null);

  if (detail === undefined) return null;

  const { rateCard: card, draftVersion: draft, publishedVersion: published } = detail;
  const sortedVersions = [...versions.results].sort((left, right) => right.versionNumber - left.versionNumber);

  async function action(run: Action): Promise<void> {
    try {
      setMessage(null);
      await run();
    } catch (error) {
      setMessage(t(errorMessageKey(presentConvexError(error))));
    }
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await action(async () => {
      await update({
        rateCardId,
        name: String(new FormData(event.currentTarget).get('name') ?? ''),
      });
      setEditing(false);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        badge={<StatusChip emphasis="loud" kind="archival" status={card.status} />}
        actions={card.status === 'active' && !editing ? (
          <>
            <Button onClick={() => setEditing(true)}>{t('rateCards.edit')}</Button>
            <Button variant="danger" onClick={() => setConfirmingArchive(true)}>{t('rateCards.archive')}</Button>
          </>
        ) : undefined}
      />
      {message === null ? null : <Alert>{message}</Alert>}
      {editing ? (
        <Panel emphasis="focal"><PanelBody>
          <form className="flex flex-col gap-4" onSubmit={saveMetadata}>
            <Field><FieldLabel>{t('rateCards.name')}</FieldLabel><FieldControl name="name" defaultValue={card.name} required /></Field>
            <div className="flex gap-2">
              <Button type="submit" variant="primary">{t('rateCards.save')}</Button>
              <Button type="button" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        </PanelBody></Panel>
      ) : (
        <Panel><PanelBody className="gap-2">
          <h1 className="text-xl font-bold text-ink">{card.name}</h1>
          <p className="text-sm text-ink-2">{t('rateCards.provider')}: {provider?.name ?? t('common.notAvailable')}</p>
          <p className="text-sm text-ink-2">
            {t('rateCards.currentPublished')}:{' '}
            {card.currentPublishedVersionId === undefined
              ? t('rateCards.nonePublished')
              : published === null
                ? t('common.notAvailable')
                : `v${published.versionNumber}`}
          </p>
        </PanelBody></Panel>
      )}
      {card.status === 'archived' ? <Notice>{t('rateCards.archivedNotice')}</Notice> : null}
      {confirmingArchive ? (
        <Panel emphasis="focal"><PanelBody>
          <PanelTitle>{t('rateCards.archiveTitle')}</PanelTitle>
          <p className="text-sm text-ink-2">{t('rateCards.archiveWarning')}</p>
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => void action(async () => {
              await archive({ rateCardId });
              setConfirmingArchive(false);
            })}>{t('rateCards.archiveConfirm')}</Button>
            <Button onClick={() => setConfirmingArchive(false)}>{t('common.cancel')}</Button>
          </div>
        </PanelBody></Panel>
      ) : null}
      <LifecycleActions
        cardStatus={card.status}
        rateCardId={rateCardId}
        draft={draft}
        published={published}
        currency={currency}
        setCurrency={setCurrency}
        onAction={action}
        createDraft={createDraft}
        cloneDraft={cloneDraft}
        onRequestRetire={setConfirmingRetire}
      />
      {confirmingRetire === null ? null : (
        <Panel emphasis="focal"><PanelBody>
          <PanelTitle>{t('rateCards.retireTitle', { version: confirmingRetire.versionNumber })}</PanelTitle>
          <p className="text-sm text-ink-2">{t('rateCards.retireWarning')}</p>
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => void action(async () => {
              await retire({ rateCardVersionId: confirmingRetire._id });
              setConfirmingRetire(null);
            })}>{t('rateCards.retireConfirm')}</Button>
            <Button onClick={() => setConfirmingRetire(null)}>{t('common.cancel')}</Button>
          </div>
        </PanelBody></Panel>
      )}
      {draft === null || rateVersionAffordances(card.status, draft.status).includes('edit') === false
        ? null
        : <RateGridEditor
            rateCardVersionId={draft._id}
            providerStatus={provider?.status}
            onPublish={() => action(() => publish({ rateCardVersionId: draft._id }))}
          />}
      <Panel>
        <PanelHeader><PanelTitle>{t('rateCards.versionsTitle')}</PanelTitle></PanelHeader>
        <PanelBody>
          <p className="text-sm text-ink-2">{t('rateCards.immutableNotice')}</p>
          {versions.status === 'Exhausted' && versions.results.length === 0 ? (
            <p className="text-sm text-ink-3">{t('rateCards.noVersions')}</p>
          ) : sortedVersions.map((version) => (
            <VersionRow key={version._id} version={version} current={version._id === card.currentPublishedVersionId} />
          ))}
        </PanelBody>
      </Panel>
      <TableLoadMore status={versions.status} loadedCount={versions.results.length} onLoadMore={versions.loadMore} />
    </div>
  );
}

function LifecycleActions({
  cardStatus,
  rateCardId,
  draft,
  published,
  currency,
  setCurrency,
  onAction,
  createDraft,
  cloneDraft,
  onRequestRetire,
}: {
  cardStatus: RateCard['status'];
  rateCardId: RateCardId;
  draft: RateCardVersion | null;
  published: RateCardVersion | null;
  currency: Currency;
  setCurrency: (currency: Currency) => void;
  onAction: (run: Action) => Promise<void>;
  createDraft: ReturnType<typeof useMutation<typeof api.rateCards.mutations.createInitialDraftVersion>>;
  cloneDraft: ReturnType<typeof useMutation<typeof api.rateCards.mutations.clonePublishedVersionToDraft>>;
  onRequestRetire: (version: RateCardVersion) => void;
}) {
  const t = useTranslations();
  if (cardStatus === 'archived') return null;
  if (draft !== null) {
    return published === null ? null : <div className="flex flex-wrap gap-2">
        <Button variant="danger" onClick={() => onRequestRetire(published)}>
          {t('rateCards.retirePublished', { version: published.versionNumber })}
        </Button>
    </div>;
  }
  if (published !== null) {
    return <div className="flex flex-wrap gap-2">
      <Button variant="primary" onClick={() => void onAction(() => cloneDraft({ rateCardId }))}>
        {t('rateCards.clonePublished', { version: published.versionNumber })}
      </Button>
      <Button variant="danger" onClick={() => onRequestRetire(published)}>
        {t('rateCards.retirePublished', { version: published.versionNumber })}
      </Button>
    </div>;
  }
  return <div className="flex flex-wrap items-end gap-2">
    <label className="flex flex-col gap-1 text-xs text-ink-2">
      {t('rateCards.currency')}
      <select className="h-[38px] rounded-input border border-line bg-ground-2 px-3 text-sm text-ink" value={currency} onChange={(event) => {
        const next = currencies.find((candidate) => candidate === event.target.value);
        if (next !== undefined) setCurrency(next);
      }}>
        {currencies.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
    <Button variant="primary" onClick={() => void onAction(() => createDraft({ rateCardId, currency }))}>
      {t('rateCards.createDraft')}
    </Button>
  </div>;
}

function VersionRow({ version, current }: { version: RateCardVersion; current: boolean }) {
  const t = useTranslations();
  const locale = useCanonicalLocale();
  return <div className="rounded-input border border-line bg-ground-2/60 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="font-mono text-ink">v{version.versionNumber}</strong>
      <StatusChip kind="rateCardVersion" status={version.status} />
      <span className="font-mono text-xs text-ink-3">{version.currency}</span>
      {current ? <span className="rounded-pill border border-line px-2 py-1 text-micro text-ink">{t('rateCards.current')}</span> : null}
      {version.status === 'draft' ? null : <span className="text-micro text-ink-3">{t('rateCards.locked')}</span>}
    </div>
    <p className="mt-2 text-xs text-ink-3">
      {formatDateTime(locale, version.publishedAt ?? version._creationTime)}
    </p>
  </div>;
}

function Alert({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-input border border-tone-stop/40 px-4 py-3 text-sm text-tone-stop">{children}</p>;
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-input border border-line bg-ground-2 px-4 py-3 text-sm text-ink-2">{children}</p>;
}
