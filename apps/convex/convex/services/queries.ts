import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import {
  serviceDocValidator,
  serviceFieldValueValidator,
  serviceStatusValidator,
  fieldConfigValidator,
  paginatedResult,
  projectStatusValidator,
} from '../validators';
import {
  getService as getServiceModel,
  listOrganizationServices as listOrganizationServicesModel,
  listProjectServices as listProjectServicesModel,
} from './model';

/**
 * `key` and `label` are joined from the live field definition; the value itself
 * is interpreted under the service's immutable serviceKind snapshot. See the coupling
 * note in ./model `getService` for why the key half of that join is stable.
 */
const serviceValue = v.object({
  fieldDefinitionId: v.id('fieldDefinitions'),
  key: v.string(),
  label: v.string(),
  value: serviceFieldValueValidator,
  /** Joined for `location` values only — see ./model `locationNameOf`. */
  locationName: v.optional(v.string()),
});

/**
 * A table row's version of the same join. It carries the serviceKind field's
 * immutable `config` snapshot alongside the value, and includes fields that
 * have NO value, because the console renders one column per field the version
 * composes and edits values in place — both need the field to exist in the row
 * even when the service has nothing stored for it.
 */
const serviceRowField = v.object({
  fieldDefinitionId: v.id('fieldDefinitions'),
  key: v.string(),
  label: v.string(),
  required: v.boolean(),
  position: v.number(),
  config: fieldConfigValidator,
  value: v.optional(serviceFieldValueValidator),
  /** Joined for `location` values only — see ./model `locationNameOf`. */
  locationName: v.optional(v.string()),
});

const serviceRow = v.object({
  service: serviceDocValidator,
  projectName: v.string(),
  projectStatus: projectStatusValidator,
  /** The project's own window — an affordance for the row editor. See ./model. */
  projectStartsAt: v.optional(v.number()),
  projectEndsAt: v.optional(v.number()),
  fields: v.array(serviceRowField),
});

export const getService = query({
  args: { serviceId: v.id('services') },
  returns: v.object({ service: serviceDocValidator, values: v.array(serviceValue) }),
  handler: (ctx, args) => getServiceModel(ctx, args.serviceId),
});

export const listProjectServices = query({
  args: { projectId: v.id('projects'), paginationOpts: paginationOptsValidator },
  returns: paginatedResult(serviceDocValidator),
  handler: (ctx, args) => listProjectServicesModel(ctx, args),
});

/**
 * The Services screen's list: every project's services in one ordered page.
 *
 * `projectId` and `status` are optional NARROWINGS of that list, not required
 * steps — the console used to make choosing a project a precondition for seeing
 * any service at all, which meant the one screen that should answer "what is
 * happening, in order" could only ever answer it one project at a time.
 */
export const listOrganizationServices = query({
  args: {
    organizationId: v.id('organizations'),
    projectId: v.optional(v.id('projects')),
    status: v.optional(serviceStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedResult(serviceRow),
  handler: (ctx, args) => listOrganizationServicesModel(ctx, args),
});
