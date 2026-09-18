"use server";

import { newResourceId } from "@opencompany/core/resource-ids";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";
import { activateWorkspace } from "@/lib/workspace-session";

const WORKSPACE_NAME_MAX_LENGTH = 80;
const CREATE_WORKSPACE_ERROR_MESSAGE = "Could not create the organization. Please try again.";
const ACTIVATE_WORKSPACE_ERROR_MESSAGE = "Could not switch organizations. Please try again.";
const ACTIVATE_CREATED_WORKSPACE_ERROR_MESSAGE =
  "The organization was created, but could not be activated. Please try switching to it.";

export type WorkspaceActionResult = { ok: true; warning?: string } | { ok: false; error: string };

export type WorkspaceCreateResult =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string };

export type WorkspaceMemberView = {
  userWorkosId: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  role: "admin" | "member";
};

export type WorkspaceView = {
  id: string;
  name: string;
  role: "admin" | "member";
};

export type WorkspaceInvitationView = {
  id: string;
  email: string;
  state: string;
  expiresAt: string | null;
};

function errorResult(error: unknown, fallback: string): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

function validateWorkspaceName(name: unknown) {
  if (typeof name !== "string") {
    return { ok: false as const, error: "Name cannot be empty." };
  }
  const trimmed = name.trim();
  if (!trimmed) return { ok: false as const, error: "Name cannot be empty." };
  if (trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
    return { ok: false as const, error: "Name is too long (max 80 chars)." };
  }
  return { ok: true as const, name: trimmed };
}

export async function switchWorkspaceAction(workspaceId: string): Promise<WorkspaceActionResult> {
  let activation: { workspaceId: string; organizationId: string };
  try {
    const response = await (await serverApiClient()).v1.workspaces[":workspaceId"].switch.$post({
      param: { workspaceId },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "You do not have access to that workspace."),
      };
    }
    activation = (await response.json()).data;
  } catch (error) {
    console.error("[opencompany] Failed to resolve workspace activation", {
      workspaceId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { ok: false, error: ACTIVATE_WORKSPACE_ERROR_MESSAGE };
  }

  try {
    await activateWorkspace({
      workspaceId: activation.workspaceId,
      workosOrganizationId: activation.organizationId,
    });
  } catch (error) {
    // AuthKit uses redirects for organization-specific SSO and MFA. Preserve
    // that framework control flow while translating ordinary refresh failures
    // into the server action's inline-error contract.
    unstable_rethrow(error);
    console.error("[opencompany] Failed to activate workspace organization", {
      workspaceId: activation.workspaceId,
      workosOrganizationId: activation.organizationId,
      error,
    });
    return { ok: false, error: ACTIVATE_WORKSPACE_ERROR_MESSAGE };
  }

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function createWorkspaceAction(name: unknown): Promise<WorkspaceCreateResult> {
  const validation = validateWorkspaceName(name);
  if (!validation.ok) return validation;

  const workspaceId = newResourceId("workspace");
  let activation: { workspaceId: string; organizationId: string };
  try {
    const response = await (await serverApiClient()).v1.workspaces.$post({
      json: {
        workspaceId,
        name: validation.name,
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, CREATE_WORKSPACE_ERROR_MESSAGE),
      };
    }
    activation = (await response.json()).data;
  } catch (error) {
    console.error("[opencompany] Failed to create workspace through the canonical API", {
      workspaceId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { ok: false, error: CREATE_WORKSPACE_ERROR_MESSAGE };
  }

  try {
    await activateWorkspace({
      workspaceId: activation.workspaceId,
      workosOrganizationId: activation.organizationId,
    });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[opencompany] Failed to activate newly created workspace organization", {
      workspaceId: activation.workspaceId,
      workosOrganizationId: activation.organizationId,
      error,
    });
    // The WorkOS organization and local workspace are durable at this point.
    // Keep them intact and invalidate the picker so the user can retry the
    // switch instead of creating a duplicate organization.
    revalidatePath("/", "layout");
    return { ok: false, error: ACTIVATE_CREATED_WORKSPACE_ERROR_MESSAGE };
  }
  revalidatePath("/", "layout");
  return { ok: true, workspaceId: activation.workspaceId };
}

export async function listWorkspaceMembersAction(): Promise<WorkspaceMemberView[]> {
  const settings = await getWorkspaceSettingsAction();
  return settings.members;
}

export async function inviteToWorkspaceAction(email: string): Promise<WorkspaceActionResult> {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  try {
    const response = await (await serverApiClient()).v1.workspace.invitations.$post({
      json: { email: trimmed },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not send the invitation."),
      };
    }
    revalidatePath("/settings/workspace");
    return { ok: true };
  } catch (error) {
    console.error("[opencompany] Failed to send workspace invitation", error);
    return errorResult(error, "Could not send the invitation.");
  }
}

export async function listWorkspaceInvitationsAction(): Promise<WorkspaceInvitationView[]> {
  try {
    const settings = await getWorkspaceSettingsAction();
    return settings.invitations;
  } catch (error) {
    console.error("[opencompany] Failed to list workspace invitations", error);
    return [];
  }
}

export async function revokeWorkspaceInvitationAction(
  invitationId: string,
): Promise<WorkspaceActionResult> {
  try {
    const response = await (await serverApiClient()).v1.workspace.invitations[
      ":invitationId"
    ].$delete({ param: { invitationId } });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not revoke the invitation."),
      };
    }
    revalidatePath("/settings/workspace");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not revoke the invitation.");
  }
}

export async function removeWorkspaceMemberAction(
  userWorkosId: string,
): Promise<WorkspaceActionResult> {
  try {
    const response = await (await serverApiClient()).v1.workspace.members[":userId"].$delete({
      param: { userId: userWorkosId },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not remove the member."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not remove the member.");
  }
}

export async function updateWorkspaceNameAction(name: string): Promise<WorkspaceActionResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name cannot be empty." };
  if (trimmed.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };

  try {
    const response = await (await serverApiClient()).v1.workspace.$patch({
      json: { name: trimmed },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not rename the workspace."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not rename the workspace.");
  }
}

export async function getWorkspaceSettingsAction(): Promise<{
  workspace: { id: string; name: string };
  role: "admin" | "member";
  plan: "hobby" | "pro";
  memberCap: number;
  members: WorkspaceMemberView[];
  invitations: WorkspaceInvitationView[];
}> {
  const response = await (await serverApiClient()).v1.workspace.$get();
  if (!response.ok) {
    throw new Error(await serverApiErrorMessage(response, "Could not load workspace settings."));
  }
  const settings = (await response.json()).data;
  return {
    workspace: settings.workspace,
    role: settings.role,
    plan: settings.plan,
    memberCap: settings.memberCap,
    members: settings.members.map(
      (member: {
        id: string;
        email: string;
        name: string;
        firstName: string | null;
        lastName: string | null;
        avatarUrl: string | null;
        role: "admin" | "member";
      }) => ({
        userWorkosId: member.id,
        email: member.email,
        name: member.name,
        firstName: member.firstName,
        lastName: member.lastName,
        avatarUrl: member.avatarUrl,
        role: member.role,
      }),
    ),
    invitations: settings.invitations,
  };
}
