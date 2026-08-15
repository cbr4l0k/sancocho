'use client';

import { Authenticated, AuthLoading, Unauthenticated, useQuery, type PaginationStatus } from 'convex/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { api } from '@sancocho/convex/api';

import { LocaleSwitcher } from '@/app/[locale]/locale-switcher';
import { Bento, BentoItem } from '@/components/ui/bento';
import { Button } from '@/components/ui/button';
import { EmptyState, UnavailableState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldDescription, FieldLabel, FieldReadout } from '@/components/ui/field';
import {
  Panel,
  PanelBody,
  PanelBodyFlush,
  PanelDescription,
  PanelEyebrow,
  PanelHeader,
  PanelMetric,
  PanelTitle,
} from '@/components/ui/panel';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { StatusChip } from '@/components/ui/status-chip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableLoadMore,
  TableRow,
  TableSkeletonRows,
} from '@/components/ui/table';
import {
  archivalStatuses,
  projectStatuses,
  recipeStatuses,
  recipeVersionStatuses,
  serviceStatuses,
  serviceStatusTokens,
  type StatusShape,
  type StatusTone,
} from '@/lib/status';

/**
 * The design system's own proof.
 *
 * Not a product screen: every panel here exercises a primitive against real
 * behaviour — the live Convex connection, the working locale control, a filter
 * that actually filters, a "load more" that actually loads. Nothing is a
 * mock-up, because a demo made of fake rows proves nothing about the system.
 */
export default function HomePage() {
  const t = useTranslations();

  return (
    <main className="mx-auto flex w-full max-w-[88rem] flex-col gap-5 px-4 py-8 sm:px-6 lg:py-12">
      <header className="flex flex-col gap-1.5">
        <p className="text-micro uppercase text-accent">{t('home.eyebrow')}</p>
        <h1 className="text-xl font-extrabold text-ink">{t('home.title')}</h1>
        <p className="max-w-prose text-sm text-ink-2">{t('home.lead')}</p>
      </header>

      <Bento>
        <BentoItem span={8}>
          <ConnectionPanel />
        </BentoItem>
        <BentoItem span={4}>
          <PreferencesPanel />
        </BentoItem>
        <BentoItem span={7}>
          <StatusReferencePanel />
        </BentoItem>
        <BentoItem span={5}>
          <VocabularyPanel />
        </BentoItem>
        <BentoItem span={4}>
          <LoadingPatternPanel />
        </BentoItem>
        <BentoItem span={4}>
          <EmptyPatternPanel />
        </BentoItem>
        <BentoItem span={4}>
          <UnavailablePatternPanel />
        </BentoItem>
      </Bento>
    </main>
  );
}

type ConnectionState = 'connecting' | 'signedOut' | 'profilePending' | 'connected';

/**
 * Both catalogue paths are written out, so `t()` always receives a literal and
 * the short metric word can never drift from the sentence beneath it.
 */
const connectionCopy = {
  connecting: { state: 'home.connection.states.connecting', detail: 'auth.connecting' },
  signedOut: { state: 'home.connection.states.signedOut', detail: 'auth.signedOut' },
  profilePending: { state: 'home.connection.states.profilePending', detail: 'auth.profilePending' },
  connected: { state: 'home.connection.states.connected', detail: 'auth.connected' },
} as const satisfies Record<ConnectionState, { state: string; detail: string }>;

/** The focal panel: one large number-sized fact, and the controls that act on it. */
function ConnectionPanel() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();

  return (
    <Panel emphasis="focal" className="h-full">
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelEyebrow>{t('home.connection.eyebrow')}</PanelEyebrow>
          <PanelTitle>{t('home.connection.title')}</PanelTitle>
        </div>
        <Button variant="primary" size="sm" onClick={() => router.refresh()}>
          {t('common.retry')}
        </Button>
      </PanelHeader>
      <PanelBody className="gap-5">
        <AuthLoading>
          <ConnectionReadout state="connecting" />
        </AuthLoading>
        <Unauthenticated>
          <ConnectionReadout state="signedOut" />
        </Unauthenticated>
        <Authenticated>
          <AuthenticatedReadout />
        </Authenticated>
        <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <FieldReadout label={t('home.connection.frontendLabel')} value={t('home.connection.frontendValue')} />
          <FieldReadout label={t('home.connection.localeLabel')} value={locale} mono />
        </div>
      </PanelBody>
    </Panel>
  );
}

