'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import type { ChatProposal, ChatProposalStatus } from '@/lib/chat-backend';
import { cn } from '@/lib/utils';
import type { FieldDataType } from '@sancocho/convex/validators';

/**
 * A neutral, read-only preview of a proposal payload — proof that the stub
 * `ChatBackend` (#32) carries a realistic, typed payload for each proposal
 * kind. This is deliberately **not** the proposal card #33 will build: no
 * expandable detail view and no Accept/Discard. Building that card, and the
 * canonical `packages/shared` types it reads, is #33's scope.
 */

const statusTone: Record<ChatProposalStatus, string> = {
  valid: 'text-tone-go',
  needsResolution: 'text-tone-hold',
  invalid: 'text-tone-stop',
};

/** Mirrors `StatusLabelKey` in `lib/status.ts`: a literal path, never built by concatenation. */
type FieldDataTypeLabelKey = `fields.dataTypes.${FieldDataType}`;

export function ChatProposalPreview({ proposal }: { proposal: ChatProposal }) {
  const t = useTranslations();
  const statusLabelKey =
    proposal.status === 'valid'
      ? 'chat.proposal.statusValid'
      : proposal.status === 'needsResolution'
        ? 'chat.proposal.statusNeedsResolution'
        : 'chat.proposal.statusInvalid';

  return (
    <div
      data-slot="chat-proposal-preview"
      className="flex min-w-0 max-w-[32rem] flex-col gap-3 rounded-input border border-line/80 bg-ground-2 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-ink">
          {t(proposal.kind === 'recipe' ? 'chat.proposal.recipeTitle' : 'chat.proposal.serviceTitle')}
        </p>
        <span className={cn('text-micro font-semibold uppercase tracking-[0.09em]', statusTone[proposal.status])}>
          {t(statusLabelKey)}
        </span>
      </div>

      {proposal.kind === 'recipe' ? <RecipeProposalBody proposal={proposal} /> : <ServiceProposalBody proposal={proposal} />}

      {proposal.status === 'needsResolution' && 'gaps' in proposal && proposal.gaps !== undefined ? (
        <IssueList headingKey="chat.proposal.gapsHeading" items={proposal.gaps} tone="text-tone-hold" />
      ) : null}

      {proposal.status === 'invalid' && proposal.issues !== undefined ? (
        <IssueList headingKey="chat.proposal.issuesHeading" items={proposal.issues} tone="text-tone-stop" />
      ) : null}
    </div>
  );
}

function RecipeProposalBody({ proposal }: { proposal: Extract<ChatProposal, { kind: 'recipe' }> }) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-ink">{proposal.recipeName}</p>
      <p className="font-mono text-xs text-ink-3">
        {t('chat.proposal.recipeKeyLabel')}: {proposal.recipeKey}
      </p>
      <div className="flex flex-col gap-1.5">
        <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
          {t('chat.proposal.fieldsHeading')}
        </p>
        <ul className="flex flex-col gap-1">
          {proposal.fields.map((field, index) => {
            const dataTypeLabelKey: FieldDataTypeLabelKey = `fields.dataTypes.${field.dataType}`;
            return (
              <li
                key={`${field.key}-${index}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2"
              >
                <span className="text-ink">{field.label}</span>
                <span className="text-xs text-ink-3">{t(dataTypeLabelKey)}</span>
                {field.required ? <Badge tone="text-tone-hold">{t('chat.proposal.requiredBadge')}</Badge> : null}
                {field.isNewFieldDefinition ? <Badge tone="text-tone-live">{t('chat.proposal.newFieldBadge')}</Badge> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function ServiceProposalBody({ proposal }: { proposal: Extract<ChatProposal, { kind: 'service' }> }) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-ink">{proposal.recipeName}</p>
      <p className="text-xs text-ink-3">
        {t('chat.proposal.projectLabel')}: {proposal.projectName}
      </p>
      <p className="text-xs text-ink-3">
        {t('chat.proposal.recipeVersionLabel')}: {proposal.recipeVersionLabel}
      </p>
      <div className="flex flex-col gap-1.5">
        <p className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-3">
          {t('chat.proposal.valuesHeading')}
        </p>
        <ul className="flex flex-col gap-1">
          {proposal.values.map((value) => (
            <li key={value.key} className="flex flex-wrap items-baseline gap-x-2 text-sm text-ink-2">
              <span className="text-ink-3">{value.label}:</span>
              <span className="text-ink">{value.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className={cn('rounded-pill bg-ground-3 px-2 py-0.5 text-micro font-semibold uppercase tracking-[0.09em]', tone)}>
      {children}
    </span>
  );
}

function IssueList({
  headingKey,
  items,
  tone,
}: {
  headingKey: 'chat.proposal.gapsHeading' | 'chat.proposal.issuesHeading';
  items: readonly string[];
  tone: string;
}) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-1.5 border-t border-line/60 pt-2.5">
      <p className={cn('text-micro font-semibold uppercase tracking-[0.09em]', tone)}>{t(headingKey)}</p>
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li key={index} className="text-xs text-ink-2">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
