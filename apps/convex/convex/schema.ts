import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

import {
  archivalStatusValidator,
  auditActionValidator,
  auditEntityTypeValidator,
  auditMetadataValidator,
  eventFieldValueValidator,
  eventStatusValidator,
  fieldConfigValidator,
  fieldDefinitionFields,
  recipeStatusValidator,
  recipeVersionStatusValidator,
  projectFields,
  relationshipTypeValidator,
  roleValidator,
} from './validators';

/**
 * Uniqueness is an indexed read-before-write in one mutation. As described in
 * docs/architecture-review.md §10, Convex serializable OCC retries conflicting
 * mutations, so the retried read observes the winning write without needing locks.
 *
 * Every denormalized column (organizationId everywhere, events.recipeId,
 * eventFieldValues.locationId) is derived server-side from the stored entity
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
  // validator are built from the same definition.
  projects: defineTable(projectFields).index('by_org', ['organizationId']),

  // Field shape lives in validators/ so the table and the public `returns`
  // validator are built from the same definition.
  fieldDefinitions: defineTable(fieldDefinitionFields)
    .index('by_org_key', ['organizationId', 'key'])
    .index('by_org', ['organizationId']),

  eventRecipes: defineTable({
    organizationId: v.id('organizations'),
    key: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    status: recipeStatusValidator,
  })
    .index('by_org_key', ['organizationId', 'key'])
    .index('by_org', ['organizationId']),

  recipeVersions: defineTable({
    organizationId: v.id('organizations'),
    recipeId: v.id('eventRecipes'),
    versionNumber: v.number(),
    status: recipeVersionStatusValidator,
  })
    .index('by_recipe_version', ['recipeId', 'versionNumber'])
    .index('by_recipe_status', ['recipeId', 'status']),

  recipeFields: defineTable({
    organizationId: v.id('organizations'),
    recipeVersionId: v.id('recipeVersions'),
    fieldDefinitionId: v.id('fieldDefinitions'),
    position: v.number(),
    required: v.boolean(),
    visible: v.boolean(),
    defaultValue: v.optional(eventFieldValueValidator),
    // Snapshot of the field's config (data type, rules, options), taken when the
    // row is composed into a DRAFT version — so a draft may narrow the definition
    // (tighter bounds, a subset of options) for this recipe. Publishing validates
    // the snapshot's coherence instead of overwriting it: same config kind as the
    // definition, and select options still a subset of the definition's. From
    // publish onward the snapshot is immutable, and historical event validation
    // reads ONLY it, never the live fieldDefinition (I3).
    config: fieldConfigValidator,
  })
    .index('by_version_field', ['recipeVersionId', 'fieldDefinitionId'])
    .index('by_version', ['recipeVersionId'])
    // Supports "is this field definition referenced by any (published)
    // version?" for the immutability trigger and protected deletes.
    .index('by_field', ['fieldDefinitionId']),

  events: defineTable({
    organizationId: v.id('organizations'),
    projectId: v.id('projects'),
    // Derived from recipeVersionId server-side (I4); never client-supplied.
    recipeId: v.id('eventRecipes'),
    recipeVersionId: v.id('recipeVersions'),
    name: v.string(),
    status: eventStatusValidator,
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
  })
    .index('by_project', ['projectId'])
    .index('by_project_startsAt', ['projectId', 'startsAt'])
    .index('by_org_startsAt', ['organizationId', 'startsAt'])
    .index('by_recipe', ['recipeId'])
    .index('by_recipeVersion', ['recipeVersionId']),

  eventFieldValues: defineTable({
    organizationId: v.id('organizations'),
    eventId: v.id('events'),
    recipeFieldId: v.id('recipeFields'),
    fieldDefinitionId: v.id('fieldDefinitions'),
    value: eventFieldValueValidator,
    // Mirror of value.locationId when kind === 'location' (server-derived);
    // gives locations an indexed reference check before archival/deletion.
    locationId: v.optional(v.id('locations')),
  })
    .index('by_event_field', ['eventId', 'fieldDefinitionId'])
    .index('by_field', ['fieldDefinitionId'])
    .index('by_location', ['locationId']),

  locations: defineTable({
    organizationId: v.id('organizations'),
    name: v.string(),
    address: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    status: archivalStatusValidator,
  }).index('by_org', ['organizationId']),

  eventRelationships: defineTable({
    organizationId: v.id('organizations'),
    sourceEventId: v.id('events'),
    targetEventId: v.id('events'),
    type: relationshipTypeValidator,
  })
    .index('by_source_target_type', ['sourceEventId', 'targetEventId', 'type'])
    .index('by_target', ['targetEventId']),

  auditEvents: defineTable({
    organizationId: v.id('organizations'),
    actorUserId: v.id('users'),
    action: auditActionValidator,
    entityType: auditEntityTypeValidator,
    entityId: v.string(),
    metadata: auditMetadataValidator,
  })
    .index('by_org', ['organizationId'])
    .index('by_org_entity', ['organizationId', 'entityType', 'entityId']),
});
