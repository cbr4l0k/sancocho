import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

import {
  archivalStatusValidator,
  auditEventFields,
  serviceFieldValueValidator,
  serviceFields,
  serviceStatusValidator,
  fieldConfigValidator,
  fieldDefinitionFields,
  locationFields,
  organizationInvitationFields,
  serviceKindFields,
  serviceKindVersionStatusValidator,
  projectFields,
  projectStatusValidator,
  relationshipTypeValidator,
  roleValidator,
} from './validators';

/**
 * Uniqueness is an indexed read-before-write in one mutation. As described in
 * docs/architecture-review.md §10, Convex serializable OCC retries conflicting
 * mutations, so the retried read observes the winning write without needing locks.
 *
 * Every denormalized column (organizationId everywhere, services.serviceKindId,
 * serviceFieldValues.locationId) is derived server-side from the stored entity
 * graph in the same mutation (I4) — never accepted from client args.
 */

export default defineSchema({
  users: defineTable({
    authProvider: v.string(),
    authSubject: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  }).index('by_provider_subject', ['authProvider', 'authSubject']),

  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
  }).index('by_slug', ['slug']),

  organizationMemberships: defineTable({
    organizationId: v.id('organizations'),
    userId: v.id('users'),
    role: roleValidator,
  })
    .index('by_org_user', ['organizationId', 'userId'])
    .index('by_user', ['userId']),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition (issue #56). An invitation
  // is addressed to `email`, never a user id — nothing here is ever produced
  // by looking a user up by address (I9).
  organizationInvitations: defineTable(organizationInvitationFields)
    // Uniqueness = indexed read-before-write on (org, email, status) inside
    // `createInvitation`: one open (`pending`) invitation per address per
    // org. The status column is part of the key so a resolved invitation
    // (accepted/revoked/expired) never blocks re-inviting the same address.
    .index('by_org_email_status', ['organizationId', 'email', 'status'])
    // Serves the org's own pending-invitation list (I6, paginated).
    .index('by_org_status', ['organizationId', 'status'])
    // Serves the caller's own pending invitations, keyed by their verified
    // email (I6, paginated) — the recipient-facing accept surface.
    .index('by_email_status', ['email', 'status']),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition.
  projects: defineTable(projectFields)
    .index('by_org', ['organizationId'])
    // Serves the organization-scoped project status list without filtering an
    // already-paginated result set.
    .index('by_org_status', ['organizationId', 'status']),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition.
  fieldDefinitions: defineTable(fieldDefinitionFields)
    .index('by_org_key', ['organizationId', 'key'])
    .index('by_org', ['organizationId'])
    // Serves `fields/model.ts` `assertSemanticTypeCapacity`: a targeted,
    // indexed read of exactly the (organizationId, semanticType) pair a caller
    // wants, so resolving which fields are bound to one semantic type costs
    // O(the number of fields actually bound to it), never O(every field
    // definition in the organization). The alternative is an unrestricted
    // `.collect()` over the whole organization's field catalogue (I6:
    // `fieldDefinitions` is exactly the kind of table `listFieldDefinitions`
    // already paginates for the same reason — tenant-configured, not a
    // bounded child set).
    .index('by_org_semantic', ['organizationId', 'semanticType'])
    // Serves key-or-label search within one organization, including the
    // deployment-wide built-in scope represented by organizationId undefined.
    .searchIndex('search_text', { searchField: 'searchText', filterFields: ['organizationId'] }),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition.
  serviceKinds: defineTable(serviceKindFields)
    .index('by_org_key', ['organizationId', 'key'])
    .index('by_org', ['organizationId']),

  serviceKindVersions: defineTable({
    organizationId: v.id('organizations'),
    serviceKindId: v.id('serviceKinds'),
    versionNumber: v.number(),
    status: serviceKindVersionStatusValidator,
    // Older published versions have no truthful publish time: leaving this
    // optional distinguishes that absence from a known publication instant.
    publishedAt: v.optional(v.number()),
  })
    .index('by_serviceKind_version', ['serviceKindId', 'versionNumber'])
    .index('by_serviceKind_status', ['serviceKindId', 'status'])
    // `listPublishedServiceKinds` starts from current published versions: publication
    // is the selective fact that guarantees a picker row has a usable version,
    // without an N+1 probe across every serviceKind in the organization.
    .index('by_org_status', ['organizationId', 'status']),

  serviceKindFields: defineTable({
    organizationId: v.id('organizations'),
    serviceKindVersionId: v.id('serviceKindVersions'),
    fieldDefinitionId: v.id('fieldDefinitions'),
    position: v.number(),
    required: v.boolean(),
    visible: v.boolean(),
    defaultValue: v.optional(serviceFieldValueValidator),
    // Mirror of defaultValue.locationId when kind === 'location', derived
    // server-side from the value beside it and never client-supplied (I4).
    // Gives locations an indexed reference check over configuration defaults,
    // so a location a published (immutable) version defaults to can never be
    // deleted out from under it. Every write path to `defaultValue` MUST set
    // this column through `locationIdFromValue` in fields/values.ts.
    defaultLocationId: v.optional(v.id('locations')),
    // Snapshot of the field's config (data type, rules, options), taken when the
    // row is composed into a DRAFT version — so a draft may narrow the definition
    // (tighter bounds, a subset of options) for this serviceKind. Publishing validates
    // the snapshot's coherence instead of overwriting it: same config kind, narrowing-
    // only bounds, and select options still a subset of the definition's. From
    // publish onward the snapshot is immutable, and historical service validation
    // reads ONLY it, never the live fieldDefinition (I3).
    config: fieldConfigValidator,
  })
    .index('by_version_field', ['serviceKindVersionId', 'fieldDefinitionId'])
    .index('by_version', ['serviceKindVersionId'])
    // Supports "is this field definition referenced by any (published)
    // version?" for the immutability trigger and protected deletes.
    .index('by_field', ['fieldDefinitionId'])
    // Supports the first-hit "is this location referenced by any serviceKind field
    // default?" guard in locations/model.ts deleteLocation.
    .index('by_defaultLocation', ['defaultLocationId']),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition. `serviceKindId` is derived from
  // `serviceKindVersionId` server-side (I4); never client-supplied.
  services: defineTable(serviceFields)
    .index('by_project', ['projectId'])
    .index('by_project_startsAt', ['projectId', 'startsAt'])
    .index('by_org_startsAt', ['organizationId', 'startsAt'])
    // Serves status-restricted, bounded window reads of the service list: such a
    // read must never fall back to reading every service in the window and
    // filtering client-side (that reintroduces the exact I6 problem the index
    // exists to avoid), so status is indexed alongside org and start time and
    // each included status is queried as its own bounded range.
    .index('by_org_status_startsAt', ['organizationId', 'status', 'startsAt'])
    // Mirrors `by_org_status_startsAt` for the project-scoped filter case: the
    // identical bounded, per-status range-read shape when the caller supplies a
    // `projectId` filter. A project is already proven to belong to the caller's
    // organization before this index is ever queried, so no organizationId
    // column is needed in the key.
    .index('by_project_status_startsAt', ['projectId', 'status', 'startsAt'])
    .index('by_serviceKind', ['serviceKindId'])
    .index('by_serviceKindVersion', ['serviceKindVersionId']),

  serviceFieldValues: defineTable({
    organizationId: v.id('organizations'),
    serviceId: v.id('services'),
    serviceKindFieldId: v.id('serviceKindFields'),
    fieldDefinitionId: v.id('fieldDefinitions'),
    value: serviceFieldValueValidator,
    // Mirror of value.locationId when kind === 'location' (server-derived);
    // gives locations an indexed reference check before archival/deletion.
    // Every write path to `value` MUST set this column through
    // `locationIdFromValue` in fields/values.ts — see its doc comment. Issue
    // #10 owns the first (and so far only) writer of this table.
    locationId: v.optional(v.id('locations')),
  })
    .index('by_service_field', ['serviceId', 'fieldDefinitionId'])
    .index('by_field', ['fieldDefinitionId'])
    .index('by_location', ['locationId']),

  locations: defineTable(locationFields)
    // Serves the unchanged unfiltered organization catalogue list.
    .index('by_org', ['organizationId'])
    // Serves the unsearched organization-and-type catalogue list when status
    // is absent; type cannot be a prefix of the status-first index below.
    .index('by_org_type', ['organizationId', 'type'])
    // Serves unsearched organization-and-status lists, with an optional type
    // equality on the same index; neither case needs a post-index filter.
    .index('by_org_status_type', ['organizationId', 'status', 'type'])
    // Serves name search scoped to a tenant and optionally narrowed by the
    // code-owned type and archival status filters.
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['organizationId', 'type', 'status'],
    }),

  serviceRelationships: defineTable({
    organizationId: v.id('organizations'),
    sourceServiceId: v.id('services'),
    targetServiceId: v.id('services'),
    type: relationshipTypeValidator,
  })
    .index('by_source_target_type', ['sourceServiceId', 'targetServiceId', 'type'])
    .index('by_target', ['targetServiceId']),

  // Audit is append-only: domain mutations write rows transactionally through
  // audit/model.ts; no public audit mutation can update or delete them.
  auditEvents: defineTable(auditEventFields)
    .index('by_org', ['organizationId'])
    .index('by_org_entity', ['organizationId', 'entityType', 'entityId']),
});
