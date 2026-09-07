import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { query } from '../_generated/server';
import { serviceFieldValueValidator, fieldConfigValidator, paginatedResult, serviceKindDocValidator, serviceKindVersionStatusValidator } from '../validators';
import { getServiceKind as getServiceKindModel, getServiceKindVersion as getServiceKindVersionModel, listPublishedServiceKinds as listPublishedServiceKindsModel, listServiceKinds as listServiceKindsModel } from './model';

const serviceKindDoc = serviceKindDocValidator;
const versionDoc = v.object({ _id: v.id('serviceKindVersions'), _creationTime: v.number(), organizationId: v.id('organizations'), serviceKindId: v.id('serviceKinds'), versionNumber: v.number(), status: serviceKindVersionStatusValidator, publishedAt: v.optional(v.number()) });
const serviceKindFieldDoc = v.object({ _id: v.id('serviceKindFields'), _creationTime: v.number(), organizationId: v.id('organizations'), serviceKindVersionId: v.id('serviceKindVersions'), fieldDefinitionId: v.id('fieldDefinitions'), position: v.number(), required: v.boolean(), visible: v.boolean(), defaultValue: v.optional(serviceFieldValueValidator), defaultLocationId: v.optional(v.id('locations')), config: fieldConfigValidator });
const paginatedServiceKinds = paginatedResult(serviceKindDoc);
const publishedServiceKindPickerRow = v.object({
  serviceKind: serviceKindDoc,
  publishedVersion: v.object({ _id: v.id('serviceKindVersions'), versionNumber: v.number(), publishedAt: v.optional(v.number()) }),
});
const paginatedPublishedServiceKinds = paginatedResult(publishedServiceKindPickerRow);

export const getServiceKind = query({ args: { serviceKindId: v.id('serviceKinds') }, returns: v.object({ serviceKind: serviceKindDoc, versions: v.array(versionDoc) }), handler: (ctx, args) => getServiceKindModel(ctx, args.serviceKindId) });
export const listServiceKinds = query({ args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator }, returns: paginatedServiceKinds, handler: (ctx, args) => listServiceKindsModel(ctx, args.organizationId, args.paginationOpts) });
export const listPublishedServiceKinds = query({ args: { organizationId: v.id('organizations'), paginationOpts: paginationOptsValidator }, returns: paginatedPublishedServiceKinds, handler: (ctx, args) => listPublishedServiceKindsModel(ctx, args.organizationId, args.paginationOpts) });
export const getServiceKindVersion = query({ args: { serviceKindVersionId: v.id('serviceKindVersions') }, returns: v.object({ version: versionDoc, serviceKindFields: v.array(serviceKindFieldDoc) }), handler: (ctx, args) => getServiceKindVersionModel(ctx, args.serviceKindVersionId) });
