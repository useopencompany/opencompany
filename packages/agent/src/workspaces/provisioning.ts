import { getDb } from "@opencompany/db/client";
import {
  createWorkspaceForUser,
  DEFAULT_BRAIN_SLUG,
  listAccessibleBrains,
  listWorkspacesForUser,
  newWorkspaceId,
} from "@opencompany/db/workspaces";
import type { WorkOSClientLike } from "./workos";

type DbLike = any;

const ADMIN_ROLE = "admin";

export class WorkspaceProvisioningError extends Error {
  readonly workspaceId: string;
  readonly workosOrganizationId: string | null;
  readonly localWorkspacePersisted: boolean;

  constructor(input: {
    workspaceId: string;
    workosOrganizationId: string | null;
    localWorkspacePersisted: boolean;
    cause: unknown;
  }) {
    super("Could not provision the opencompany workspace.", { cause: input.cause });
    this.name = "WorkspaceProvisioningError";
    this.workspaceId = input.workspaceId;
    this.workosOrganizationId = input.workosOrganizationId;
    this.localWorkspacePersisted = input.localWorkspacePersisted;
  }
}

// WorkOS and Postgres cannot share a transaction. Provision WorkOS first, then
// persist the complete local workspace in one atomic database operation. If
// local persistence fails, compensate by deleting the new organization; once
// Postgres succeeds, the workspace is durable and activation can be retried
// without duplication.
export async function provisionWorkspace(
  input: {
    authUserId: string;
    userWorkosId: string;
    name: string;
    slug?: string | null;
    workspaceId?: string;
  },
  deps: { workos: WorkOSClientLike; db?: DbLike },
) {
  const workspaceId = input.workspaceId ?? newWorkspaceId();
  const workos = deps.workos;
  const db: DbLike = deps.db ?? getDb();
  let workosOrganizationId: string | null = null;
  let localWorkspacePersisted = false;

  try {
    const replay = await findProvisionedWorkspace(workspaceId, input.userWorkosId, db);
    if (replay) return replay;

    const organization = await workos.organizations.createOrganization(
      {
        name: input.name,
        externalId: workspaceId,
        metadata: {
          goat_workspace_id: workspaceId,
        },
      },
      { idempotencyKey: workspaceId },
    );
    workosOrganizationId = organization.id;

    const memberships = await workos.userManagement.listOrganizationMemberships({
      organizationId: organization.id,
      userId: input.userWorkosId,
      statuses: ["active", "pending", "inactive"],
    });
    if (!memberships.data.some((membership) => membership.status !== "inactive")) {
      await workos.userManagement.createOrganizationMembership({
        organizationId: organization.id,
        userId: input.authUserId,
        roleSlug: ADMIN_ROLE,
      });
    }

    const created = await createWorkspaceForUser(
      {
        workspaceId,
        workosOrganizationId: organization.id,
        userWorkosId: input.userWorkosId,
        name: organization.name || input.name,
        slug: input.slug ?? null,
      },
      { db },
    );
    localWorkspacePersisted = true;
    return {
      ...created,
      workspace: {
        ...created.workspace,
        workosOrganizationId: organization.id,
      },
    };
  } catch (cause) {
    const replay = await findProvisionedWorkspace(workspaceId, input.userWorkosId, db).catch(
      () => null,
    );
    if (replay) return replay;

    if (workosOrganizationId && !localWorkspacePersisted) {
      try {
        await workos.organizations.deleteOrganization(workosOrganizationId);
      } catch (cleanupError) {
        console.error("[opencompany] Failed to clean up workspace organization", {
          workspaceId,
          workosOrganizationId,
          error: cleanupError,
        });
      }
    }
    throw new WorkspaceProvisioningError({
      workspaceId,
      workosOrganizationId,
      localWorkspacePersisted,
      cause,
    });
  }
}

async function findProvisionedWorkspace(workspaceId: string, userWorkosId: string, db: DbLike) {
  const memberships = await listWorkspacesForUser(userWorkosId, { db });
  const existing = memberships.find((entry) => entry.workspace.id === workspaceId);
  const workosOrganizationId = existing?.workspace.workosOrganizationId;
  if (!existing || !workosOrganizationId) return null;
  const brains = await listAccessibleBrains({ userWorkosId, workspaceId }, { db });
  const brain = brains.find((entry) => entry.slug === DEFAULT_BRAIN_SLUG) ?? brains[0] ?? null;
  return {
    workspace: { ...existing.workspace, workosOrganizationId },
    brain,
  };
}
