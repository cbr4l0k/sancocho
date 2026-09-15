import type { ArchivalStatus } from './status';

export type CatalogueFilter = {
  search: string;
  status: ArchivalStatus | '';
};

export type FleetFilter<ProviderId extends string, VehicleClassId extends string> = CatalogueFilter & {
  providerId: ProviderId | '';
  vehicleClassId: VehicleClassId | '';
};

export type RateCardFilter<ProviderId extends string> = { providerId: ProviderId | '' };

function optionalSearch(search: string): { search?: string } {
  const normalized = search.trim();
  return normalized === '' ? {} : { search: normalized };
}

/**
 * Query arguments for an organization catalogue with search and a status filter.
 *
 * Providers and Vehicle Classes publish the same argument shape, so this is one
 * function rather than two identical ones under different names — two copies
 * would mean a fix applied to one silently missing the other.
 *
 * Note what it deliberately does NOT carry: a cursor, a page size, or anything
 * else about pagination. `usePaginatedQuery` compares these arguments to decide
 * when to start a new cursor, so a value that changed per page would reset the
 * cursor on every "load more" and a filter change that did not alter them would
 * keep serving the old filter's pages.
 */
export function catalogueArgs<OrganizationId extends string>(
  organizationId: OrganizationId | undefined,
  filter: CatalogueFilter,
) {
  if (organizationId === undefined) return 'skip';
  return {
    organizationId,
    ...optionalSearch(filter.search),
    ...(filter.status === '' ? {} : { status: filter.status }),
  };
}

/** Provider and Class constraints remain query arguments, so the backend indexes serve them before pagination. */
export function fleetCatalogueArgs<
  OrganizationId extends string,
  ProviderId extends string,
  VehicleClassId extends string,
>(organizationId: OrganizationId | undefined, filter: FleetFilter<ProviderId, VehicleClassId>) {
  if (organizationId === undefined) return 'skip';
  return {
    organizationId,
    ...optionalSearch(filter.search),
    ...(filter.status === '' ? {} : { status: filter.status }),
    ...(filter.providerId === '' ? {} : { providerId: filter.providerId }),
    ...(filter.vehicleClassId === '' ? {} : { vehicleClassId: filter.vehicleClassId }),
  };
}

/** Rate Card Provider constraints remain query arguments so filtering happens before pagination. */
export function rateCardCatalogueArgs<OrganizationId extends string, ProviderId extends string>(
  organizationId: OrganizationId | undefined,
  filter: RateCardFilter<ProviderId>,
) {
  if (organizationId === undefined) return 'skip';
  return {
    organizationId,
    ...(filter.providerId === '' ? {} : { providerId: filter.providerId }),
  };
}

/**
 * Query arguments for a picker. `'skip'` until there is an organization, and
 * always `status: 'active'` — an archived Provider or Class is still a real row
 * that existing records point at, but it must never be offered for a new one.
 *
 * Shared by both pickers for the same reason as `catalogueArgs`.
 */
export function pickerArgs<OrganizationId extends string>(
  organizationId: OrganizationId | undefined,
  search: string,
) {
  if (organizationId === undefined) return 'skip';
  return { organizationId, status: 'active' as const, ...optionalSearch(search) };
}

/** A catalogue filter may select archived Providers that existing records still reference. */
export function providerFilterPickerArgs<OrganizationId extends string>(
  organizationId: OrganizationId | undefined,
  search: string,
) {
  if (organizationId === undefined) return 'skip';
  return { organizationId, ...optionalSearch(search) };
}
