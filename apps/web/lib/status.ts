import type {
  archivalStatusValidator,
  serviceStatusValidator,
  projectStatusValidator,
  serviceKindStatusValidator,
  serviceKindVersionStatusValidator,
} from '@priamo/convex/validators';

/**
 * Status presentation, mapped by key.
 *
 * The catalogues own the words; this module owns the two visual axes:
 *
 * - `shape` encodes the **lifecycle phase**. It is the colour-blind-safe channel
 *   and is deliberately shared across sets: a hollow ring means "provisional"
 *   whether the thing is a project, a service kind, a version or a service.
 * - `tone` encodes the **disposition** — how the operator should feel about it.
 *   `completed` and `archived` are both terminal (square), but one is teal and
 *   the other is grey.
 *
 * Every map below is an exhaustive `Record` keyed off the backend union, so a
 * status added in `apps/convex/convex/validators/index.ts` fails `tsc` here
 * instead of shipping an uncoloured chip. Nothing in the UI switches on a raw
 * string: components take the token, never the literal.
 */

/** Lifecycle phase. Redundant with tone so colour is never the only signal. */
export type StatusShape =
  /** Provisional — exists, but nobody has committed to it. */
  | 'ring'
  /** Scheduled — on the board, awaiting confirmation. */
  | 'bar'
  /** Committed — agreed and locked in. */
  | 'diamond'
  /** Live and normal — the ordinary working state. */
  | 'dot'
  /** Under way right now. */
  | 'pulse'
  /** Terminal — nothing further will happen. */
  | 'square'
  /** Void — deliberately called off. */
  | 'cross';

/** Disposition. Each maps to exactly one `--sc-tone-*` custom property. */
export type StatusTone = 'mute' | 'hold' | 'go' | 'live' | 'done' | 'stop' | 'shelf';

export type ProjectStatus = typeof projectStatusValidator.type;
export type ServiceKindStatus = typeof serviceKindStatusValidator.type;
export type ServiceKindVersionStatus = typeof serviceKindVersionStatusValidator.type;
export type ServiceStatus = typeof serviceStatusValidator.type;
export type ArchivalStatus = typeof archivalStatusValidator.type;

/**
 * The catalogue paths for the localized labels. Spelling them out as a union
 * means the chip passes a literal to `t()` — no key is ever assembled by string
 * concatenation, and a renamed catalogue group breaks the build here.
 */
export type StatusLabelKey =
  | `projects.statuses.${ProjectStatus}`
  | `serviceKinds.statuses.${ServiceKindStatus}`
  | `serviceKinds.versionStatuses.${ServiceKindVersionStatus}`
  | `services.statuses.${ServiceStatus}`
  | `fields.statuses.${ArchivalStatus}`;

/** Everything the interface needs to render one status, resolved by key. */
export type StatusToken = {
  tone: StatusTone;
  shape: StatusShape;
  labelKey: StatusLabelKey;
};

export const projectStatusTokens = {
  draft: { tone: 'mute', shape: 'ring', labelKey: 'projects.statuses.draft' },
  active: { tone: 'go', shape: 'dot', labelKey: 'projects.statuses.active' },
  completed: { tone: 'done', shape: 'square', labelKey: 'projects.statuses.completed' },
  archived: { tone: 'shelf', shape: 'square', labelKey: 'projects.statuses.archived' },
} as const satisfies Record<ProjectStatus, StatusToken>;

export const serviceKindStatusTokens = {
  draft: { tone: 'mute', shape: 'ring', labelKey: 'serviceKinds.statuses.draft' },
  active: { tone: 'go', shape: 'dot', labelKey: 'serviceKinds.statuses.active' },
  archived: { tone: 'shelf', shape: 'square', labelKey: 'serviceKinds.statuses.archived' },
} as const satisfies Record<ServiceKindStatus, StatusToken>;

export const serviceKindVersionStatusTokens = {
  draft: { tone: 'mute', shape: 'ring', labelKey: 'serviceKinds.versionStatuses.draft' },
  published: { tone: 'go', shape: 'dot', labelKey: 'serviceKinds.versionStatuses.published' },
  retired: { tone: 'shelf', shape: 'square', labelKey: 'serviceKinds.versionStatuses.retired' },
} as const satisfies Record<ServiceKindVersionStatus, StatusToken>;

