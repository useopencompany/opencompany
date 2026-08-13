import { getDb } from "@opencompany/db/client";
import { createGoatWorkspaceForUser, newGoatWorkspaceId } from "@opencompany/db/goat-workspaces";
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
  },
  deps: { workos: WorkOSClientLike; db?: DbLike },
) {
  const workspaceId = newGoatWorkspaceId();
  const workos = deps.workos;
  const db: DbLike = deps.db ?? getDb();
  let workosOrganizationId: string | null = null;
  let localWorkspacePersisted = false;

  try {
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

    await workos.userManagement.createOrganizationMembership({
      organizationId: organization.id,
      userId: input.authUserId,
      roleSlug: ADMIN_ROLE,
    });

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
