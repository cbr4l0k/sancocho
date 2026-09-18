import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { requireOrganizationRole } from '../lib/access';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { organizationConfigurationRole } from '../lib/roles';
import { requireProjectAccess } from '../projects/model';
import {
  auditMetadataKeySet,
  auditMetadataSummaryKeySet,
  maxAuditEntityIdLength,
  maxAuditMetadataStringLength,
  type AuditMetadataKey,
  type auditActionValidator,
  type auditEntityTypeValidator,
  type auditMetadataValidator,
  type exportSheetValidator,
} from '../validators';

type AuditAction = typeof auditActionValidator.type;
type AuditEntityType = typeof auditEntityTypeValidator.type;
type AuditMetadataValue = typeof auditMetadataValidator.type[string];
type ExportSheet = typeof exportSheetValidator.type;

/**
 * Writers name their keys from the code-owned allowlist, so the compiler is the
 * first gate: an invented or misspelled key fails `typecheck` instead of
 * throwing inside a domain mutation at runtime. The stored column stays the
 * wider `v.record` shape so old rows remain readable if a key is ever retired.
 */
export type AuditMetadata = Partial<Record<AuditMetadataKey, AuditMetadataValue>>;

/**
 * Inserts an append-only audit row in the caller's mutation, making the
 * operation and log entry transactional. This is a log, not event sourcing:
 * application state is never rebuilt from audit rows.
 */
export function recordAuditEvent(
  ctx: MutationCtx,
  event: {
    organizationId: Id<'organizations'>;
    actorUserId: Id<'users'>;
    /**
     * The second actor dimension (#71): the Provider whose grant admitted the
     * actor, when the operation was performed on the provider arm of the access
     * chain. Callers derive the pair from a resolved `Principal` through
     * `auditActorFor` rather than assembling it by hand, so "who acted" and "on
     * whose behalf" can never disagree. Omitted entirely on the member arm.
     */
    onBehalfOfProviderId?: Id<'providers'>;
    action: AuditAction;
    entityType: AuditEntityType;
    entityId: string;
    metadata: AuditMetadata;
  },
) {
  return ctx.db.insert('auditEvents', { ...event, metadata: sanitizeAuditMetadata(event.metadata) });
}

/**
 * Member-only authorization gate and start marker for a bulk tenant export.
 *
 * The floor is admin because an export is qualitatively unlike the screens it draws from.
 * Note precisely what that floor governs: the RECORDED export path. Every query the walk
 * drives enforces its own chain, and most of them floor at plain membership, so this is
 * not a claim that a viewer cannot assemble the same rows by other means — see
 * docs/export.md "What the floor does and does not cover".
 */
export async function recordExportRequest(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; projectId?: Id<'projects'>; sheets: ExportSheet[] },
): Promise<void> {
  const access = await requireOrganizationRole(ctx, args.organizationId, organizationConfigurationRole);
  if (args.projectId !== undefined) {
    const { project } = await requireProjectAccess(ctx, args.projectId, organizationConfigurationRole);
    if (project.organizationId !== args.organizationId) {
      return notFoundOrInaccessible();
    }
  }
  // These two reuse `auditMetadataInvalid` deliberately: they are unreachable from the
  // console, which sends a constant sheet set, so they exist to keep a hand-made call from
  // writing a row that misdescribes what was extracted. A dedicated code would add
  // vocabulary for a message no operator can provoke.
  //
  // There is deliberately no separate length bound. `sheets` is already closed to the
  // union's members by the validator, so any array longer than the union is necessarily
  // duplicated and the check below refuses it — a length guard could never refuse an input
  // this one does not, which is to say no test could tell it from dead code.
  if (args.sheets.length === 0) {
    return invalidInput('auditMetadataInvalid', 'An export must request at least one sheet');
  }
  if (new Set(args.sheets).size !== args.sheets.length) {
    return invalidInput('auditMetadataInvalid', 'An export cannot request the same sheet more than once');
  }
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'export.requested',
    entityType: 'organization',
    entityId: args.organizationId,
    metadata: {
      sheets: args.sheets.join(', '),
      ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
    },
  });
}

