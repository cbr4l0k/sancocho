import { describe, expect, test } from 'bun:test';

import { validateLocationCoordinates } from './location-coordinates';

describe('validateLocationCoordinates', () => {
  test('accepts both omitted and a complete in-range pair', () => {
    expect(validateLocationCoordinates({ latitude: '', longitude: '' })).toEqual({
      valid: true,
      coordinates: undefined,
    });
    expect(validateLocationCoordinates({ latitude: '4.711', longitude: '-74.0721' })).toEqual({
      valid: true,
      coordinates: { latitude: 4.711, longitude: -74.0721 },
    });
  });

  test('rejects an incomplete coordinate pair', () => {
    expect(validateLocationCoordinates({ latitude: '4.711', longitude: '' })).toEqual({ valid: false });
    expect(validateLocationCoordinates({ latitude: '', longitude: '-74.0721' })).toEqual({ valid: false });
  });

  test('rejects out-of-range latitude and longitude', () => {
    expect(validateLocationCoordinates({ latitude: '90.1', longitude: '0' })).toEqual({ valid: false });
    expect(validateLocationCoordinates({ latitude: '0', longitude: '-180.1' })).toEqual({ valid: false });
  });

  test('rejects non-finite coordinate input', () => {
    expect(validateLocationCoordinates({ latitude: 'Infinity', longitude: '0' })).toEqual({ valid: false });
    expect(validateLocationCoordinates({ latitude: 'NaN', longitude: '0' })).toEqual({ valid: false });
  });
});
