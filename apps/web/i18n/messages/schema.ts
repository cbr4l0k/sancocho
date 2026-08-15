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
import type { StatusShape, StatusTone } from '@/lib/status';

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
  common: { language: string; spanish: string; english: string; save: string; cancel: string; required: string; retry: string; clear: string };
  errors: { generic: string; notFound: string };
  nav: { home: string; projects: string; services: string; recipes: string; locations: string };
  vocab: { roles: Record<Role, string>; auditActions: Record<AuditAction, string> };
  /** Cursor pagination chrome. There is no total, so no "page N of M" string exists. */
  table: { loaded: string; loadMore: string; loadingMore: string; endOfList: string };
  empty: { noRecords: string; noRecordsBody: string; noMatches: string; noMatchesBody: string; unavailable: string };
  home: {
    eyebrow: string;
    title: string;
    lead: string;
    connection: {
      eyebrow: string;
      title: string;
      stateLabel: string;
      states: { connecting: string; signedOut: string; profilePending: string; connected: string };
      frontendLabel: string;
      frontendValue: string;
      localeLabel: string;
    };
    preferences: { eyebrow: string; title: string; description: string };
    reference: {
      eyebrow: string;
      title: string;
      description: string;
      filterLabel: string;
      filterPlaceholder: string;
      filterDescription: string;
      columns: { key: string; label: string; phase: string; disposition: string };
    };
    vocabulary: {
      eyebrow: string;
      title: string;
      description: string;
      groups: { projects: string; recipes: string; recipeVersions: string; services: string; archival: string };
    };
    /** Lifecycle phase, one per marker shape. */
    phases: Record<StatusShape, string>;
    /** Disposition, one per status tone. */
    dispositions: Record<StatusTone, string>;
    patterns: { eyebrow: string; loading: string; empty: string; unavailable: string };
  };
};
