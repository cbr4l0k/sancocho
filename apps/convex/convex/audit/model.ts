import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import type { auditActionValidator, auditEntityTypeValidator, auditMetadataValidator } from '../validators';

type AuditAction = typeof auditActionValidator.type;
type AuditEntityType = typeof auditEntityTypeValidator.type;
type AuditMetadata = typeof auditMetadataValidator.type;

/** Inserts an audit row in the caller's mutation, making the operation and audit transactional. */
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
  return ctx.db.insert('auditEvents', event);
}
