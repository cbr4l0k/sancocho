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
