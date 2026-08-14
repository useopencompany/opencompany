import { getDb } from "@opencompany/db/client";
import {
  createGoatWorkspaceForUser,
  DEFAULT_GOAT_BRAIN_SLUG,
  listAccessibleGoatBrains,
  listGoatWorkspacesForUser,
  newGoatWorkspaceId,
} from "@opencompany/db/goat-workspaces";
import type { WorkOSClientLike } from "./workos";

type DbLike = any;

const ADMIN_ROLE = "admin";

export class GoatWorkspaceProvisioningError extends Error {
  readonly workspaceId: string;
  readonly workosOrganizationId: string | null;
  readonly localWorkspacePersisted: boolean;

  constructor(input: {
    workspaceId: string;
    workosOrganizationId: string | null;
    localWorkspacePersisted: boolean;
    cause: unknown;
  }) {
    super("Could not provision the Goat workspace.", { cause: input.cause });
    this.name = "GoatWorkspaceProvisioningError";
    this.workspaceId = input.workspaceId;
    this.workosOrganizationId = input.workosOrganizationId;
    this.localWorkspacePersisted = input.localWorkspacePersisted;
  }
}

// WorkOS and Postgres cannot share a transaction. Provision WorkOS first, then
// persist the complete local workspace in one Neon batch. If local persistence
// fails, compensate by deleting the new organization; once Postgres succeeds,
// the workspace is durable and activation can be retried without duplication.
export async function provisionGoatWorkspace(
  input: {
    authUserId: string;
    userWorkosId: string;
    name: string;
    slug?: string | null;
    workspaceId?: string;
  },
  deps: { workos: WorkOSClientLike; db?: DbLike },
) {
  const workspaceId = input.workspaceId ?? newGoatWorkspaceId();
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

    const created = await createGoatWorkspaceForUser(
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
        console.error("[goat] Failed to clean up workspace organization", {
          workspaceId,
          workosOrganizationId,
          error: cleanupError,
        });
      }
    }
    throw new GoatWorkspaceProvisioningError({
      workspaceId,
      workosOrganizationId,
      localWorkspacePersisted,
      cause,
    });
  }
}

async function findProvisionedWorkspace(workspaceId: string, userWorkosId: string, db: DbLike) {
  const memberships = await listGoatWorkspacesForUser(userWorkosId, { db });
  const existing = memberships.find((entry) => entry.workspace.id === workspaceId);
  const workosOrganizationId = existing?.workspace.workosOrganizationId;
  if (!existing || !workosOrganizationId) return null;
  const brains = await listAccessibleGoatBrains({ userWorkosId, workspaceId }, { db });
  const brain = brains.find((entry) => entry.slug === DEFAULT_GOAT_BRAIN_SLUG) ?? brains[0];
  if (!brain) return null;
  return {
    workspace: { ...existing.workspace, workosOrganizationId },
    brain,
  };
}
