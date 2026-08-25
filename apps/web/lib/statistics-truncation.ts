import type { CanonicalLocale } from '@/i18n/locales';
import { formatNumber } from '@/i18n/formats';

/**
 * Rendering the `isTruncated` signal honestly, in one place.
 *
 * `docs/statistics.md` is explicit that a truncated filtered/semantic read is
 * a server-capped FLOOR, not a total: "producing a wrong number that looks
 * exact is worse than showing nothing." `formatTruncatableValue` therefore
 * ALWAYS renders the "+" suffix when `isTruncated` is true and NEVER renders
 * it otherwise — nothing downstream may drop this flag on the floor. Two
 * message families exist (`truncatedHintPerStatus` /`truncatedHintSample`)
 * because the two truncation signals in this domain describe different
 * samples (per-status cap vs. one combined cap across every status) and must
 * never be captioned with a single ambiguous string — see
 * `docs/statistics.md:340-344`.
 */
export type TruncatableCount = { value: number; isTruncated: boolean };

export function formatTruncatableValue(locale: CanonicalLocale, count: TruncatableCount): string {
  const formatted = formatNumber(locale, count.value);
  return count.isTruncated ? `${formatted}+` : formatted;
}

/**
 * Whether a semantic metric (passenger totals, accessibility requirements,
 * occupancy) has anything to show at all.
 *
 * The backend cannot distinguish "no field in this organization is bound to
 * this semantic type" from "a field is bound, but no matching service has a
 * value recorded" — both produce `eventCount.value === 0` (or `sampleSize ===
 * 0` for occupancy), and there is no third query in the #34 contract that
 * would resolve the ambiguity without paginating the field catalogue
 * client-side (out of scope — see the issue's constraints). Both cases read
 * identically to an operator: there is no trustworthy number to show. Copy
 * for this state must therefore stay honestly non-committal ("no data
 * tracked") rather than claiming either "not configured" (which could be
 * wrong if a field IS bound but genuinely empty) or "zero" (which reads as an
 * exact, meaningful total it is not).
 */
export function hasSemanticData(eventCount: TruncatableCount): boolean {
  return eventCount.value > 0;
}

export function hasOccupancySample(sampleSize: number): boolean {
  return sampleSize > 0;
}
