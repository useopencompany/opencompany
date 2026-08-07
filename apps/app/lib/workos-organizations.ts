import type { Workspace } from "@opencompany/db/schema";
import {
  listWorkspaceMembers,
  setWorkspaceOrganizationId,
  type WorkspaceMemberWithUser,
} from "@opencompany/db/workspaces";
import { getWorkOSClient } from "@/lib/workos-client";

const ADMIN_ROLE = "admin";
const MEMBER_ROLE = "member";

type WorkOSClient = ReturnType<typeof getWorkOSClient>;

export async function ensureWorkspaceOrganization(workspace: Workspace): Promise<string> {
  if (workspace.workosOrganizationId) return workspace.workosOrganizationId;

  const workos = getWorkOSClient();
  const existing = await findWorkspaceOrganization(workos, workspace.id);
  if (existing) {
    await syncWorkspaceMembersToOrganization(workos, workspace.id, existing.id);
    await setWorkspaceOrganizationId({
      workspaceId: workspace.id,
      workosOrganizationId: existing.id,
    });
    return existing.id;
  }

  let organizationId: string | undefined;
  try {
    const organization = await createWorkspaceOrganization(workos, workspace);
    organizationId = organization.id;

    await syncWorkspaceMembersToOrganization(workos, workspace.id, organization.id);
    await setWorkspaceOrganizationId({
      workspaceId: workspace.id,
      workosOrganizationId: organization.id,
    });
    return organization.id;
  } catch (error) {
    if (isWorkOSConflict(error)) {
      const conflicted = await findWorkspaceOrganization(workos, workspace.id);
      if (conflicted) {
        await syncWorkspaceMembersToOrganization(workos, workspace.id, conflicted.id);
        await setWorkspaceOrganizationId({
          workspaceId: workspace.id,
          workosOrganizationId: conflicted.id,
        });
        return conflicted.id;
      }
    }

    if (organizationId) {
      try {
        await workos.organizations.deleteOrganization(organizationId);
      } catch (cleanupError) {
        console.error("[app] Failed to clean up WorkOS organization", cleanupError);
      }
    }
    throw error;
  }
}

export async function ensureWorkspaceOrganizationsForEntries<T extends { workspace: Workspace }>(
  entries: T[],
): Promise<T[]> {
  const next: T[] = [];
  for (const entry of entries) {
    try {
      const workosOrganizationId = await ensureWorkspaceOrganization(entry.workspace);
      next.push({
        ...entry,
        workspace: { ...entry.workspace, workosOrganizationId },
      });
    } catch (error) {
      console.error("[app] Failed to ensure WorkOS organization for workspace", {
        workspaceId: entry.workspace.id,
        error,
      });
      next.push(entry);
    }
  }
  return next;
}

async function findWorkspaceOrganization(workos: WorkOSClient, workspaceId: string) {
  try {
    return await workos.organizations.getOrganizationByExternalId(workspaceId);
  } catch (error) {
    if (isWorkOSNotFound(error)) return null;
    throw error;
  }
}

async function createWorkspaceOrganization(workos: WorkOSClient, workspace: Workspace) {
  return workos.organizations.createOrganization(
    {
      name: workspace.name,
      externalId: workspace.id,
      metadata: {
        goat_workspace_id: workspace.id,
      },
    },
    { idempotencyKey: workspace.id },
  );
}

async function syncWorkspaceMembersToOrganization(
  workos: WorkOSClient,
  workspaceId: string,
  organizationId: string,
) {
  const members = await listWorkspaceMembers(workspaceId);
  for (const member of members) {
    await ensureOrganizationMembership(workos, organizationId, member);
  }
}

async function ensureOrganizationMembership(
  workos: WorkOSClient,
  organizationId: string,
  entry: WorkspaceMemberWithUser,
) {
  const roleSlug = entry.member.role === ADMIN_ROLE ? ADMIN_ROLE : MEMBER_ROLE;
  const memberships = await workos.userManagement.listOrganizationMemberships({
    organizationId,
    userId: entry.user.workosUserId,
    statuses: ["active", "pending", "inactive"],
  });
  const existing = memberships.data[0];
  if (!existing) {
    await workos.userManagement.createOrganizationMembership({
      organizationId,
      userId: entry.user.workosUserId,
      roleSlug,
    });
    return;
  }

  if (existing.status === "inactive") {
    await workos.userManagement.createOrganizationMembership({
      organizationId,
      userId: entry.user.workosUserId,
      roleSlug,
    });
    return;
  }

  if (existing.role?.slug !== roleSlug) {
    await workos.userManagement.updateOrganizationMembership(existing.id, { roleSlug });
  }
}

function isWorkOSNotFound(error: unknown) {
  return workosErrorStatus(error) === 404;
}

function isWorkOSConflict(error: unknown) {
  return workosErrorStatus(error) === 409;
}

function workosErrorStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (candidate.code === "not_found") return 404;
  if (candidate.code === "conflict") return 409;
  return null;
}
