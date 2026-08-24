import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { query } from '../_generated/server';
import { eventDocValidator, eventStatusValidator, paginatedResult, projectDocValidator, projectStatusValidator, recipeDocValidator } from '../validators';
import * as model from './model';

const eventCount = v.object({ status: eventStatusValidator, count: v.number() });
const projectCount = v.object({ status: projectStatusValidator, count: v.number() });
export const getServiceStatusCounts = query({ args: { organizationId: v.id('organizations') }, returns: v.array(eventCount), handler: (ctx, args) => model.getServiceStatusCounts(ctx, args.organizationId) });
export const getProjectStatusCounts = query({ args: { organizationId: v.id('organizations') }, returns: v.array(projectCount), handler: (ctx, args) => model.getProjectStatusCounts(ctx, args.organizationId) });
export const getActiveRecipeCount = query({ args: { organizationId: v.id('organizations') }, returns: v.number(), handler: (ctx, args) => model.getActiveRecipeCount(ctx, args.organizationId) });
export const getLocationCount = query({ args: { organizationId: v.id('organizations') }, returns: v.number(), handler: (ctx, args) => model.getLocationCount(ctx, args.organizationId) });
export const getUpcomingServices = query({ args: { organizationId: v.id('organizations'), startsAt: v.number(), endsAt: v.number(), limit: v.number() }, returns: v.array(eventDocValidator), handler: (ctx, args) => model.getUpcomingServices(ctx, args) });
export const getProjectBreakdown = query({ args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator }, returns: paginatedResult(v.object({ project: projectDocValidator, count: v.number() })), handler: (ctx, args) => model.getProjectBreakdown(ctx, args.organizationId, args.paginationOpts) });
export const getRecipeBreakdown = query({ args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator }, returns: paginatedResult(v.object({ recipe: recipeDocValidator, count: v.number() })), handler: (ctx, args) => model.getRecipeBreakdown(ctx, args.organizationId, args.paginationOpts) });

// ===========================================================================
// Semantic domain metrics and filtered/bounded reads — see
// statistics/model.ts and docs/statistics.md for the full design rationale.
// Added rather than folded into the queries above so the existing O(1)
// unfiltered queries (and every test already driving them) are untouched.
// ===========================================================================

/** `projectId`/`startsAt`/`endsAt` are all optional: every combination (including none) is a legal call. */
const filterArgs = {
  organizationId: v.id('organizations'),
  projectId: v.optional(v.id('projects')),
  startsAt: v.optional(v.number()),
  endsAt: v.optional(v.number()),
};

const filteredValue = v.object({ value: v.number(), isTruncated: v.boolean() });
const filteredEventCount = v.object({ status: eventStatusValidator, count: v.number(), isTruncated: v.boolean() });
const semanticStatusRollup = v.object({ status: eventStatusValidator, sum: v.number(), count: v.number() });
const semanticProjectRollup = v.object({ project: projectDocValidator, sum: v.number(), count: v.number() });
const semanticTotalResult = v.object({ total: filteredValue, eventCount: filteredValue });
const occupancyMetricsResult = v.object({
  sampleSize: v.number(),
  isTruncated: v.boolean(),
  mean: v.union(v.number(), v.null()),
  median: v.union(v.number(), v.null()),
  max: v.union(v.number(), v.null()),
  countAtOrAboveThreshold: v.union(v.number(), v.null()),
});

export const getFilteredServiceStatusCounts = query({
  args: filterArgs,
  returns: v.array(filteredEventCount),
  handler: (ctx, args) => model.getFilteredServiceStatusCounts(ctx, args),
});

export const getPassengerTotals = query({ args: filterArgs, returns: semanticTotalResult, handler: (ctx, args) => model.getPassengerTotals(ctx, args) });
export const getAccessibilityRequirements = query({ args: filterArgs, returns: semanticTotalResult, handler: (ctx, args) => model.getAccessibilityRequirements(ctx, args) });

const projectBreakdownArgs = { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator };
export const getPassengerTotalsByProject = query({ args: projectBreakdownArgs, returns: paginatedResult(semanticProjectRollup), handler: (ctx, args) => model.getPassengerTotalsByProject(ctx, args.organizationId, args.paginationOpts) });
export const getAccessibilityByProject = query({ args: projectBreakdownArgs, returns: paginatedResult(semanticProjectRollup), handler: (ctx, args) => model.getAccessibilityByProject(ctx, args.organizationId, args.paginationOpts) });

export const getPassengerTotalsByStatus = query({ args: { organizationId: v.id('organizations') }, returns: v.array(semanticStatusRollup), handler: (ctx, args) => model.getPassengerTotalsByStatus(ctx, args.organizationId) });
export const getAccessibilityByStatus = query({ args: { organizationId: v.id('organizations') }, returns: v.array(semanticStatusRollup), handler: (ctx, args) => model.getAccessibilityByStatus(ctx, args.organizationId) });

export const getOccupancyMetrics = query({
  args: { ...filterArgs, threshold: v.optional(v.number()) },
  returns: occupancyMetricsResult,
  handler: (ctx, args) => model.getOccupancyMetrics(ctx, args),
});
