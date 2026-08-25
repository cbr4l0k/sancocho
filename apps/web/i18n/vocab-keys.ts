import type { auditActionValidator, SemanticType } from '@sancocho/convex/validators';

type AuditAction = typeof auditActionValidator.type;

/** Message keys may not contain '.', which next-intl reserves for nesting. */
export const semanticTypeMessageKey = {
  eventName: 'eventName',
  eventDescription: 'eventDescription',
  eventDate: 'eventDate',
  eventTime: 'eventTime',
  eventLocation: 'eventLocation',
  'passenger.count': 'passenger_count',
  'transport.origin': 'transport_origin',
  'transport.destination': 'transport_destination',
  'aviation.flightNumber': 'aviation_flightNumber',
  'luggage.count': 'luggage_count',
  'accessibility.wheelchairCount': 'accessibility_wheelchairCount',
  'contact.primary': 'contact_primary',
  'aviation.terminal': 'aviation_terminal',
  'general.notes': 'general_notes',
} as const satisfies Record<SemanticType, string>;

export type SemanticTypeMessageKey = (typeof semanticTypeMessageKey)[SemanticType];

/** Message keys may not contain '.', which next-intl reserves for nesting. */
export const auditActionMessageKey = {
  'organization.created': 'organization_created',
  'organization.updated': 'organization_updated',
  'membership.created': 'membership_created',
  'membership.updated': 'membership_updated',
  'membership.removed': 'membership_removed',
  'project.created': 'project_created',
  'project.updated': 'project_updated',
  'project.archived': 'project_archived',
  'fieldDefinition.created': 'fieldDefinition_created',
  'fieldDefinition.updated': 'fieldDefinition_updated',
  'fieldDefinition.archived': 'fieldDefinition_archived',
  'fieldDefinition.deleted': 'fieldDefinition_deleted',
  'recipe.created': 'recipe_created',
  'recipe.updated': 'recipe_updated',
  'recipe.archived': 'recipe_archived',
  'recipeVersion.created': 'recipeVersion_created',
  'recipeVersion.published': 'recipeVersion_published',
  'recipeVersion.retired': 'recipeVersion_retired',
  'recipeField.added': 'recipeField_added',
  'recipeField.updated': 'recipeField_updated',
  'recipeField.removed': 'recipeField_removed',
  'recipeVersion.fieldsReordered': 'recipeVersion_fieldsReordered',
  'event.created': 'event_created',
  'event.updated': 'event_updated',
  'event.fieldsUpdated': 'event_fieldsUpdated',
  'event.statusChanged': 'event_statusChanged',
  'event.cancelled': 'event_cancelled',
  'location.created': 'location_created',
  'location.updated': 'location_updated',
  'location.archived': 'location_archived',
  'location.deleted': 'location_deleted',
  'relationship.created': 'relationship_created',
  'relationship.removed': 'relationship_removed',
  'organization.statisticsBackfilled': 'organization_statisticsBackfilled',
  'invitation.created': 'invitation_created',
  'invitation.revoked': 'invitation_revoked',
  'invitation.accepted': 'invitation_accepted',
} as const satisfies Record<AuditAction, string>;

export type AuditActionMessageKey = (typeof auditActionMessageKey)[AuditAction];
