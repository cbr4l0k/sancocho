import type { TranslationShape } from './schema';
import type esCO from './es-CO';

const enUS = {
  auth: {
    connecting: 'Connecting to Sancocho…',
    signedOut: 'You are not signed in. The Sancocho connection is ready when you are.',
    profilePending: 'Connected to Convex. Your Sancocho user profile is not set up yet.',
    connected: 'Connected to Convex.',
    signIn: 'Sign in',
    signUp: 'Create account',
    signOut: 'Sign out',
  },
  organizations: {
    title: 'Organizations',
    members: '{count, plural, =0 {No members} one {# member} other {# members}}',
    switcherLabel: 'Active organization',
    chooseOrganization: 'Choose an organization',
    createTitle: 'Create your organization',
    createDescription: 'Set up the workspace for your operation.',
    nameLabel: 'Organization name',
    slugLabel: 'Organization identifier',
    slugDescription: 'Use lowercase letters, 3–63 characters, with letters, numbers, and single dashes.',
    createAction: 'Create organization',
    slugInvalid: 'Use a valid identifier: lowercase letters, numbers, and single dashes, 3–63 characters long.',
    slugTaken: 'That identifier is not available. Choose another.',
    rosterTitle: 'Organization members',
    rosterDescription: 'These are the people who currently have access to this organization.',
    memberName: 'Name',
    memberEmail: 'Email',
    memberRole: 'Role',
    noOrganizationTitle: 'You do not have an organization yet',
  },
  projects: { title: 'Projects', statuses: { draft: 'Draft', active: 'Active', completed: 'Completed', archived: 'Archived' } },
  fields: {
    title: 'Fields',
    dataTypes: { text: 'Text', longText: 'Long text', number: 'Number', boolean: 'Yes/no', date: 'Date', datetime: 'Date and time', time: 'Time', select: 'Select', multiSelect: 'Multi-select', location: 'Location' },
    statuses: { active: 'Active', archived: 'Archived' },
    semanticTypes: {
      eventName: { label: 'Service name', description: 'Identifies the operational service.' }, eventDescription: { label: 'Service description', description: 'Provides service operating details.' }, eventDate: { label: 'Service date', description: 'Stores the service calendar date.' }, eventTime: { label: 'Service time', description: 'Stores the scheduled local time.' }, eventLocation: { label: 'Service location', description: 'Associates the service with a location.' },
      'passenger.count': { label: 'Passenger count', description: 'Supports totals and occupancy calculations.' }, 'transport.origin': { label: 'Origin', description: 'Identifies the transport starting point.' }, 'transport.destination': { label: 'Destination', description: 'Identifies the transport arrival point.' }, 'aviation.flightNumber': { label: 'Flight number', description: 'Supports flight tracking.' }, 'luggage.count': { label: 'Luggage count', description: 'Stores the luggage total.' }, 'accessibility.wheelchairCount': { label: 'Wheelchair count', description: 'Identifies accessibility requirements.' }, 'contact.primary': { label: 'Primary contact', description: 'Stores the primary operations contact.' }, 'aviation.terminal': { label: 'Terminal', description: 'Stores the airport terminal.' }, 'general.notes': { label: 'Notes', description: 'Stores operational notes.' },
    },
  },
  recipes: { title: 'Recipes', statuses: { draft: 'Draft', active: 'Active', archived: 'Archived' }, versionStatuses: { draft: 'Draft', published: 'Published', retired: 'Retired' } },
  services: { title: 'Services', statuses: { draft: 'Draft', planned: 'Planned', confirmed: 'Confirmed', active: 'Active', completed: 'Completed', cancelled: 'Cancelled' } },
  locations: { title: 'Locations', types: { airport: 'Airport', hotel: 'Hotel', venue: 'Venue', office: 'Office', station: 'Station', depot: 'Depot', custom: 'Custom' } },
  relationships: { title: 'Relationships', types: { dependsOn: 'Depends on', follows: 'Follows', parentOf: 'Parent of', relatedTo: 'Related to' } },
  stats: { itemsSelected: '{count, plural, =0 {No items selected} one {# item selected} other {# items selected}}', welcome: 'Hello, {name}. Everything is ready to get started.' },
  chat: { title: 'Operations chat' },
  common: { language: 'Language', languageDescription: 'Your choice is stored in a cookie and sets the application route.', spanish: 'Spanish', english: 'English', save: 'Save', cancel: 'Cancel', required: 'Required', retry: 'Retry', clear: 'Clear filter', notAvailable: 'Not available' },
  errors: { generic: 'Something went wrong. Please try again.', notFound: 'The resource was not found or you do not have access.' },
  nav: { home: 'Home', projects: 'Projects', services: 'Services', recipes: 'Recipes', locations: 'Locations' },
  vocab: {
    roles: { owner: 'Owner', admin: 'Administrator', planner: 'Planner', operator: 'Operator', viewer: 'Viewer' },
    auditActions: {
      'organization.created': 'Organization created', 'organization.updated': 'Organization updated', 'membership.created': 'Membership created', 'membership.updated': 'Membership updated', 'membership.removed': 'Membership removed',
      'project.created': 'Project created', 'project.updated': 'Project updated', 'project.archived': 'Project archived', 'fieldDefinition.created': 'Field definition created', 'fieldDefinition.updated': 'Field definition updated', 'fieldDefinition.archived': 'Field definition archived', 'fieldDefinition.deleted': 'Field definition deleted',
      'recipe.created': 'Recipe created', 'recipe.updated': 'Recipe updated', 'recipe.archived': 'Recipe archived', 'recipeVersion.created': 'Recipe version created', 'recipeVersion.published': 'Recipe version published', 'recipeVersion.retired': 'Recipe version retired', 'recipeField.added': 'Recipe field added', 'recipeField.updated': 'Recipe field updated', 'recipeField.removed': 'Recipe field removed', 'recipeVersion.fieldsReordered': 'Recipe fields reordered',
      'event.created': 'Service created', 'event.updated': 'Service updated', 'event.fieldsUpdated': 'Service fields updated', 'event.statusChanged': 'Service status updated', 'event.cancelled': 'Service cancelled',
      'location.created': 'Location created', 'location.updated': 'Location updated', 'location.archived': 'Location archived', 'location.deleted': 'Location deleted', 'relationship.created': 'Relationship created', 'relationship.removed': 'Relationship removed',
    },
  },
  table: {
    loaded: '{count, plural, =0 {No records loaded} one {# record loaded} other {# records loaded}}',
    loadMore: 'Load more',
    loadingMore: 'Loading…',
    endOfList: 'End of list',
  },
  empty: {
    noRecords: 'No records yet',
    noRecordsBody: 'The first one will show up in this list as soon as it is created.',
    noMatches: 'No records match the filter',
    noMatchesBody: 'Adjust or clear the filter to see more results.',
    unavailable: 'Content unavailable',
  },
} as const satisfies TranslationShape<typeof esCO>;

export default enUS;
