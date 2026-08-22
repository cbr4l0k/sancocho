import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { query } from '../_generated/server';
import { eventDocValidator, eventStatusValidator, paginatedResult, projectDocValidator, projectStatusValidator } from '../validators';
import * as model from './model';

const eventCount = v.object({ status: eventStatusValidator, count: v.number() });
const projectCount = v.object({ status: projectStatusValidator, count: v.number() });
export const getServiceStatusCounts = query({ args: { organizationId: v.id('organizations') }, returns: v.array(eventCount), handler: (ctx, args) => model.getServiceStatusCounts(ctx, args.organizationId) });
export const getProjectStatusCounts = query({ args: { organizationId: v.id('organizations') }, returns: v.array(projectCount), handler: (ctx, args) => model.getProjectStatusCounts(ctx, args.organizationId) });
export const getActiveRecipeCount = query({ args: { organizationId: v.id('organizations') }, returns: v.number(), handler: (ctx, args) => model.getActiveRecipeCount(ctx, args.organizationId) });
export const getLocationCount = query({ args: { organizationId: v.id('organizations') }, returns: v.number(), handler: (ctx, args) => model.getLocationCount(ctx, args.organizationId) });
export const getUpcomingServices = query({ args: { organizationId: v.id('organizations'), startsAt: v.number(), endsAt: v.number(), limit: v.number() }, returns: v.array(eventDocValidator), handler: (ctx, args) => model.getUpcomingServices(ctx, args) });
export const getProjectBreakdown = query({ args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator }, returns: paginatedResult(v.object({ project: projectDocValidator, count: v.number() })), handler: (ctx, args) => model.getProjectBreakdown(ctx, args.organizationId, args.paginationOpts) });
export const getRecipeBreakdown = query({ args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator }, returns: paginatedResult(v.object({ recipe: v.object({ _id: v.id('eventRecipes'), _creationTime: v.number(), organizationId: v.id('organizations'), key: v.string(), name: v.string(), description: v.optional(v.string()), status: v.union(v.literal('draft'), v.literal('active'), v.literal('archived')) }), count: v.number() })), handler: (ctx, args) => model.getRecipeBreakdown(ctx, args.organizationId, args.paginationOpts) });
