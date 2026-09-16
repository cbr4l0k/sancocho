import type { FunctionReturnType } from 'convex/server';

import { api } from '@priamo/convex/api';
import type { assignmentRevisionStatusValidator, rateModalityValidator } from '@priamo/convex/validators';

import { addMinorUnits, type Currency } from './money';

export type AssignmentPanelRow = FunctionReturnType<
  typeof api.assignments.queries.listServiceAssignmentRows
>[number];
export type AssignmentRevisionStatus = typeof assignmentRevisionStatusValidator.type;
export type RateModality = typeof rateModalityValidator.type;

export type AssignmentTerms = {
  vehicleClassName: string | null;
  modality: RateModality;
  quantity: number;
  unitAmount: number;
  currency: Currency;
  lineTotal: number;
};

export type AssignmentSummary =
  | { kind: 'agreed'; terms: AssignmentTerms }
  | { kind: 'proposed'; status: AssignmentRevisionStatus; terms: AssignmentTerms }
  | { kind: 'unpriced' };

function terms(row: AssignmentPanelRow, revision: NonNullable<AssignmentPanelRow['latestRevision']>): AssignmentTerms {
  return {
    vehicleClassName: row.vehicleClass?.name ?? null,
    modality: revision.modality,
    quantity: revision.quantity,
    unitAmount: revision.unitAmount,
    currency: revision.currency,
    lineTotal: revision.lineTotal,
  };
}

/** Only the backend-proven current accepted Revision can become agreed terms. */
export function assignmentSummary(row: AssignmentPanelRow): AssignmentSummary {
  if (row.currentRevision !== null) return { kind: 'agreed', terms: terms(row, row.currentRevision) };
  if (row.latestRevision !== null) {
    return { kind: 'proposed', status: row.latestRevision.status, terms: terms(row, row.latestRevision) };
  }
  return { kind: 'unpriced' };
}

export type CurrencyTotal = { currency: Currency; minorUnits: number };

/** Returns independent exact minor-unit totals; there is deliberately no blended scalar. */
export function serviceTotals(rows: readonly AssignmentPanelRow[]): readonly CurrencyTotal[] {
  const totals = new Map<Currency, number>();
  for (const row of rows) {
    const summary = assignmentSummary(row);
    if (summary.kind !== 'agreed') continue;
    const previous = totals.get(summary.terms.currency) ?? 0;
    const next = addMinorUnits(previous, summary.terms.lineTotal);
    totals.set(summary.terms.currency, next);
  }
  return [...totals].map(([currency, minorUnits]) => ({ currency, minorUnits }));
}