/** Backend `Service`; the interface calls it a Service. */
export const serviceStatusTokens = {
  draft: { tone: 'mute', shape: 'ring', labelKey: 'services.statuses.draft' },
  planned: { tone: 'hold', shape: 'bar', labelKey: 'services.statuses.planned' },
  confirmed: { tone: 'go', shape: 'diamond', labelKey: 'services.statuses.confirmed' },
  active: { tone: 'live', shape: 'pulse', labelKey: 'services.statuses.active' },
  completed: { tone: 'done', shape: 'square', labelKey: 'services.statuses.completed' },
  cancelled: { tone: 'stop', shape: 'cross', labelKey: 'services.statuses.cancelled' },
} as const satisfies Record<ServiceStatus, StatusToken>;

/** Shared by field definitions and locations, which archive rather than delete. */
export const archivalStatusTokens = {
  active: { tone: 'go', shape: 'dot', labelKey: 'fields.statuses.active' },
  archived: { tone: 'shelf', shape: 'square', labelKey: 'fields.statuses.archived' },
} as const satisfies Record<ArchivalStatus, StatusToken>;

/** The set a chip belongs to. Chosen at the call site, never inferred. */
export type StatusKind = 'project' | 'serviceKind' | 'serviceKindVersion' | 'service' | 'archival';

/**
 * Discriminated on `kind`, so `<StatusChip kind="serviceKind" status="planned" />`
 * — a real and easy mistake, since several sets share member names — will not
 * compile.
 */
export type StatusSelection =
  | { kind: 'project'; status: ProjectStatus }
  | { kind: 'serviceKind'; status: ServiceKindStatus }
  | { kind: 'serviceKindVersion'; status: ServiceKindVersionStatus }
  | { kind: 'service'; status: ServiceStatus }
  | { kind: 'archival'; status: ArchivalStatus };

export function statusToken(selection: StatusSelection): StatusToken {
  switch (selection.kind) {
    case 'project':
      return projectStatusTokens[selection.status];
    case 'serviceKind':
      return serviceKindStatusTokens[selection.status];
    case 'serviceKindVersion':
      return serviceKindVersionStatusTokens[selection.status];
    case 'service':
      return serviceStatusTokens[selection.status];
    case 'archival':
      return archivalStatusTokens[selection.status];
  }
}

/**
 * Ordered members of each set, for legends and (later) filter controls.
 *
 * These are written out rather than derived from `Object.keys`, which would
 * need a cast: the display order is a design decision — every list runs from
 * least to most settled. The value assignments below force `CoversExactly` to
 * reject a missing or invented member at compile time.
 */
type CoversExactly<Listed extends Union, Union> = [Union] extends [Listed] ? true : never;

export const projectStatuses = ['draft', 'active', 'completed', 'archived'] as const;
export const serviceKindStatuses = ['draft', 'active', 'archived'] as const;
export const serviceKindVersionStatuses = ['draft', 'published', 'retired'] as const;
export const serviceStatuses = ['draft', 'planned', 'confirmed', 'active', 'completed', 'cancelled'] as const;
export const archivalStatuses = ['active', 'archived'] as const;

const _projectStatusesInSync: CoversExactly<(typeof projectStatuses)[number], ProjectStatus> = true;
const _serviceKindStatusesInSync: CoversExactly<(typeof serviceKindStatuses)[number], ServiceKindStatus> = true;
const _serviceKindVersionStatusesInSync: CoversExactly<(typeof serviceKindVersionStatuses)[number], ServiceKindVersionStatus> = true;
const _serviceStatusesInSync: CoversExactly<(typeof serviceStatuses)[number], ServiceStatus> = true;
const _archivalStatusesInSync: CoversExactly<(typeof archivalStatuses)[number], ArchivalStatus> = true;

void _projectStatusesInSync;
void _serviceKindStatusesInSync;
void _serviceKindVersionStatusesInSync;
void _serviceStatusesInSync;
void _archivalStatusesInSync;
