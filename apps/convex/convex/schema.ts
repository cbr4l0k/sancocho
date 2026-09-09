import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

import {
  archivalStatusValidator,
  assignmentFields,
  assignmentRevisionFields,
  auditEventFields,
  costCentreFields,
  serviceFieldValueValidator,
  serviceFields,
  serviceStatusValidator,
  fieldConfigValidator,
  eventFields,
  fieldDefinitionFields,
  locationFields,
  providerAccessGrantFields,
  providerFields,
  rateCardFields,
  rateCardVersionFields,
  rateLineFields,
  fleetVehicleFields,
  vehicleClassFields,
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

  events: defineTable(eventFields)
    .index('by_project_startsAt', ['projectId', 'startsAt'])
    // Both reverse-reference indexes below exist for exactly one reason each: a
    // first-hit "is this row still referenced by an Event?" read taken before
    // the referenced row is removed or re-typed. Without them the same guard
    // would be a full scan of the events table, so the guarded door's cost
    // would grow with the tenant. No list surface reads through either.
    //
    // Serves `locations/model.ts` deleteLocation and updateLocation.
    .index('by_venueLocation', ['venueLocationId'])
    // Serves `costCentres/model.ts` deleteCostCentre.
    .index('by_clientCostCentre', ['clientCostCentreId']),
    // There is deliberately NO by_accountableUser index: `removeMember` does
    // not guard on accountability (see organizations/model.ts), so such an
    // index would have no consumer, and an unused index is write amplification.

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
    .index('by_event_startsAt', ['eventId', 'startsAt'])
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

  costCentres: defineTable(costCentreFields)
    // Enforces organization-scoped key uniqueness through a same-mutation read.
    .index('by_org_key', ['organizationId', 'key'])
    // Serves the unfiltered organization catalogue.
    .index('by_org', ['organizationId'])
    // Serves status-filtered lists before pagination.
    .index('by_org_status', ['organizationId', 'status'])
    // Serves name search, optionally narrowed by archival status.
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['organizationId', 'status'],
    }),

  // The coordinator-owned Providers directory (#64). Shape (b) of
  // docs/provider-access.md: this row is the coordinator's record of an
  // external firm, and `linkedOrganizationId` is the single, #86-owned edge to
  // that firm's own Organization.
  providers: defineTable(providerFields)
    // Enforces organization-scoped, CASE-NORMALISED name uniqueness through a
    // same-mutation read. `searchText` is the normalised form of `name`
    // (`normalizeSearchText`: trimmed, case-folded, diacritic-folded,
    // punctuation collapsed), so this index IS the name key — there is no
    // second normalised column to drift from the one search reads.
    .index('by_org_searchText', ['organizationId', 'searchText'])
    // Serves the unfiltered organization catalogue in creation order, matching
    // the locations and costCentres catalogues.
    .index('by_org', ['organizationId'])
    // Serves status-filtered lists before pagination, never after.
    .index('by_org_status', ['organizationId', 'status'])
    // Serves name search, optionally narrowed by archival status.
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['organizationId', 'status'],
    }),
    // There is deliberately NO by_linkedOrganization index yet: nothing reads
    // Providers by the organization they are linked to. The delete guard reads
    // the link off the Provider row it already holds. #86 (claim/revocation)
    // and #71 (grants) add the reverse index when they add its first consumer;
    // an index without one is pure write amplification.

  // The SECOND principal arm's stored proof (#71, docs/provider-access.md shape
  // (b)). One row = "this claimed Provider may reach this one Project, and
  // nothing else". Resolved on EVERY call by `requirePrincipalForProject` in
  // lib/access.ts, which is the only place in the codebase that turns a row here
  // into a capability; nothing is cached, so revocation bites on the next call.
  providerAccessGrants: defineTable(providerAccessGrantFields)
    // THE uniqueness key: one grant per (Provider, Project), enforced by an
    // indexed read-before-write inside `grantProjectAccessToProvider`. A
    // re-grant after revocation reactivates this row rather than inserting a
    // second one, so a Provider can never accumulate two grants on one Project
    // and no resolution path has to decide which of them wins.
    .index('by_provider_project', ['providerId', 'projectId'])
    // THE resolution index, read only by the one gate. Keyed from the PROVIDER
    // ORGANIZATION side because that is the side the caller proves: the gate
    // holds a signed-in user, walks their own memberships, and asks each of
    // their organizations "do you hold a grant on this project?". The
    // `projectId` component IS the project equality check — a grant for Project
    // A is not in the range read for Project B — which is why there is no
    // redundant column comparison afterwards to drift from it.
    .index('by_providerOrganization_project', ['providerOrganizationId', 'projectId'])
    // Serves the coordinator's own paginated list of who it has let in (I6).
    // Deliberately keyed by the granting organization AND project so a member
    // can never page another tenant's grants by supplying a foreign project id.
    .index('by_org_project', ['organizationId', 'projectId']),

  // Coordinator-authored Provider terms. The current-version pointer is
  // advanced or cleared only by the version lifecycle transaction.
  rateCards: defineTable(rateCardFields)
    // Serves the member-only paginated catalogue.
    .index('by_org', ['organizationId'])
    // Serves Provider deletion's first-hit reverse-reference guard. Archived
    // cards count because their immutable commercial history still points at
    // the Provider.
    .index('by_org_provider', ['organizationId', 'providerId']),

  rateCardVersions: defineTable(rateCardVersionFields)
    // Serves gapless server numbering and bounded history reads.
    .index('by_card_version', ['rateCardId', 'versionNumber'])
    // Serves the at-most-one draft/published probes and lifecycle transitions.
    .index('by_card_status', ['rateCardId', 'status']),

  rateLines: defineTable(rateLineFields)
    // Serves the bounded version child-set read used by clone, publish and get.
    .index('by_version', ['rateCardVersionId'])
    // Serves uniqueness and the sole resolveRate point lookup.
    .index('by_version_class_modality', ['rateCardVersionId', 'vehicleClassId', 'modality'])
    // Serves Vehicle Class deletion's first-hit reverse-reference guard.
    .index('by_org_class', ['organizationId', 'vehicleClassId']),

  // Stable demand-to-supply identity. Terms are snapshots in the child table.
  assignments: defineTable(assignmentFields)
    // Bounded Service child list and same-Service position uniqueness.
    .index('by_service_position', ['serviceId', 'position'])
    // Member Project list; unbounded, therefore always paginated.
    .index('by_project_position', ['projectId', 'position'])
    // Provider-principal Project list without reading another Provider's rows.
    .index('by_project_provider_position', ['projectId', 'providerId', 'position'])
    // Provider deletion's indexed first-hit reverse-reference guard.
    .index('by_org_provider', ['organizationId', 'providerId']),

  // Every proposal and agreement is retained as an immutable commercial row.
  assignmentRevisions: defineTable(assignmentRevisionFields)
    // Server numbering and ordered negotiation history.
    .index('by_assignment_revision', ['assignmentId', 'revisionNumber'])
    // The at-most-one-accepted probe and lifecycle transitions.
    .index('by_assignment_status', ['assignmentId', 'status'])
    // Protected-reference first-hit guards.
    .index('by_org_vehicleClass', ['organizationId', 'vehicleClassId'])
    .index('by_rateCardVersion', ['rateCardVersionId']),

  // The coordinator-owned Vehicle Class catalogue (#65): what is planned and
  // priced. Tenant-authored, never a code-owned enum.
  vehicleClasses: defineTable(vehicleClassFields)
    // Enforces organization-scoped key uniqueness through a same-mutation read,
    // and is the same index `provisionStarterVehicleClasses` probes to skip a
    // key a tenant already has.
    .index('by_org_key', ['organizationId', 'key'])
    // Serves the unfiltered organization catalogue in creation order.
    .index('by_org', ['organizationId'])
    // Serves status-filtered lists before pagination, never after.
    .index('by_org_status', ['organizationId', 'status'])
    // Serves key-or-name search, optionally narrowed by archival status.
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['organizationId', 'status'],
    }),

  // The coordinator-owned Fleet Vehicle catalogue (#65): the plate that arrives.
  // These rows stay in the COORDINATOR's organization and belong to its Provider
  // reference row; the provider firm gets scoped grants (#71), not a catalogue.
  fleetVehicles: defineTable(fleetVehicleFields)
    // THE uniqueness key: normalised `organizationId + plate`, enforced by an
    // indexed read-before-write inside the create and update mutations. It reads
    // `plateKey` (server-derived) rather than `plate`, so `ABC 123`, `abc-123`
    // and `  abc123  ` collide as they must while the display value survives.
    .index('by_org_plateKey', ['organizationId', 'plateKey'])
    // Serves the unfiltered organization catalogue in creation order.
    .index('by_org', ['organizationId'])
    // Serves the status-only filter.
    .index('by_org_status', ['organizationId', 'status'])
    // Serves the Provider filter, with or without a status narrowing on the same
    // index. Its (organizationId, providerId) PREFIX is also the first-hit
    // reverse-reference read `deleteProvider` takes before destroying a Provider
    // — which is why no separate `by_provider` index exists: the Provider row
    // already carries the organizationId that completes this key.
    .index('by_org_provider_status', ['organizationId', 'providerId', 'status'])
    // Serves the Class filter, with or without a status narrowing. Its
    // (organizationId, vehicleClassId) prefix is likewise the first-hit read
    // `deleteVehicleClass` takes before destroying a class.
    .index('by_org_class_status', ['organizationId', 'vehicleClassId', 'status'])
    // Serves BOTH filters at once. A prefix of one of the two indexes above
    // cannot answer this, and answering it by filtering an already-paginated
    // page would return short pages and make `numItems` a lie (I6).
    .index('by_org_provider_class_status', ['organizationId', 'providerId', 'vehicleClassId', 'status'])
    // Serves plate-or-label search, narrowed by the same three filters through
    // the index rather than after the page is fetched.
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['organizationId', 'providerId', 'vehicleClassId', 'status'],
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
