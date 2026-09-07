import type { fieldConfigValidator } from '@priamo/convex/validators';
import type { ServiceFieldValue } from './field-value-form';
type FieldConfig = typeof fieldConfigValidator.type;
/** Client feedback only; services/model.ts remains the authoritative validation gate. */
export function serviceFieldProblem(
  config: FieldConfig,
  value: ServiceFieldValue | undefined,
  required: boolean,
  hasDefault: boolean,
): 'required' | 'invalid' | undefined {
  if (value === undefined) return required && !hasDefault ? 'required' : undefined;
  switch (config.kind) {
    case 'text':
    case 'longText':
      if (value.kind !== config.kind) return 'invalid';
      return (config.minLength !== undefined && value.value.length < config.minLength) ||
        (config.maxLength !== undefined && value.value.length > config.maxLength)
        ? 'invalid'
        : undefined;
    case 'number':
      if (value.kind !== 'number') return 'invalid';
      return (config.min !== undefined && value.value < config.min) ||
        (config.max !== undefined && value.value > config.max) ||
        (config.integer === true && !Number.isInteger(value.value))
        ? 'invalid'
        : undefined;
    case 'date':
    case 'time':
      if (value.kind !== config.kind) return 'invalid';
      return (config.min !== undefined && value.value < config.min) ||
        (config.max !== undefined && value.value > config.max)
        ? 'invalid'
        : undefined;
    case 'datetime':
      if (value.kind !== 'datetime') return 'invalid';
      return (config.min !== undefined && value.value < config.min) ||
        (config.max !== undefined && value.value > config.max)
        ? 'invalid'
        : undefined;
    case 'select':
      return value.kind === 'select' && config.options.some((option) => option.id === value.optionId)
        ? undefined
        : 'invalid';
    case 'multiSelect':
      if (value.kind !== 'multiSelect') return 'invalid';
      return new Set(value.optionIds).size !== value.optionIds.length ||
        !value.optionIds.every((id: string) => config.options.some((option) => option.id === id)) ||
        (config.minSelections !== undefined && value.optionIds.length < config.minSelections) ||
        (config.maxSelections !== undefined && value.optionIds.length > config.maxSelections)
        ? 'invalid'
        : undefined;
    case 'boolean':
      return value.kind === 'boolean' ? undefined : 'invalid';
    case 'location':
      return value.kind === 'location' ? undefined : 'invalid';
  }
}
