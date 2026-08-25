import type { FunctionArgs, FunctionReturnType } from 'convex/server';

import { api } from '@sancocho/convex/api';

/**
 * Types shared across the statistics surface's sub-panels, derived from the
 * generated API rather than hand-written — never re-declaring a shape the
 * backend owns.
 */
export type OrganizationId = FunctionArgs<typeof api.statistics.queries.getServiceStatusCounts>['organizationId'];
export type ProjectId = FunctionArgs<typeof api.projects.queries.getProject>['projectId'];
export type Project = FunctionReturnType<typeof api.projects.queries.listProjects>['page'][number];
export type UpcomingService = FunctionReturnType<typeof api.statistics.queries.getUpcomingServices>[number];
export type ProjectBreakdownRow = FunctionReturnType<typeof api.statistics.queries.getProjectBreakdown>['page'][number];
export type RecipeBreakdownRow = FunctionReturnType<typeof api.statistics.queries.getRecipeBreakdown>['page'][number];
export type SemanticProjectRollup = FunctionReturnType<typeof api.statistics.queries.getPassengerTotalsByProject>['page'][number];
export type SemanticStatusRollup = FunctionReturnType<typeof api.statistics.queries.getPassengerTotalsByStatus>[number];
export type OccupancyMetrics = FunctionReturnType<typeof api.statistics.queries.getOccupancyMetrics>;

/**
 * The resolved (already-validated) filter, threaded down to every panel that
 * has a real project/date dimension. `projectId`/`startsAt`/`endsAt` are
 * genuinely optional — every combination, including none, is a legal filter
 * — so callers build the backend args object by spreading only the keys that
 * are defined, never by assigning them `undefined` explicitly.
 */
export type ResolvedStatisticsFilters = {
  organizationId: OrganizationId;
  projectId: ProjectId | undefined;
  startsAt: number | undefined;
  endsAt: number | undefined;
};

/** Builds the exact `{organizationId, projectId?, startsAt?, endsAt?}` args shape the filtered queries expect. */
export function filterQueryArgs(filters: ResolvedStatisticsFilters): FunctionArgs<typeof api.statistics.queries.getFilteredServiceStatusCounts> {
  return {
    organizationId: filters.organizationId,
    ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
    ...(filters.startsAt === undefined ? {} : { startsAt: filters.startsAt }),
    ...(filters.endsAt === undefined ? {} : { endsAt: filters.endsAt }),
  };
}
