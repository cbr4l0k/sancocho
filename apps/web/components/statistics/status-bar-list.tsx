'use client';

import { useTranslations } from 'next-intl';

import { StatusMarker, toneVariable } from '@/components/ui/status-chip';
import { formatTruncatableValue, type TruncatableCount } from '@/lib/statistics-truncation';
import type { StatusSelection } from '@/lib/status';
import { statusToken } from '@/lib/status';
import { useCanonicalLocale } from '@/i18n/use-canonical-locale';
import { cn } from '@/lib/utils';

/**
 * A status-count breakdown, rendered as proportional bars coloured by each
 * status's OWN tone — never a generic chart palette.
 *
 * This is a deliberate departure from the recharts-based breakdown charts
 * elsewhere on this screen: `docs/web-design.md` encodes status by **shape
 * first, colour second** so the system stays colour-blind-safe, and a status
 * tone is reserved for status itself ("the status tones are not [a data-viz
 * colour scale] and must not be borrowed as one" — §13). A generic bar-chart
 * library can colour a bar, but it cannot draw the ring/bar/diamond/pulse/
 * square/cross shape vocabulary next to it, so hand-rolling this row list
 * (reusing `StatusMarker`, exactly like a table's status column) is what
 * keeps the shape channel intact for the one chart on this screen that is
 * actually ABOUT status.
 */
export type StatusBarRow = {
  key: string;
  selection: StatusSelection;
  label: string;
  count: TruncatableCount;
};

export function StatusBarList({ rows, max, className }: { rows: readonly StatusBarRow[]; max: number; className?: string | undefined }) {
  const locale = useCanonicalLocale();
  const t = useTranslations();

  return (
    <ul className={cn('flex flex-col gap-2.5', className)}>
      {rows.map((row) => {
        const token = statusToken(row.selection);
        const widthPercent = row.count.value > 0 ? Math.max(3, (row.count.value / max) * 100) : 0;
        return (
          <li key={row.key} className="flex items-center gap-3">
            <span className="flex w-32 shrink-0 items-center gap-1.5 text-xs text-ink-2">
              <StatusMarker {...row.selection} />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
            </span>
            <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-ground-3">
              <span
                aria-hidden="true"
                className={cn('absolute inset-y-0 left-0 rounded-full bg-[var(--chip)] transition-[width] duration-150', toneVariable[token.tone])}
                style={{ width: `${widthPercent}%` }}
              />
            </span>
            <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-ink">
              {formatTruncatableValue(locale, row.count)}
            </span>
          </li>
        );
      })}
      {rows.some((row) => row.count.isTruncated) ? (
        <li className="pt-1 text-xs text-ink-3">{t('statistics.truncatedHintPerStatus', { limit: 500 })}</li>
      ) : null}
    </ul>
  );
}