function ConnectionReadout({ state }: { state: ConnectionState }) {
  const t = useTranslations();
  const copy = connectionCopy[state];

  return (
    <div className="flex flex-col gap-2">
      <PanelMetric label={t('home.connection.stateLabel')} value={t(copy.state)} />
      <p className="max-w-prose text-sm text-ink-2">{t(copy.detail)}</p>
    </div>
  );
}

function AuthenticatedReadout() {
  const currentUser = useQuery(api.auth.queries.getCurrentUser);

  if (currentUser === undefined) {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-3.5 w-64" />
      </div>
    );
  }

  return <ConnectionReadout state={currentUser === null ? 'profilePending' : 'connected'} />;
}

function PreferencesPanel() {
  const t = useTranslations();

  return (
    <Panel className="h-full">
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelEyebrow>{t('home.preferences.eyebrow')}</PanelEyebrow>
          <PanelTitle>{t('home.preferences.title')}</PanelTitle>
        </div>
      </PanelHeader>
      <PanelBody>
        <LocaleSwitcher />
      </PanelBody>
    </Panel>
  );
}

const phaseLabelKey = {
  ring: 'home.phases.ring',
  bar: 'home.phases.bar',
  diamond: 'home.phases.diamond',
  dot: 'home.phases.dot',
  pulse: 'home.phases.pulse',
  square: 'home.phases.square',
  cross: 'home.phases.cross',
} as const satisfies Record<StatusShape, string>;

const dispositionLabelKey = {
  mute: 'home.dispositions.mute',
  hold: 'home.dispositions.hold',
  go: 'home.dispositions.go',
  live: 'home.dispositions.live',
  done: 'home.dispositions.done',
  stop: 'home.dispositions.stop',
  shelf: 'home.dispositions.shelf',
} as const satisfies Record<StatusTone, string>;

const referencePageSize = 3;

/**
 * The table primitive against the pagination contract it was built for: rows
 * arrive a page at a time, the footer reports only what is in hand, and the
 * filter narrows the loaded rows rather than pretending to query the server.
 */
