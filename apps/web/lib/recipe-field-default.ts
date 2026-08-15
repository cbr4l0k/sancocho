import type { eventFieldValueValidator } from '@sancocho/convex/validators';

import { parseDateForStorage, parseTimeForStorage } from '@/i18n/formats';

export type EventFieldValue = typeof eventFieldValueValidator.type;

/** Form state deliberately mirrors every persisted discriminator. */
export type DefaultValueFormState =
  | { kind: 'text'; value: string }
  | { kind: 'longText'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: string }
  | { kind: 'datetime'; date: string; time: string }
  | { kind: 'time'; value: string }
  | { kind: 'select'; optionId: string }
  | { kind: 'multiSelect'; optionIds: string[] }
  | { kind: 'location'; locationId?: Extract<EventFieldValue, { kind: 'location' }>['locationId'] };

export function defaultFormState(kind: EventFieldValue['kind']): DefaultValueFormState {
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

export function toEventFieldValue(state: DefaultValueFormState): EventFieldValue | undefined {
  switch (state.kind) {
    case 'text':
      return { kind: state.kind, value: state.value };
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
      const date = parseDateForStorage(state.date);
      const time = parseTimeForStorage(state.time);
      if (date === undefined || time === undefined) return undefined;
      const value = new Date(`${date}T${time}`).getTime();
      return Number.isFinite(value) ? { kind: state.kind, value } : undefined;
    }
    case 'select':
      return state.optionId === '' ? undefined : { kind: state.kind, optionId: state.optionId };
    case 'multiSelect':
      return { kind: state.kind, optionIds: state.optionIds };
    case 'location':
      return state.locationId === undefined ? undefined : { kind: state.kind, locationId: state.locationId };
  }
}

export function fromEventFieldValue(value: EventFieldValue): DefaultValueFormState {
  switch (value.kind) {
    case 'text':
      return value;
    case 'longText':
      return value;
    case 'number':
      return { kind: value.kind, value: String(value.value) };
    case 'boolean':
      return value;
    case 'date':
      return value;
    case 'time':
      return value;
    case 'select':
      return value;
    case 'multiSelect':
      return value;
    case 'location':
      return value;
    case 'datetime': {
      const date = new Date(value.value);
      const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      return { kind: value.kind, date: localDate, time };
    }
  }
}
