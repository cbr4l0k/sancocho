'use client';

import { useTranslations } from 'next-intl';

import { statusToken, type StatusSelection, type StatusShape, type StatusTone } from '@/lib/status';
import { cn } from '@/lib/utils';

/**
 * Each tone binds `--chip` once; every colour below is derived from it with
 * `color-mix`. That is why a chip needs no per-tone background or border class,
 * and why adding a tone is a one-line change.
 */
const toneVariable: Record<StatusTone, string> = {
  mute: '[--chip:var(--sc-tone-mute)]',
  hold: '[--chip:var(--sc-tone-hold)]',
  go: '[--chip:var(--sc-tone-go)]',
  live: '[--chip:var(--sc-tone-live)]',
  done: '[--chip:var(--sc-tone-done)]',
  stop: '[--chip:var(--sc-tone-stop)]',
  shelf: '[--chip:var(--sc-tone-shelf)]',
};

/**
 * The shape is the colour-blind-safe channel, so it is drawn rather than
 * tinted: an operator can tell `planned` from `confirmed` in greyscale.
 */
const shapeMarker: Record<StatusShape, string> = {
  ring: 'size-2 rounded-full border-[1.5px] border-[var(--chip)]',
  bar: 'h-2.5 w-[3px] rounded-[1px] bg-[var(--chip)]',
  diamond: 'size-2 rotate-45 rounded-[1px] bg-[var(--chip)]',
  dot: 'size-2 rounded-full bg-[var(--chip)]',
  pulse: cn(
    'size-2 rounded-full bg-[var(--chip)]',
    'after:absolute after:inset-0 after:rounded-full after:bg-[var(--chip)]',
    'after:animate-[sc-breathe_2.6s_ease-in-out_infinite]',
  ),
  square: 'size-2 rounded-[2px] bg-[var(--chip)]',
  cross: cn(
    'size-2.5',
    'before:absolute before:inset-x-0 before:top-1/2 before:h-[1.5px] before:-translate-y-1/2 before:rotate-45 before:rounded-full before:bg-[var(--chip)]',
    'after:absolute after:inset-x-0 after:top-1/2 after:h-[1.5px] after:-translate-y-1/2 after:-rotate-45 after:rounded-full after:bg-[var(--chip)]',
  ),
};

export type StatusChipProps = StatusSelection & {
  /**
   * `quiet` is the default and belongs in tables, where dozens of chips must not
   * turn a page into confetti. `loud` is for the single chip that describes the
   * record you are currently looking at.
   */
  emphasis?: 'quiet' | 'loud';
  className?: string | undefined;
};

export function StatusChip({ emphasis = 'quiet', className, ...selection }: StatusChipProps) {
  const t = useTranslations();
  const token = statusToken(selection);

  return (
    <span
      data-slot="status-chip"
      data-status={selection.status}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-chip border px-1.5 py-0.5 text-micro uppercase leading-4',
        'text-[var(--chip)]',
        toneVariable[token.tone],
        emphasis === 'loud'
          ? 'border-[color-mix(in_oklab,var(--chip)_55%,transparent)] bg-[color-mix(in_oklab,var(--chip)_14%,transparent)]'
          : 'border-[color-mix(in_oklab,var(--chip)_32%,transparent)] bg-[color-mix(in_oklab,var(--chip)_7%,transparent)]',
        className,
      )}
    >
      <span aria-hidden="true" className={cn('relative block shrink-0', shapeMarker[token.shape])} />
      {t(token.labelKey)}
    </span>
  );
}

/** The marker on its own, for legends and dense list gutters. */
export function StatusMarker({ className, ...selection }: StatusSelection & { className?: string | undefined }) {
  const token = statusToken(selection);

  return (
    <span
      aria-hidden="true"
      data-slot="status-marker"
      className={cn('relative block shrink-0', toneVariable[token.tone], shapeMarker[token.shape], className)}
    />
  );
}
