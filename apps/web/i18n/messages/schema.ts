import type {
  archivalStatusValidator,
  auditActionValidator,
  eventStatusValidator,
  fieldDataTypeValidator,
  locationTypeValidator,
  projectStatusValidator,
  recipeStatusValidator,
  recipeVersionStatusValidator,
  relationshipTypeValidator,
  roleValidator,
  SemanticType,
} from '@sancocho/convex/validators';

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
type AuditAction = typeof auditActionValidator.type;

export type MessageSchema = {
  auth: { connecting: string; signedOut: string; profilePending: string; connected: string };
  organizations: { title: string; members: string };
  projects: { title: string; statuses: Record<ProjectStatus, string> };
  fields: {
    title: string;
    dataTypes: Record<FieldDataType, string>;
    statuses: Record<ArchivalStatus, string>;
    semanticTypes: Record<SemanticType, { label: string; description: string }>;
  };
  recipes: { title: string; statuses: Record<RecipeStatus, string>; versionStatuses: Record<RecipeVersionStatus, string> };
  services: { title: string; statuses: Record<EventStatus, string> };
  locations: { title: string; types: Record<LocationType, string> };
  relationships: { title: string; types: Record<RelationshipType, string> };
  stats: { itemsSelected: string; welcome: string };
  chat: { title: string };
  common: { language: string; spanish: string; english: string; save: string; cancel: string };
  errors: { generic: string; notFound: string };
  nav: { home: string; projects: string; services: string; recipes: string; locations: string };
  vocab: { roles: Record<Role, string>; auditActions: Record<AuditAction, string> };
};