function StatusReferencePanel() {
  const t = useTranslations();
  const [loadedCount, setLoadedCount] = useState(referencePageSize);
  const [filter, setFilter] = useState('');

  const loaded = serviceStatuses.slice(0, loadedCount);
  const needle = filter.trim().toLowerCase();
  const rows = needle === '' ? loaded : loaded.filter((status) => status.includes(needle));
  const paginationStatus: PaginationStatus = loadedCount >= serviceStatuses.length ? 'Exhausted' : 'CanLoadMore';

  return (
    <Panel className="h-full">
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelEyebrow>{t('home.reference.eyebrow')}</PanelEyebrow>
          <PanelTitle>{t('home.reference.title')}</PanelTitle>
          <PanelDescription>{t('home.reference.description')}</PanelDescription>
        </div>
        <Field className="w-full sm:w-44">
          <FieldLabel>{t('home.reference.filterLabel')}</FieldLabel>
          <FieldControl
            value={filter}
            placeholder={t('home.reference.filterPlaceholder')}
            onValueChange={(value) => setFilter(value)}
          />
          <FieldDescription>{t('home.reference.filterDescription')}</FieldDescription>
        </Field>
      </PanelHeader>
      <PanelBodyFlush>
        {rows.length === 0 ? (
          <EmptyState
            tone="filtered"
            title={t('empty.noMatches')}
            description={t('empty.noMatchesBody')}
            action={
              <Button variant="ghost" size="sm" onClick={() => setFilter('')}>
                {t('common.clear')}
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('home.reference.columns.key')}</TableHeaderCell>
                <TableHeaderCell>{t('home.reference.columns.label')}</TableHeaderCell>
                <TableHeaderCell>{t('home.reference.columns.phase')}</TableHeaderCell>
                <TableHeaderCell align="end">{t('home.reference.columns.disposition')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((status) => {
                const token = serviceStatusTokens[status];
                return (
                  <TableRow key={status}>
                    <TableCell mono>{status}</TableCell>
                    <TableCell>
                      <StatusChip kind="service" status={status} />
                    </TableCell>
                    <TableCell>{t(phaseLabelKey[token.shape])}</TableCell>
                    <TableCell align="end">{t(dispositionLabelKey[token.tone])}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <TableLoadMore
          status={paginationStatus}
          loadedCount={loaded.length}
          pageSize={referencePageSize}
          onLoadMore={(pageSize) => setLoadedCount((current) => current + pageSize)}
        />
      </PanelBodyFlush>
    </Panel>
  );
}

function VocabularyPanel() {
  const t = useTranslations();

  return (
    <Panel className="h-full">
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelEyebrow>{t('home.vocabulary.eyebrow')}</PanelEyebrow>
          <PanelTitle>{t('home.vocabulary.title')}</PanelTitle>
          <PanelDescription>{t('home.vocabulary.description')}</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="gap-3.5">
        <ChipRow label={t('home.vocabulary.groups.projects')}>
          {projectStatuses.map((status) => (
            <StatusChip key={status} kind="project" status={status} />
          ))}
        </ChipRow>
        <ChipRow label={t('home.vocabulary.groups.recipes')}>
          {recipeStatuses.map((status) => (
            <StatusChip key={status} kind="recipe" status={status} />
          ))}
        </ChipRow>
        <ChipRow label={t('home.vocabulary.groups.recipeVersions')}>
          {recipeVersionStatuses.map((status) => (
            <StatusChip key={status} kind="recipeVersion" status={status} />
          ))}
        </ChipRow>
        <ChipRow label={t('home.vocabulary.groups.services')}>
          {serviceStatuses.map((status) => (
            <StatusChip key={status} kind="service" status={status} emphasis="loud" />
          ))}
        </ChipRow>
        <ChipRow label={t('home.vocabulary.groups.archival')}>
          {archivalStatuses.map((status) => (
            <StatusChip key={status} kind="archival" status={status} />
          ))}
        </ChipRow>
      </PanelBody>
    </Panel>
  );
}

function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-micro uppercase text-ink-3">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function LoadingPatternPanel() {
  const t = useTranslations();

  return (
    <Panel className="h-full">
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelEyebrow>{t('home.patterns.eyebrow')}</PanelEyebrow>
          <PanelTitle>{t('home.patterns.loading')}</PanelTitle>
        </div>
      </PanelHeader>
      <PanelBody className="gap-4">
        <SkeletonText lines={2} />
        <Table>
          <TableSkeletonRows rows={3} columns={3} />
        </Table>
      </PanelBody>
    </Panel>
  );
}

function EmptyPatternPanel() {
  const t = useTranslations();

  return (
    <Panel className="h-full">
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelEyebrow>{t('home.patterns.eyebrow')}</PanelEyebrow>
          <PanelTitle>{t('home.patterns.empty')}</PanelTitle>
        </div>
      </PanelHeader>
      <PanelBody className="justify-center">
        <EmptyState title={t('empty.noRecords')} description={t('empty.noRecordsBody')} />
      </PanelBody>
    </Panel>
  );
}

function UnavailablePatternPanel() {
  const t = useTranslations();

  return (
    <Panel className="h-full">
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelEyebrow>{t('home.patterns.eyebrow')}</PanelEyebrow>
          <PanelTitle>{t('home.patterns.unavailable')}</PanelTitle>
        </div>
      </PanelHeader>
      <PanelBody className="justify-center">
        <UnavailableState />
      </PanelBody>
    </Panel>
  );
}