/** Administrative visibility only: owners and admins can read audit history. */
export async function listOrganizationAuditEvents(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<Doc<'auditEvents'>>> {
  await requireOrganizationRole(ctx, organizationId, 'admin');
  // Convex `_creationTime` is the log's time axis; newest audit row first.
  return ctx.db
    .query('auditEvents')
    .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
    .order('desc')
    .paginate(paginationOpts);
}

/** Administrative, entity-scoped audit history; membership is proven before reading. */
export async function listEntityAuditEvents(
  ctx: QueryCtx,
  args: { organizationId: Id<'organizations'>; entityType: AuditEntityType; entityId: string; paginationOpts: PaginationOptions },
): Promise<PaginationResult<Doc<'auditEvents'>>> {
  await requireOrganizationRole(ctx, args.organizationId, 'admin');
  // The one free-form public input on this domain; bounded like every other
  // caller string (I5). Membership is proven first, so the bound cannot be used
  // to probe organizations the caller cannot read.
  if (args.entityId.length > maxAuditEntityIdLength) {
    return invalidInput('auditEntityIdTooLong', `Audit entity id must not exceed ${maxAuditEntityIdLength} characters`);
  }
  return ctx.db
    .query('auditEvents')
    .withIndex('by_org_entity', (q) =>
      q.eq('organizationId', args.organizationId).eq('entityType', args.entityType).eq('entityId', args.entityId),
    )
    .order('desc')
    .paginate(args.paginationOpts);
}

/**
 * Runtime half of the metadata policy (the compiler is the other half, see
 * `AuditMetadata`). The string bound exists to keep secrets, tokens, provider
 * claims, and bulk PII out of the log — a risk that only exists for values
 * derived from CALLER INPUT. It is not a veto on the server's own summaries, so
 * the two cases are treated differently:
 *
 * - Caller-influenced values (`name`, `key`, `slug`, …) are REJECTED when they
 *   exceed the bound. This can never abort a legitimate mutation: every such
 *   value is already bounded far below 512 by its own validator (names 200,
 *   keys 64, slugs 63, everything else a code-owned literal or a document id),
 *   so passing the bound here means the value bypassed its domain validation.
 * - Server-generated summaries (`auditMetadataSummaryKeys`) are TRUNCATED. They
 *   are comma-joined column names and document ids, so length tracks how much
 *   the user legitimately changed: a 200-field serviceKind version yields ~6.6KB of
 *   `changedFields`. Throwing there would roll back a valid edit and blame the
 *   user's input for the log's own limit — the regression this rule prevents.
 *
 * Net invariant: no domain mutation can ever fail because of its own audit row.
 */
function sanitizeAuditMetadata(metadata: AuditMetadata): Record<string, AuditMetadataValue> {
  const sanitized: Record<string, AuditMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!auditMetadataKeySet.has(key)) {
      invalidInput('auditMetadataInvalid', `Audit metadata key is not permitted: ${key}`);
    }
    // An explicitly-undefined key is simply absent; Convex stores no such column.
    if (value === undefined) continue;
    if (typeof value === 'string' && value.length > maxAuditMetadataStringLength) {
      if (!auditMetadataSummaryKeySet.has(key)) {
        invalidInput('auditMetadataInvalid', `Audit metadata string values must not exceed ${maxAuditMetadataStringLength} characters`);
      }
      sanitized[key] = truncateAuditSummary(value);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Shortens an over-long server summary to whole comma-separated entries plus a
 * `+N more` marker, so a truncated `changedFields` still reads as a list of ids
 * rather than one sliced mid-identifier. The result is always within the bound.
 */
function truncateAuditSummary(summary: string): string {
  const entries = summary.split(',');
  // Reserved against the largest marker the input could produce, so appending
  // the real (necessarily smaller) one can never push the result over the bound.
  const reserved = `,+${entries.length} more`.length;
  const kept: string[] = [];
  let length = 0;
  for (const entry of entries) {
    const addition = kept.length === 0 ? entry.length : entry.length + 1;
    if (length + addition + reserved > maxAuditMetadataStringLength) break;
    kept.push(entry);
    length += addition;
  }
  const omitted = entries.length - kept.length;
  // A single entry too long to keep even alone leaves only the count, which is
  // still a truthful summary and still within the bound.
  return kept.length === 0 ? `+${omitted} more` : `${kept.join(',')},+${omitted} more`;
}
