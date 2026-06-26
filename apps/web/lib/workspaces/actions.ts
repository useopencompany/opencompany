"use server";

import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { users, workspaceMemberships, workspaces } from "@opencompany/db/schema";
import { captureException } from "@opencompany/observability";
import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  currentWorkspace,
  refreshIntoWorkspaceOrganization,
} from "@/lib/auth";
import { getWorkOSClient } from "@/lib/workos";

const WORKSPACE_NAME_MAX_LENGTH = 80;
const ADMIN_ROLE = "admin";
const CREATE_WORKSPACE_ERROR_MESSAGE = "Could not create workspace. Please try again.";

export type WorkspacePickerItem = {
  id: string;
  name: string;
  workosOrganizationId: string | null;
};

function newWorkspaceId() {
  return `wks_${randomUUID()}`;
}

function validateWorkspaceName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false as const, error: "Name cannot be empty." };
  if (trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
    return { ok: false as const, error: "Name is too long (max 80 chars)." };
  }
  return { ok: true as const, name: trimmed };
}

async function cleanupCreatedOrganization(
  workos: ReturnType<typeof getWorkOSClient>,
  organizationId: string,
) {
  try {
    await workos.organizations.deleteOrganization(organizationId);
  } catch (error) {
    captureException(error, {
      event: "opencompany.workspace_create_workos_cleanup_failed",
      workos_organization_id: organizationId,
    });
  }
}

export async function listUserWorkspaces(): Promise<WorkspacePickerItem[]> {
  const context = await currentWorkspace({ optional: true, skipOnboarding: true });
  if (!context) return [];

  const db = getDb();
  return await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      workosOrganizationId: workspaces.workosOrganizationId,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(eq(workspaceMemberships.userId, context.user.id))
    .orderBy(asc(workspaces.name));
}

export async function createWorkspace(name: string) {
  const validation = validateWorkspaceName(name);
  if (!validation.ok) return validation;

  const context = await currentWorkspace({ optional: true, skipOnboarding: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const now = new Date();
  const workspaceId = newWorkspaceId();
  let workos: ReturnType<typeof getWorkOSClient> | undefined;
  let workosOrganizationId: string | undefined;
  let localWorkspacePersisted = false;

  try {
    const db = getDb();
    workos = getWorkOSClient();
    const organization = await workos.organizations.createOrganization(
      {
        name: validation.name,
      },
      { idempotencyKey: workspaceId },
    );
    workosOrganizationId = organization.id;

    await workos.userManagement.createOrganizationMembership({
      organizationId: organization.id,
      userId: context.authUser.id,
      roleSlug: ADMIN_ROLE,
    });

    const [workspaceRows] = await db.batch([
      db
        .insert(workspaces)
        .values({
          id: workspaceId,
          workosOrganizationId: organization.id,
          name: organization.name || validation.name,
          createdByUserId: context.user.id,
          updatedAt: now,
        })
        .returning(),
      db.insert(workspaceMemberships).values({
        workspaceId,
        userId: context.user.id,
        role: ADMIN_ROLE,
        updatedAt: now,
      }),
      db
        .update(users)
        .set({ companySurfaceEnabled: true, updatedAt: now })
        .where(eq(users.id, context.user.id)),
    ]);
    const [workspace] = workspaceRows;

    if (!workspace) {
      throw new Error("Workspace insert did not return a row.");
    }
    localWorkspacePersisted = true;

    await refreshIntoWorkspaceOrganization(workspace);

    revalidatePath("/", "layout");
    revalidatePath("/company");
    revalidatePath("/personal");

    return { ok: true as const, workspaceId: workspace.id };
  } catch (error) {
    captureException(error, {
      event: "opencompany.workspace_create_failed",
      user_id: context.user.id,
      workos_organization_id: workosOrganizationId,
      local_workspace_persisted: localWorkspacePersisted,
    });

    if (workos && workosOrganizationId && !localWorkspacePersisted) {
      await cleanupCreatedOrganization(workos, workosOrganizationId);
    }

    return { ok: false as const, error: CREATE_WORKSPACE_ERROR_MESSAGE };
  }
}

export async function switchWorkspace(workspaceId: string) {
  const context = await currentWorkspace({ optional: true, skipOnboarding: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const db = getDb();
  const [row] = await db
    .select({ workspace: workspaces })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(and(eq(workspaceMemberships.userId, context.user.id), eq(workspaces.id, workspaceId)))
    .limit(1);

  if (!row) {
    return { ok: false as const, error: "You do not have access to that workspace." };
  }

  if (!row.workspace.workosOrganizationId) {
    return { ok: false as const, error: "Workspace is not linked to an organization." };
  }

  await refreshIntoWorkspaceOrganization(row.workspace);

  revalidatePath("/", "layout");
  revalidatePath("/company");
  revalidatePath("/personal");

  return { ok: true as const, workspaceId: row.workspace.id };
}

export async function updateWorkspaceName(name: string) {
  const validation = validateWorkspaceName(name);
  if (!validation.ok) return validation;

  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const { workspace } = context;
  if (!workspace.workosOrganizationId) {
    return { ok: false as const, error: "Workspace is not linked to an organization." };
  }

  const db = getDb();

  await getWorkOSClient().organizations.updateOrganization({
    organization: workspace.workosOrganizationId,
    name: validation.name,
  });

  await db
    .update(workspaces)
    .set({ name: validation.name, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/", "layout");
  revalidatePath("/company/settings");

  return { ok: true as const, name: validation.name };
}
