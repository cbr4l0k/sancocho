export type LocationCoordinateInput = { latitude: string; longitude: string };

export type LocationCoordinates = { latitude: number; longitude: number };

export type LocationCoordinateValidation =
  { valid: true; coordinates: LocationCoordinates | undefined } | { valid: false };

/** Validates the pair before it reaches Convex, whose number validator also accepts non-finite values. */
export function validateLocationCoordinates({
  latitude,
  longitude,
}: LocationCoordinateInput): LocationCoordinateValidation {
  if (latitude === '' && longitude === '') return { valid: true, coordinates: undefined };
  if (latitude === '' || longitude === '') return { valid: false };

  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);
  if (
    !Number.isFinite(parsedLatitude) ||
    !Number.isFinite(parsedLongitude) ||
    parsedLatitude < -90 ||
    parsedLatitude > 90 ||
    parsedLongitude < -180 ||
    parsedLongitude > 180
  ) {
    return { valid: false };
  }
  return { valid: true, coordinates: { latitude: parsedLatitude, longitude: parsedLongitude } };
}
