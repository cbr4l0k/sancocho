/**
 * Engagement discovery exposes no human-readable entity. Its display identity
 * is therefore only its one-based place in the loaded access list; backend ids
 * remain navigation mechanics and never become labels.
 */
export function engagementDisplayNumber(loadedIndex: number): string {
  return String(loadedIndex + 1).padStart(2, '0');
}
