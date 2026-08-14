import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { requireOrganizationRole } from '../lib/access';
import { invalidInput } from '../lib/errors';
import {
  auditMetadataKeySet,
  auditMetadataSummaryKeySet,
  maxAuditEntityIdLength,
  maxAuditMetadataStringLength,
  type AuditMetadataKey,
  type auditActionValidator,
  type auditEntityTypeValidator,
  type auditMetadataValidator,
} from '../validators';

type AuditAction = typeof auditActionValidator.type;
type AuditEntityType = typeof auditEntityTypeValidator.type;
type AuditMetadataValue = typeof auditMetadataValidator.type[string];

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
    action: AuditAction;
    entityType: AuditEntityType;
    entityId: string;
    metadata: AuditMetadata;
  },
) {
  return ctx.db.insert('auditEvents', { ...event, metadata: sanitizeAuditMetadata(event.metadata) });
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
    return invalidInput(`Audit entity id must not exceed ${maxAuditEntityIdLength} characters`);
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
 *   the user legitimately changed: a 200-field recipe version yields ~6.6KB of
 *   `changedFields`. Throwing there would roll back a valid edit and blame the
 *   user's input for the log's own limit — the regression this rule prevents.
 *
 * Net invariant: no domain mutation can ever fail because of its own audit row.
 */
function sanitizeAuditMetadata(metadata: AuditMetadata): Record<string, AuditMetadataValue> {
  const sanitized: Record<string, AuditMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!auditMetadataKeySet.has(key)) {
      invalidInput(`Audit metadata key is not permitted: ${key}`);
    }
    // An explicitly-undefined key is simply absent; Convex stores no such column.
    if (value === undefined) continue;
    if (typeof value === 'string' && value.length > maxAuditMetadataStringLength) {
      if (!auditMetadataSummaryKeySet.has(key)) {
        invalidInput(`Audit metadata string values must not exceed ${maxAuditMetadataStringLength} characters`);
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
