import { expect, test } from 'bun:test';

import enUS from '@/i18n/messages/en-US';
import esCO from '@/i18n/messages/es-CO';

import {
  archivalStatusTokens,
  assignmentRevisionStatusTokens,
  eventStatusTokens,
  executionStatusTokens,
  projectStatusTokens,
  rateCardVersionStatusTokens,
  providerClaimStateTokens,
  serviceKindStatusTokens,
  serviceKindVersionStatusTokens,
  serviceStatusTokens,
  statusToken,
  type StatusToken,
} from './status';

/**
 * Every token table, by the name it is known by in the codebase.
 *
 * `satisfies Record<Status, StatusToken>` already makes a MISSING member a
 * compile error, and `CoversExactly` does the same for the ordered arrays. What
 * neither catches is a member pointing at the WRONG label: `labelKey` is typed
 * as a template-literal union over the whole status set, so `active` may legally
 * carry `completed`'s key. Mutation testing found exactly that — an `active`
 * Event rendering a `go`/`dot` chip labelled "Completed", with the full suite
 * green — so the correspondence is asserted here rather than assumed.
 */
const tables: Readonly<Record<string, Readonly<Record<string, StatusToken>>>> = {
  projectStatusTokens,
  eventStatusTokens,
  serviceKindStatusTokens,
  serviceKindVersionStatusTokens,
  rateCardVersionStatusTokens,
  serviceStatusTokens,
  archivalStatusTokens,
  providerClaimStateTokens,
  executionStatusTokens,
  assignmentRevisionStatusTokens,
};

function resolve(catalogue: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, segment) =>
        typeof node === 'object' && node !== null && segment in node
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      catalogue,
    );
}

test('every status token labels its own status, not another member of its set', () => {
  const mismatched: string[] = [];
  for (const [name, table] of Object.entries(tables)) {
    for (const [status, token] of Object.entries(table)) {
      if (token.labelKey.split('.').at(-1) !== status) mismatched.push(`${name}.${status} -> ${token.labelKey}`);
    }
  }
  // Collected rather than asserted one at a time so a failure names every
  // offender at once instead of stopping at the first.
  expect(mismatched).toEqual([]);
});

test('every status label resolves to a string in both catalogues', () => {
  for (const table of Object.values(tables)) {
    for (const token of Object.values(table)) {
      expect(typeof resolve(esCO, token.labelKey)).toBe('string');
      expect(typeof resolve(enUS, token.labelKey)).toBe('string');
    }
  }
});

/**
 * Sets whose chips are rendered side by side on one row, and must therefore stay
 * tellable apart without reading the label.
 *
 * Add a pair here whenever a surface starts rendering two chips together.
 */
type NamedTable = { name: string; table: Readonly<Record<string, StatusToken>> };

/*
 * Widened to `StatusToken` deliberately. Left as `as const`, the literal types
 * are narrow enough that `tsc` rejects the comparison below as provably false —
 * which is a fine property to have today, but it disappears the moment someone
 * makes two tokens overlap, exactly when the check needs to run. The compiler
 * cannot be the guard here because the guard must survive the change it guards
 * against.
 */
const coRenderedPairs: readonly { left: NamedTable; right: NamedTable }[] = [
  // `providers-surface.tsx` puts archival status and claim state in adjacent
  // cells of the same row. They are independent axes — an archived Provider may
  // be claimed — so two identical-looking chips would read as one repeated fact.
  {
    left: { name: 'archival', table: archivalStatusTokens },
    right: { name: 'providerClaim', table: providerClaimStateTokens },
  },
  // `assignments-panel.tsx` puts execution state and terms state in adjacent
  // cells of the same row. Independent axes again — a confirmed vehicle may sit
  // on a declined offer — and three pairs collided when the panel was written:
  // `unassigned`/`draft`, `confirmed`/`accepted`, `notExecuted`/`declined`. The
  // most common row in the panel is an unassigned vehicle on draft terms, so the
  // default state was the broken one.
  {
    left: { name: 'execution', table: executionStatusTokens },
    right: { name: 'assignmentRevision', table: assignmentRevisionStatusTokens },
  },
];

test('chips rendered side by side never collapse to the same tone and shape', () => {
  // `claimed` and archival `active` already share `tone: 'go'`; only `shape`
  // separates them. Mutation testing changed one character — `diamond` to `dot`
  // — and made an active claimed Provider show two pixel-identical chips with
  // the suite green, while the source comment above the table asserted the
  // opposite and CLAUDE.md requires shape to carry the same information as
  // colour. The rule now has an assertion instead of a comment.
  const collisions: string[] = [];
  for (const { left, right } of coRenderedPairs) {
    for (const [leftStatus, leftToken] of Object.entries(left.table)) {
      for (const [rightStatus, rightToken] of Object.entries(right.table)) {
        if (leftToken.tone === rightToken.tone && leftToken.shape === rightToken.shape) {
          collisions.push(`${left.name}.${leftStatus} is indistinguishable from ${right.name}.${rightStatus}`);
        }
      }
    }
  }
  expect(collisions).toEqual([]);
});

test('no status set distinguishes two of its own members by colour alone', () => {
  // The co-rendered check above compares two DIFFERENT tables. This one guards
  // the inside of each: `CLAUDE.md` says colour is never the only channel, so
  // two members of one set sharing a shape must be a mutation the suite
  // notices. Retoning `execution.assigned` to `go`/`diamond` — a one-word edit
  // colliding it with `confirmed` — previously survived the whole suite.
  const collisions: string[] = [];
  for (const { name, table } of Object.entries(tables).map(([name, table]) => ({ name, table }))) {
    const seen = new Map<string, string>();
    for (const [status, token] of Object.entries(table)) {
      const key = `${token.tone}/${token.shape}`;
      const previous = seen.get(key);
      if (previous !== undefined) collisions.push(`${name}.${previous} is indistinguishable from ${name}.${status}`);
      seen.set(key, status);
    }
  }
  expect(collisions).toEqual([]);
});

test('statusToken dispatches each kind to its own table', () => {
  // A copy-pasted `case` returning a neighbouring table is invisible to `tsc`
  // when the two sets share member names — `draft` belongs to five of them.
  expect(statusToken({ kind: 'project', status: 'draft' })).toBe(projectStatusTokens.draft);
  expect(statusToken({ kind: 'event', status: 'draft' })).toBe(eventStatusTokens.draft);
  expect(statusToken({ kind: 'serviceKind', status: 'draft' })).toBe(serviceKindStatusTokens.draft);
  expect(statusToken({ kind: 'serviceKindVersion', status: 'draft' })).toBe(serviceKindVersionStatusTokens.draft);
  expect(statusToken({ kind: 'rateCardVersion', status: 'draft' })).toBe(rateCardVersionStatusTokens.draft);
  expect(statusToken({ kind: 'service', status: 'draft' })).toBe(serviceStatusTokens.draft);
  expect(statusToken({ kind: 'assignmentRevision', status: 'draft' })).toBe(assignmentRevisionStatusTokens.draft);
  expect(statusToken({ kind: 'archival', status: 'active' })).toBe(archivalStatusTokens.active);
  expect(statusToken({ kind: 'providerClaim', status: 'claimed' })).toBe(providerClaimStateTokens.claimed);
  expect(statusToken({ kind: 'execution', status: 'unassigned' })).toBe(executionStatusTokens.unassigned);
});
