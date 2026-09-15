import { expect, test } from 'bun:test';

import enUS from '@/i18n/messages/en-US';
import esCO from '@/i18n/messages/es-CO';

import {
  archivalStatusTokens,
  assignmentRevisionStatusTokens,
  eventStatusTokens,
  executionStatusTokens,
  projectStatusTokens,
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
  serviceStatusTokens,
  archivalStatusTokens,
  executionStatusTokens,
  assignmentRevisionStatusTokens,
};

function resolve(catalogue: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>(
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

test('statusToken dispatches each kind to its own table', () => {
  // A copy-pasted `case` returning a neighbouring table is invisible to `tsc`
  // when the two sets share member names — `draft` belongs to five of them.
  expect(statusToken({ kind: 'project', status: 'draft' })).toBe(projectStatusTokens.draft);
  expect(statusToken({ kind: 'event', status: 'draft' })).toBe(eventStatusTokens.draft);
  expect(statusToken({ kind: 'serviceKind', status: 'draft' })).toBe(serviceKindStatusTokens.draft);
  expect(statusToken({ kind: 'serviceKindVersion', status: 'draft' })).toBe(serviceKindVersionStatusTokens.draft);
  expect(statusToken({ kind: 'service', status: 'draft' })).toBe(serviceStatusTokens.draft);
  expect(statusToken({ kind: 'assignmentRevision', status: 'draft' })).toBe(assignmentRevisionStatusTokens.draft);
  expect(statusToken({ kind: 'archival', status: 'active' })).toBe(archivalStatusTokens.active);
  expect(statusToken({ kind: 'execution', status: 'unassigned' })).toBe(executionStatusTokens.unassigned);
});
