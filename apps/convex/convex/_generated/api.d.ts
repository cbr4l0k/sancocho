/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as audit_model from "../audit/model.js";
import type * as auth_model from "../auth/model.js";
import type * as auth_mutations from "../auth/mutations.js";
import type * as auth_queries from "../auth/queries.js";
import type * as fields_model from "../fields/model.js";
import type * as fields_mutations from "../fields/mutations.js";
import type * as fields_queries from "../fields/queries.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_authAdapter from "../lib/authAdapter.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_names from "../lib/names.js";
import type * as lib_roles from "../lib/roles.js";
import type * as organizations_model from "../organizations/model.js";
import type * as organizations_mutations from "../organizations/mutations.js";
import type * as organizations_queries from "../organizations/queries.js";
import type * as projects_model from "../projects/model.js";
import type * as projects_mutations from "../projects/mutations.js";
import type * as projects_queries from "../projects/queries.js";
import type * as validators_index from "../validators/index.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "audit/model": typeof audit_model;
  "auth/model": typeof auth_model;
  "auth/mutations": typeof auth_mutations;
  "auth/queries": typeof auth_queries;
  "fields/model": typeof fields_model;
  "fields/mutations": typeof fields_mutations;
  "fields/queries": typeof fields_queries;
  "lib/access": typeof lib_access;
  "lib/authAdapter": typeof lib_authAdapter;
  "lib/errors": typeof lib_errors;
  "lib/names": typeof lib_names;
  "lib/roles": typeof lib_roles;
  "organizations/model": typeof organizations_model;
  "organizations/mutations": typeof organizations_mutations;
  "organizations/queries": typeof organizations_queries;
  "projects/model": typeof projects_model;
  "projects/mutations": typeof projects_mutations;
  "projects/queries": typeof projects_queries;
  "validators/index": typeof validators_index;
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
