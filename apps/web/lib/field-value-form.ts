import type { serviceFieldValueValidator } from '@priamo/convex/validators';

import { parseDateForStorage, parseTimeForStorage } from '@/i18n/formats';
import { timestampFromParts, timestampToParts } from '@/lib/timestamps';

export type ServiceFieldValue = typeof serviceFieldValueValidator.type;

/** Form state deliberately mirrors every persisted discriminator. */
export type FieldValueFormState =
  | { kind: 'text'; value: string }
  | { kind: 'longText'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: string }
  | { kind: 'datetime'; date: string; time: string }
  | { kind: 'time'; value: string }
  | { kind: 'select'; optionId: string }
  | { kind: 'multiSelect'; optionIds: string[] }
  | { kind: 'location'; locationId?: Extract<ServiceFieldValue, { kind: 'location' }>['locationId'] };

export function emptyFieldValueFormState(kind: ServiceFieldValue['kind']): FieldValueFormState {
  switch (kind) {
    case 'text':
      return { kind, value: '' };
    case 'longText':
      return { kind, value: '' };
    case 'number':
      return { kind, value: '' };
    case 'boolean':
      return { kind, value: false };
    case 'date':
      return { kind, value: '' };
    case 'datetime':
      return { kind, date: '', time: '' };
    case 'time':
      return { kind, value: '' };
    case 'select':
      return { kind, optionId: '' };
    case 'multiSelect':
      return { kind, optionIds: [] };
    case 'location':
      return { kind };
  }
}

export function toServiceFieldValue(state: FieldValueFormState): ServiceFieldValue | undefined {
  switch (state.kind) {
    case 'text':
    case 'longText':
      return { kind: state.kind, value: state.value };
    case 'number': {
      const value = Number(state.value);
      return state.value.trim() !== '' && Number.isFinite(value) ? { kind: state.kind, value } : undefined;
    }
    case 'boolean':
      return { kind: state.kind, value: state.value };
    case 'date': {
      const value = parseDateForStorage(state.value);
      return value === undefined ? undefined : { kind: state.kind, value };
    }
    case 'time': {
      const value = parseTimeForStorage(state.value);
      return value === undefined ? undefined : { kind: state.kind, value };
    }
    case 'datetime': {
      const value = timestampFromParts(state);
      return value === undefined ? undefined : { kind: state.kind, value };
    }
    case 'select':
      return state.optionId === '' ? undefined : { kind: state.kind, optionId: state.optionId };
    case 'multiSelect':
      return { kind: state.kind, optionIds: state.optionIds };
    case 'location':
      return state.locationId === undefined ? undefined : { kind: state.kind, locationId: state.locationId };
  }
}

export function fromServiceFieldValue(value: ServiceFieldValue): FieldValueFormState {
  switch (value.kind) {
    case 'text':
    case 'longText':
    case 'boolean':
    case 'date':
    case 'time':
    case 'select':
    case 'multiSelect':
    case 'location':
      return value;
    case 'number':
      return { kind: value.kind, value: String(value.value) };
    case 'datetime':
      return { kind: value.kind, ...timestampToParts(value.value) };
  }
}
