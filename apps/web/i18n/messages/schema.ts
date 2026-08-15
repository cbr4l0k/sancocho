import type {
  archivalStatusValidator,
  eventStatusValidator,
  fieldDataTypeValidator,
  locationTypeValidator,
  projectStatusValidator,
  recipeStatusValidator,
  recipeVersionStatusValidator,
  relationshipTypeValidator,
  roleValidator,
} from '@sancocho/convex/validators';
import type {
  AuditActionMessageKey,
  SemanticTypeMessageKey,
} from '../vocab-keys';
export type TranslationShape<Value> = Value extends string
  ? string
  : Value extends object
    ? { [Key in keyof Value]: TranslationShape<Value[Key]> }
    : never;

type ProjectStatus = typeof projectStatusValidator.type;
type RecipeStatus = typeof recipeStatusValidator.type;
type RecipeVersionStatus = typeof recipeVersionStatusValidator.type;
type EventStatus = typeof eventStatusValidator.type;
type ArchivalStatus = typeof archivalStatusValidator.type;
type Role = typeof roleValidator.type;
type LocationType = typeof locationTypeValidator.type;
type RelationshipType = typeof relationshipTypeValidator.type;
type FieldDataType = typeof fieldDataTypeValidator.type;

export type MessageSchema = {
  auth: {
    connecting: string;
    signedOut: string;
    signedOutTitle: string;
    profilePending: string;
    connected: string;
    signIn: string;
    signUp: string;
    signOut: string;
  };
  organizations: {
    title: string;
    members: string;
    switcherLabel: string;
    chooseOrganization: string;
    createTitle: string;
    createDescription: string;
    nameLabel: string;
    slugLabel: string;
    slugDescription: string;
    createAction: string;
    slugInvalid: string;
    slugTaken: string;
    rosterTitle: string;
    rosterDescription: string;
    memberName: string;
    memberEmail: string;
    memberRole: string;
    noOrganizationTitle: string;
  };
  projects: { title: string; statuses: Record<ProjectStatus, string> };
  fields: {
    title: string;
    dataTypes: Record<FieldDataType, string>;
    statuses: Record<ArchivalStatus, string>;
    semanticTypes: Record<
      SemanticTypeMessageKey,
      { label: string; description: string }
    >;
  };
  recipes: {
    title: string;
    statuses: Record<RecipeStatus, string>;
    versionStatuses: Record<RecipeVersionStatus, string>;
  };
  services: { title: string; statuses: Record<EventStatus, string> };
  locations: { title: string; types: Record<LocationType, string> };
  relationships: { title: string; types: Record<RelationshipType, string> };
  stats: { itemsSelected: string; welcome: string };
  chat: { title: string; eyebrow: string; description: string };
  common: {
    language: string;
    languageDescription: string;
    spanish: string;
    english: string;
    save: string;
    cancel: string;
    required: string;
    retry: string;
    clear: string;
    notAvailable: string;
  };
  errors: { generic: string; notFound: string };
  nav: {
    home: string;
    chat: string;
    projects: string;
    services: string;
    recipes: string;
    locations: string;
    fields: string;
    statistics: string;
    settings: string;
    account: string;
    label: string;
    application: string;
  };
  shell: {
    comingSoonTitle: string;
    comingSoonDescription: string;
    comingSoonBody: string;
  };
  vocab: {
    roles: Record<Role, string>;
    auditActions: Record<AuditActionMessageKey, string>;
  };
  /** Cursor pagination chrome. There is no total, so no "page N of M" string exists. */
  table: {
    loaded: string;
    loadMore: string;
    loadingMore: string;
    endOfList: string;
  };
  empty: {
    noRecords: string;
    noRecordsBody: string;
    noMatches: string;
    noMatchesBody: string;
    unavailable: string;
  };
};
