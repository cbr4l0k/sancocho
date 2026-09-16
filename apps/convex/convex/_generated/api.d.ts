/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as assignments_costing from "../assignments/costing.js";
import type * as assignments_execution from "../assignments/execution.js";
import type * as assignments_model from "../assignments/model.js";
import type * as assignments_mutations from "../assignments/mutations.js";
import type * as assignments_queries from "../assignments/queries.js";
import type * as assignments_rateLookup from "../assignments/rateLookup.js";
import type * as audit_model from "../audit/model.js";
import type * as audit_queries from "../audit/queries.js";
import type * as auth_model from "../auth/model.js";
import type * as auth_mutations from "../auth/mutations.js";
import type * as auth_queries from "../auth/queries.js";
import type * as costCentres_model from "../costCentres/model.js";
import type * as costCentres_mutations from "../costCentres/mutations.js";
import type * as costCentres_queries from "../costCentres/queries.js";
import type * as events_model from "../events/model.js";
import type * as events_mutations from "../events/mutations.js";
import type * as events_queries from "../events/queries.js";
import type * as fields_builtins from "../fields/builtins.js";
import type * as fields_model from "../fields/model.js";
import type * as fields_mutations from "../fields/mutations.js";
import type * as fields_queries from "../fields/queries.js";
import type * as fields_values from "../fields/values.js";
import type * as invitations_model from "../invitations/model.js";
import type * as invitations_mutations from "../invitations/mutations.js";
import type * as invitations_queries from "../invitations/queries.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_authAdapter from "../lib/authAdapter.js";
import type * as lib_capabilityFloors from "../lib/capabilityFloors.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_names from "../lib/names.js";
import type * as lib_providerProjection from "../lib/providerProjection.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_search from "../lib/search.js";
import type * as lib_seedGuard from "../lib/seedGuard.js";
import type * as locations_model from "../locations/model.js";
import type * as locations_mutations from "../locations/mutations.js";
import type * as locations_queries from "../locations/queries.js";
import type * as organizations_model from "../organizations/model.js";
import type * as organizations_mutations from "../organizations/mutations.js";
import type * as organizations_queries from "../organizations/queries.js";
import type * as projects_model from "../projects/model.js";
import type * as projects_mutations from "../projects/mutations.js";
import type * as projects_queries from "../projects/queries.js";
import type * as providers_grants from "../providers/grants.js";
import type * as providers_model from "../providers/model.js";
import type * as providers_mutations from "../providers/mutations.js";
import type * as providers_queries from "../providers/queries.js";
import type * as providers_references from "../providers/references.js";
import type * as rateCards_model from "../rateCards/model.js";
import type * as rateCards_mutations from "../rateCards/mutations.js";
import type * as rateCards_queries from "../rateCards/queries.js";
import type * as rateCards_references from "../rateCards/references.js";
import type * as relationships_model from "../relationships/model.js";
import type * as relationships_mutations from "../relationships/mutations.js";
import type * as relationships_queries from "../relationships/queries.js";
import type * as seed_bogota from "../seed/bogota.js";
import type * as seed_cordillera from "../seed/cordillera.js";
import type * as seed_identity from "../seed/identity.js";
import type * as seed_mutations from "../seed/mutations.js";
import type * as seed_reset from "../seed/reset.js";
import type * as serviceKinds_builtins from "../serviceKinds/builtins.js";
import type * as serviceKinds_fields_model from "../serviceKinds/fields/model.js";
import type * as serviceKinds_fields_mutations from "../serviceKinds/fields/mutations.js";
import type * as serviceKinds_fields_queries from "../serviceKinds/fields/queries.js";
import type * as serviceKinds_model from "../serviceKinds/model.js";
import type * as serviceKinds_mutations from "../serviceKinds/mutations.js";
import type * as serviceKinds_queries from "../serviceKinds/queries.js";
import type * as services_model from "../services/model.js";
import type * as services_mutations from "../services/mutations.js";
import type * as services_queries from "../services/queries.js";
import type * as validators_index from "../validators/index.js";
import type * as vehicles_builtins from "../vehicles/builtins.js";
import type * as vehicles_classes from "../vehicles/classes.js";
import type * as vehicles_fleet from "../vehicles/fleet.js";
import type * as vehicles_mutations from "../vehicles/mutations.js";
import type * as vehicles_queries from "../vehicles/queries.js";
import type * as vehicles_references from "../vehicles/references.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "assignments/costing": typeof assignments_costing;
  "assignments/execution": typeof assignments_execution;
  "assignments/model": typeof assignments_model;
  "assignments/mutations": typeof assignments_mutations;
  "assignments/queries": typeof assignments_queries;
  "assignments/rateLookup": typeof assignments_rateLookup;
  "audit/model": typeof audit_model;
  "audit/queries": typeof audit_queries;
  "auth/model": typeof auth_model;
  "auth/mutations": typeof auth_mutations;
  "auth/queries": typeof auth_queries;
  "costCentres/model": typeof costCentres_model;
  "costCentres/mutations": typeof costCentres_mutations;
  "costCentres/queries": typeof costCentres_queries;
  "events/model": typeof events_model;
  "events/mutations": typeof events_mutations;
  "events/queries": typeof events_queries;
  "fields/builtins": typeof fields_builtins;
  "fields/model": typeof fields_model;
  "fields/mutations": typeof fields_mutations;
  "fields/queries": typeof fields_queries;
  "fields/values": typeof fields_values;
  "invitations/model": typeof invitations_model;
  "invitations/mutations": typeof invitations_mutations;
  "invitations/queries": typeof invitations_queries;
  "lib/access": typeof lib_access;
  "lib/authAdapter": typeof lib_authAdapter;
  "lib/capabilityFloors": typeof lib_capabilityFloors;
  "lib/errors": typeof lib_errors;
  "lib/money": typeof lib_money;
  "lib/names": typeof lib_names;
  "lib/providerProjection": typeof lib_providerProjection;
  "lib/roles": typeof lib_roles;
  "lib/search": typeof lib_search;
  "lib/seedGuard": typeof lib_seedGuard;
  "locations/model": typeof locations_model;
  "locations/mutations": typeof locations_mutations;
  "locations/queries": typeof locations_queries;
  "organizations/model": typeof organizations_model;
  "organizations/mutations": typeof organizations_mutations;
  "organizations/queries": typeof organizations_queries;
  "projects/model": typeof projects_model;
  "projects/mutations": typeof projects_mutations;
  "projects/queries": typeof projects_queries;
  "providers/grants": typeof providers_grants;
  "providers/model": typeof providers_model;
  "providers/mutations": typeof providers_mutations;
  "providers/queries": typeof providers_queries;
  "providers/references": typeof providers_references;
  "rateCards/model": typeof rateCards_model;
  "rateCards/mutations": typeof rateCards_mutations;
  "rateCards/queries": typeof rateCards_queries;
  "rateCards/references": typeof rateCards_references;
  "relationships/model": typeof relationships_model;
  "relationships/mutations": typeof relationships_mutations;
  "relationships/queries": typeof relationships_queries;
  "seed/bogota": typeof seed_bogota;
  "seed/cordillera": typeof seed_cordillera;
  "seed/identity": typeof seed_identity;
  "seed/mutations": typeof seed_mutations;
  "seed/reset": typeof seed_reset;
  "serviceKinds/builtins": typeof serviceKinds_builtins;
  "serviceKinds/fields/model": typeof serviceKinds_fields_model;
  "serviceKinds/fields/mutations": typeof serviceKinds_fields_mutations;
  "serviceKinds/fields/queries": typeof serviceKinds_fields_queries;
  "serviceKinds/model": typeof serviceKinds_model;
  "serviceKinds/mutations": typeof serviceKinds_mutations;
  "serviceKinds/queries": typeof serviceKinds_queries;
  "services/model": typeof services_model;
  "services/mutations": typeof services_mutations;
  "services/queries": typeof services_queries;
  "validators/index": typeof validators_index;
  "vehicles/builtins": typeof vehicles_builtins;
  "vehicles/classes": typeof vehicles_classes;
  "vehicles/fleet": typeof vehicles_fleet;
  "vehicles/mutations": typeof vehicles_mutations;
  "vehicles/queries": typeof vehicles_queries;
  "vehicles/references": typeof vehicles_references;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
