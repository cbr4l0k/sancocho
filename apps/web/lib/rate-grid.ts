import {
  archivalStatusValidator,
  currencyValidator,
  rateModalityValidator,
  rateCardVersionStatusValidator,
} from '@priamo/convex/validators';

import { parseMoneyInput, type MoneyInputProblem } from './money';

export type RateModality = typeof rateModalityValidator.type;
export type RateCardVersionStatus = typeof rateCardVersionStatusValidator.type;
export type Currency = typeof currencyValidator.type;
export type RateCardStatus = typeof archivalStatusValidator.type;

/** The grid columns come from the backend-owned closed union, never from a second handwritten list. */
export const rateModalities: readonly RateModality[] = rateModalityValidator.members.map(
  (member) => member.value,
);
export const currencies: readonly Currency[] = currencyValidator.members.map((member) => member.value);

export type RateGridClass<ClassId extends string> = { _id: ClassId; name: string; status: RateCardStatus };
export type RateGridLine<ClassId extends string, LineId extends string> = {
  _id: LineId;
  vehicleClassId: ClassId;
  modality: RateModality;
  unitAmount: number;
};
export type RateGridCell<ClassId extends string, LineId extends string> = {
  vehicleClassId: ClassId;
  modality: RateModality;
  line: RateGridLine<ClassId, LineId> | undefined;
};
export type RateGridRow<ClassId extends string, LineId extends string> = {
  vehicleClass: RateGridClass<ClassId>;
  cells: readonly RateGridCell<ClassId, LineId>[];
};

/**
 * The `\u0000` is a real separator, not decoration: without it `('ab','c')` and
 * `('a','bc')` produce the same key and two cells silently become one.
 *
 * No test covers it, deliberately. Convex ids are fixed-length and the modality
 * values are a closed four-member union, so no reachable pair can collide —
 * a test would have to fabricate ids that cannot occur, and would then be
 * asserting against a scenario the type system already rules out. It stays
 * because the constraint that makes it unnecessary is not this module's to
 * keep, and a contrived test would not have found that out either.
 */
function cellKey(vehicleClassId: string, modality: RateModality): string {
  return `${vehicleClassId}\u0000${modality}`;
}

export type RateGridAssembly<ClassId extends string, LineId extends string> =
  | { ok: true; rows: readonly RateGridRow<ClassId, LineId>[] }
  | { ok: false; reason: 'rateGridUnknownVehicleClass' | 'rateGridUnknownModality' | 'rateGridDuplicateCell' };

/** Builds complete rows, returning data-shape failures to the local surface instead of throwing during render. */
export function assembleRateGrid<ClassId extends string, LineId extends string>(
  vehicleClasses: readonly RateGridClass<ClassId>[],
  modalities: readonly RateModality[],
  rateLines: readonly RateGridLine<ClassId, LineId>[],
): RateGridAssembly<ClassId, LineId> {
  const knownClasses = new Set(vehicleClasses.map((vehicleClass) => vehicleClass._id));
  const knownModalities = new Set<RateModality>(modalities);
  const lines = new Map<string, RateGridLine<ClassId, LineId>>();

  for (const line of rateLines) {
    if (!knownClasses.has(line.vehicleClassId)) return { ok: false, reason: 'rateGridUnknownVehicleClass' };
    if (!knownModalities.has(line.modality)) return { ok: false, reason: 'rateGridUnknownModality' };
    const key = cellKey(line.vehicleClassId, line.modality);
    if (lines.has(key)) return { ok: false, reason: 'rateGridDuplicateCell' };
    lines.set(key, line);
  }

  return {
    ok: true,
    rows: vehicleClasses.map((vehicleClass) => ({
      vehicleClass,
      cells: modalities.map((modality) => ({
        vehicleClassId: vehicleClass._id,
        modality,
        line: lines.get(cellKey(vehicleClass._id, modality)),
      })),
    })),
  };
}

export type RateCellTransition =
  | { kind: 'add'; unitAmount: number }
  | { kind: 'update'; unitAmount: number }
  | { kind: 'remove' }
  | { kind: 'noop' }
  | { kind: 'invalid'; problem: MoneyInputProblem };

/** Maps the structural empty/value states directly onto the three Rate Line mutations. */
export function rateCellTransition(
  previousMinorUnits: number | undefined,
  submitted: string,
  archived = false,
): RateCellTransition {
  if (archived) {
    return previousMinorUnits !== undefined && submitted.trim() === '' ? { kind: 'remove' } : { kind: 'noop' };
  }
  if (submitted.trim() === '') return previousMinorUnits === undefined ? { kind: 'noop' } : { kind: 'remove' };
  const parsed = parseMoneyInput(submitted);
  if (!parsed.ok) return { kind: 'invalid', problem: parsed.problem };
  if (previousMinorUnits === undefined) return { kind: 'add', unitAmount: parsed.minorUnits };
  if (previousMinorUnits === parsed.minorUnits) return { kind: 'noop' };
  return { kind: 'update', unitAmount: parsed.minorUnits };
}

export type RateVersionAffordance = 'edit';

export function rateVersionAffordances(
  cardStatus: RateCardStatus,
  versionStatus: RateCardVersionStatus,
): readonly RateVersionAffordance[] {
  return cardStatus === 'active' && versionStatus === 'draft' ? ['edit'] : [];
}
