import type { fieldConfigValidator } from '@priamo/convex/validators';

export type FieldConfig = typeof fieldConfigValidator.type;

/**
 * Keeps draft edits inside a definition's envelope. This is UX only: the
 * server remains the authority for snapshot coherence (I1).
 */
export function clampConfigToBound(config: FieldConfig, bound?: FieldConfig): FieldConfig {
  if (bound === undefined) return config;

  switch (config.kind) {
    case 'text':
    case 'longText':
      if (bound.kind !== config.kind) return config;
      return {
        kind: config.kind,
        ...(bound.minLength === undefined
          ? config.minLength === undefined
            ? {}
            : { minLength: config.minLength }
          : { minLength: Math.max(config.minLength ?? bound.minLength, bound.minLength) }),
        ...(bound.maxLength === undefined
          ? config.maxLength === undefined
            ? {}
            : { maxLength: config.maxLength }
          : { maxLength: Math.min(config.maxLength ?? bound.maxLength, bound.maxLength) }),
      };
    case 'number':
      if (bound.kind !== 'number') return config;
      return {
        kind: 'number',
        ...(bound.min === undefined
          ? config.min === undefined
            ? {}
            : { min: config.min }
          : { min: Math.max(config.min ?? bound.min, bound.min) }),
        ...(bound.max === undefined
          ? config.max === undefined
            ? {}
            : { max: config.max }
          : { max: Math.min(config.max ?? bound.max, bound.max) }),
        ...(bound.integer === true || config.integer === true ? { integer: true } : {}),
      };
    case 'date':
      if (bound.kind !== 'date') return config;
      return {
        kind: 'date',
        ...(bound.min === undefined
          ? config.min === undefined
            ? {}
            : { min: config.min }
          : { min: config.min === undefined || config.min < bound.min ? bound.min : config.min }),
        ...(bound.max === undefined
          ? config.max === undefined
            ? {}
            : { max: config.max }
          : { max: config.max === undefined || config.max > bound.max ? bound.max : config.max }),
      };
    case 'datetime':
      if (bound.kind !== 'datetime') return config;
      return {
        kind: 'datetime',
        ...(bound.min === undefined
          ? config.min === undefined
            ? {}
            : { min: config.min }
          : { min: config.min === undefined || config.min < bound.min ? bound.min : config.min }),
        ...(bound.max === undefined
          ? config.max === undefined
            ? {}
            : { max: config.max }
          : { max: config.max === undefined || config.max > bound.max ? bound.max : config.max }),
      };
    case 'time':
      if (bound.kind !== 'time') return config;
      return {
        kind: 'time',
        ...(bound.min === undefined
          ? config.min === undefined
            ? {}
            : { min: config.min }
          : { min: config.min === undefined || config.min < bound.min ? bound.min : config.min }),
        ...(bound.max === undefined
          ? config.max === undefined
            ? {}
            : { max: config.max }
          : { max: config.max === undefined || config.max > bound.max ? bound.max : config.max }),
      };
    case 'select':
    case 'multiSelect': {
      if (bound.kind !== config.kind) return config;
      const available = new Set(bound.options.map((option) => option.id));
      const options = config.options.filter((option) => available.has(option.id));
      if (config.kind === 'select') return { kind: 'select', options };
      if (bound.kind !== 'multiSelect') return config;
      return {
        kind: 'multiSelect',
        options,
        ...(bound.minSelections === undefined
          ? config.minSelections === undefined
            ? {}
            : { minSelections: config.minSelections }
          : { minSelections: Math.max(config.minSelections ?? bound.minSelections, bound.minSelections) }),
        ...(bound.maxSelections === undefined
          ? config.maxSelections === undefined
            ? {}
            : { maxSelections: config.maxSelections }
          : { maxSelections: Math.min(config.maxSelections ?? bound.maxSelections, bound.maxSelections) }),
      };
    }
    case 'boolean':
    case 'location':
      return config;
  }
}
