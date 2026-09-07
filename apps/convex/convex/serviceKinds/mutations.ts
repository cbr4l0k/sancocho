import { v } from 'convex/values';

import { mutation } from '../_generated/server';
import { archiveServiceKind as archiveServiceKindModel, clonePublishedVersionToDraft as clonePublishedVersionToDraftModel, createInitialDraftVersion as createInitialDraftVersionModel, createServiceKind as createServiceKindModel, publishServiceKindVersion as publishServiceKindVersionModel, updateServiceKindMetadata as updateServiceKindMetadataModel } from './model';

export const createServiceKind = mutation({ args: { organizationId: v.id('organizations'), key: v.string(), name: v.string(), description: v.optional(v.string()) }, returns: v.id('serviceKinds'), handler: (ctx, args) => createServiceKindModel(ctx, args) });
export const updateServiceKindMetadata = mutation({ args: { serviceKindId: v.id('serviceKinds'), name: v.optional(v.string()), description: v.optional(v.string()) }, returns: v.null(), handler: async (ctx, { serviceKindId, ...patch }) => { await updateServiceKindMetadataModel(ctx, serviceKindId, patch); return null; } });
export const archiveServiceKind = mutation({ args: { serviceKindId: v.id('serviceKinds') }, returns: v.null(), handler: async (ctx, args) => { await archiveServiceKindModel(ctx, args.serviceKindId); return null; } });
export const createInitialDraftVersion = mutation({ args: { serviceKindId: v.id('serviceKinds') }, returns: v.id('serviceKindVersions'), handler: (ctx, args) => createInitialDraftVersionModel(ctx, args.serviceKindId) });
export const clonePublishedVersionToDraft = mutation({ args: { serviceKindId: v.id('serviceKinds') }, returns: v.id('serviceKindVersions'), handler: (ctx, args) => clonePublishedVersionToDraftModel(ctx, args.serviceKindId) });
export const publishServiceKindVersion = mutation({ args: { serviceKindVersionId: v.id('serviceKindVersions') }, returns: v.null(), handler: async (ctx, args) => { await publishServiceKindVersionModel(ctx, args.serviceKindVersionId); return null; } });
