import type { PaginationOptions, PaginationResult } from 'convex/server';

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditEvent } from '../audit/model';
import {
  requireAuthenticatedUser,
  requireOrganizationMembership,
  requireOrganizationRole,
  type OrganizationMembershipAccess,
} from '../lib/access';
import { invalidInput, notFoundOrInaccessible } from '../lib/errors';
import { validateEntityName } from '../lib/names';
import type { Role } from '../lib/roles';
import { isFiniteNumber, type projectStatusValidator } from '../validators';

type ProjectStatus = typeof projectStatusValidator.type;

type ProjectDates = {
  startsAt?: number;
  endsAt?: number;
};

type ProjectPatch = ProjectDates & {
  name?: string;
  description?: string;
  status?: ProjectStatus;
};

/** Projects are archival-only: there is intentionally no hard-delete operation. */
export async function createProject(
  ctx: MutationCtx,
  args: { organizationId: Id<'organizations'>; name: string; description?: string } & ProjectDates,
): Promise<Id<'projects'>> {
  const access = await requireOrganizationRole(ctx, args.organizationId, 'planner');
  // The validator returns the trimmed name, and the trimmed name is what is stored.
  const name = validateEntityName(args.name, 'project');
  validateProjectDates(args);
  const projectId = await ctx.db.insert('projects', {
    organizationId: args.organizationId,
    name,
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.startsAt === undefined ? {} : { startsAt: args.startsAt }),
    ...(args.endsAt === undefined ? {} : { endsAt: args.endsAt }),
    status: 'draft',
  });
  await recordAuditEvent(ctx, {
    organizationId: args.organizationId,
    actorUserId: access.user._id,
    action: 'project.created',
    entityType: 'project',
    entityId: projectId,
    metadata: { name },
  });
  return projectId;
}

export async function getProject(ctx: QueryCtx, projectId: Id<'projects'>): Promise<Doc<'projects'>> {
  const { project } = await requireProjectAccess(ctx, projectId);
  return project;
}

export async function listProjects(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<Doc<'projects'>>> {
  await requireOrganizationMembership(ctx, organizationId);
  // Paginated: a tenant's project list is unbounded (I6).
  return ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
    .paginate(paginationOpts);
}

export async function updateProject(
  ctx: MutationCtx,
  projectId: Id<'projects'>,
  patch: ProjectPatch,
): Promise<void> {
  const { project, access } = await requireProjectAccess(ctx, projectId, 'planner');
  // Archived projects are immutable regardless of which fields are patched.
  if (project.status === 'archived') {
    return invalidInput('Archived projects cannot be updated');
  }
  // Validated (and therefore trimmed) before the diff, so what is compared
  // against the stored name is exactly what would be stored.
  const name = patch.name === undefined ? undefined : validateEntityName(patch.name, 'project');
  if (patch.status !== undefined) {
    assertProjectStatusTransition(project.status, patch.status);
  }
  const mergedStartsAt = patch.startsAt === undefined ? project.startsAt : patch.startsAt;
  const mergedEndsAt = patch.endsAt === undefined ? project.endsAt : patch.endsAt;
  validateProjectDates({
    ...(mergedStartsAt === undefined ? {} : { startsAt: mergedStartsAt }),
    ...(mergedEndsAt === undefined ? {} : { endsAt: mergedEndsAt }),
  });

  // Built field by field rather than spreading client args, so only known
  // columns are written and the audit row names what actually changed.
  const update: ProjectPatch = {};
  const changedFields: string[] = [];
  if (name !== undefined && name !== project.name) {
    update.name = name;
    changedFields.push('name');
  }
  if (patch.description !== undefined && patch.description !== project.description) {
    update.description = patch.description;
    changedFields.push('description');
  }
  if (patch.startsAt !== undefined && patch.startsAt !== project.startsAt) {
    update.startsAt = patch.startsAt;
    changedFields.push('startsAt');
  }
  if (patch.endsAt !== undefined && patch.endsAt !== project.endsAt) {
    update.endsAt = patch.endsAt;
    changedFields.push('endsAt');
  }
  if (patch.status !== undefined && patch.status !== project.status) {
    update.status = patch.status;
    changedFields.push('status');
  }
  // A no-op update writes neither a patch nor an empty audit row.
  if (changedFields.length === 0) {
    return;
  }

  await ctx.db.patch(projectId, update);
  await recordAuditEvent(ctx, {
    organizationId: project.organizationId,
    actorUserId: access.user._id,
    action: 'project.updated',
    entityType: 'project',
    entityId: projectId,
    metadata: {
      changedFields: changedFields.join(','),
      ...(update.status === undefined ? {} : { previousStatus: project.status, status: update.status }),
    },
  });
}

export async function archiveProject(ctx: MutationCtx, projectId: Id<'projects'>): Promise<void> {
  const { project, access } = await requireProjectAccess(ctx, projectId, 'planner');
  // Idempotent: re-archiving neither re-patches nor writes a second audit row.
  if (project.status === 'archived') {
    return;
  }
  // Future work (#10): check events through events.by_project before lifecycle expansion.
  await ctx.db.patch(projectId, { status: 'archived' });
  await recordAuditEvent(ctx, {
    organizationId: project.organizationId,
    actorUserId: access.user._id,
    action: 'project.archived',
    entityType: 'project',
    entityId: projectId,
    metadata: { previousStatus: project.status },
  });
}

/**
 * Resolves a project and proves the caller's access to its organization.
 *
 * Authenticates before resolving the id so nonexistent and foreign projects are
 * indistinguishable to callers without a matching organization membership (I9);
 * the proven identity is then reused for the membership/role check so the app
 * user is read once. `minimumRole` omitted means any member (viewer and above).
 */
export async function requireProjectAccess(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'projects'>,
  minimumRole?: Role,
): Promise<{ project: Doc<'projects'>; access: OrganizationMembershipAccess }> {
  const authenticated = await requireAuthenticatedUser(ctx);
  const project = await ctx.db.get(projectId);
  if (project === null) {
    return notFoundOrInaccessible();
  }
  const access =
    minimumRole === undefined
      ? await requireOrganizationMembership(ctx, project.organizationId, authenticated)
      : await requireOrganizationRole(ctx, project.organizationId, minimumRole, authenticated);
  return { project, access };
}

/**
 * The only status policy statement for projects. draft | active | completed may
 * move between each other freely for now — no forward-only lifecycle is
 * specified yet. Archiving is deliberately not reachable here: it is its own
 * operation so it keeps its own audit action and its future
 * events-reference guard. Archived is terminal; unarchiving is unsupported.
 */
function assertProjectStatusTransition(current: ProjectStatus, next: ProjectStatus): void {
  if (current === 'archived') {
    return invalidInput('Archived projects cannot be updated');
  }
  if (next === 'archived') {
    return invalidInput('Use archiveProject to archive a project');
  }
}

function validateProjectDates({ startsAt, endsAt }: ProjectDates): void {
  // Convex accepts NaN/Infinity in v.number(); unorderable bounds must never be
  // stored, because the comparison below silently passes for NaN.
  if (startsAt !== undefined && !isFiniteNumber(startsAt)) {
    return invalidInput('Project start must be a finite timestamp');
  }
  if (endsAt !== undefined && !isFiniteNumber(endsAt)) {
    return invalidInput('Project end must be a finite timestamp');
  }
  if (startsAt !== undefined && endsAt !== undefined && endsAt < startsAt) {
    return invalidInput('Project end must not precede its start');
  }
}
