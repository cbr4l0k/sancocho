/** A relationship is removable here only when this surface owns its source Event. */
export function mayRemoveServiceRelationship(direction: 'outgoing' | 'incoming', canEdit: boolean): boolean {
  return direction === 'outgoing' && canEdit;
}

/** Never offer the viewed Service as a relationship target. */
export function relationshipTargetOptions<T extends { _id: string }>(
  services: readonly T[],
  viewedServiceId: string,
): T[] {
  return services.filter((service) => service._id !== viewedServiceId);
}
