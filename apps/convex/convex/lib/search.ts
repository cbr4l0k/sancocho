import { invalidInput } from './errors';

/**
 * Search uses a stored normalized column rather than indexing `name` or `label`
 * directly. Convex tokenizes punctuation and case but does not fold diacritics,
 * so a default es-CO search for `medellin` would miss `Medellín`. Normalizing
 * both sides also combines a field's key and label, and keeps convex-test's
 * simplified whitespace tokenizer aligned with production tokenization.
 */

/** Bound raw input before normalization so query work and error behaviour stay predictable. */
export const maxSearchTermLength = 100;

/** Reject oversized raw input before normalization can turn it into query work. */
export function assertSearchTermLength(search: string | undefined): void {
  if (search !== undefined && search.length > maxSearchTermLength) {
    return invalidInput('searchTermTooLong', `Search term must not exceed ${maxSearchTermLength} characters`);
  }
}

/** Normalizes stored searchable text and query text into the same token stream. */
export function normalizeSearchText(...parts: (string | undefined)[]): string {
  return parts
    .join(' ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Convex accepts at most sixteen terms in one search expression. */
export function normalizeSearchTerm(term: string): string {
  return normalizeSearchText(term).split(' ').filter(Boolean).slice(0, 16).join(' ');
}
