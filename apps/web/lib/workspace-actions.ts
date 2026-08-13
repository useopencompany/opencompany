"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";
import { activateGoatWorkspace, GOAT_ACTIVE_BRAIN_COOKIE } from "@/lib/workspace-session";

const WORKSPACE_NAME_MAX_LENGTH = 80;
const CREATE_WORKSPACE_ERROR_MESSAGE = "Could not create the organization. Please try again.";
const ACTIVATE_WORKSPACE_ERROR_MESSAGE = "Could not switch organizations. Please try again.";
const ACTIVATE_CREATED_WORKSPACE_ERROR_MESSAGE =
  "The organization was created, but could not be activated. Please try switching to it.";

export type GoatWorkspaceActionResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

export type GoatWorkspaceCreateResult =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string };

export type GoatWorkspaceMemberView = {
  userWorkosId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "admin" | "member";
};

export type GoatWorkspaceView = {
  id: string;
  name: string;
  role: "admin" | "member";
};

export type GoatWorkspaceInvitationView = {
  id: string;
  email: string;
  state: string;
  expiresAt: string | null;
};

export type GoatBrainVisibility = "workspace" | "restricted";
export type GoatBrainIntelligence = "basic" | "frontier";

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

export async function switchGoatBrainAction(brainRef: string): Promise<GoatWorkspaceActionResult> {
  const response = await (await serverApiClient()).v1.brains[":brainId"].switch.$post({
    param: { brainId: brainRef },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: await serverApiErrorMessage(response, "You do not have access to that brain."),
    };
  }
  const { brainId } = (await response.json()).data;

  const cookieStore = await cookies();
  cookieStore.set(GOAT_ACTIVE_BRAIN_COOKIE, brainId, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function switchGoatWorkspaceAction(
  workspaceId: string,
): Promise<GoatWorkspaceActionResult> {
  let activation: {
    workspaceId: string;
    organizationId: string;
    brainId: string | null;
  };
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
    console.error("[goat] Failed to resolve workspace activation", {
      workspaceId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { ok: false, error: ACTIVATE_WORKSPACE_ERROR_MESSAGE };
  }

  try {
    await activateGoatWorkspace({
      workspaceId: activation.workspaceId,
      workosOrganizationId: activation.organizationId,
      brainId: activation.brainId,
    });
  } catch (error) {
    // AuthKit uses redirects for organization-specific SSO and MFA. Preserve
    // that framework control flow while translating ordinary refresh failures
    // into the server action's inline-error contract.
    unstable_rethrow(error);
    console.error("[goat] Failed to activate workspace organization", {
      workspaceId: activation.workspaceId,
      workosOrganizationId: activation.organizationId,
      error,
    });
    return { ok: false, error: ACTIVATE_WORKSPACE_ERROR_MESSAGE };
  }

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function createGoatWorkspaceAction(name: unknown): Promise<GoatWorkspaceCreateResult> {
  const validation = validateWorkspaceName(name);
  if (!validation.ok) return validation;

  const workspaceId = `goat_ws_${randomUUID()}`;
  let activation: {
    workspaceId: string;
    organizationId: string;
    brainId: string | null;
  };
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
    console.error("[goat] Failed to create workspace through the canonical API", {
      workspaceId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { ok: false, error: CREATE_WORKSPACE_ERROR_MESSAGE };
  }

  try {
    await activateGoatWorkspace({
      workspaceId: activation.workspaceId,
      workosOrganizationId: activation.organizationId,
      brainId: activation.brainId,
    });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[goat] Failed to activate newly created workspace organization", {
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

export async function createGoatBrainAction(input: {
  name: string;
  visibility: GoatBrainVisibility;
  description?: string;
}): Promise<GoatWorkspaceActionResult & { brainRef?: string }> {
  try {
    const response = await (await serverApiClient()).v1.brains.$post({
      json: {
        name: input.name,
        visibility: input.visibility,
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not create the brain."),
      };
    }
    const { brainId } = (await response.json()).data;
    const cookieStore = await cookies();
    cookieStore.set(GOAT_ACTIVE_BRAIN_COOKIE, brainId, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
    revalidatePath("/", "layout");
    return { ok: true, brainRef: brainId };
  } catch (error) {
    return errorResult(error, "Could not create the brain.");
  }
}

export async function setGoatBrainAccessAction(input: {
  brainRef: string;
  visibility: GoatBrainVisibility;
  memberWorkosIds: string[];
}): Promise<GoatWorkspaceActionResult> {
  try {
    const response = await (await serverApiClient()).v1.brains[":brainId"].access.$put({
      param: { brainId: input.brainRef },
      json: { visibility: input.visibility, memberIds: input.memberWorkosIds },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not update brain access."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not update brain access.");
  }
}

export async function getGoatBrainAccessDetailsAction(brainRef: string): Promise<{
  visibility: GoatBrainVisibility;
  memberWorkosIds: string[];
  workspaceMembers: GoatWorkspaceMemberView[];
} | null> {
  const response = await (await serverApiClient()).v1.brains[":brainId"].access.$get({
    param: { brainId: brainRef },
  });
  if (!response.ok) return null;
  const data = (await response.json()).data;
  return {
    visibility: data.visibility,
    memberWorkosIds: data.memberIds,
    workspaceMembers: data.workspaceMembers.map(
      (member: {
        id: string;
        email: string;
        name: string;
        avatarUrl: string | null;
        role: "admin" | "member";
      }) => ({
        userWorkosId: member.id,
        email: member.email,
        name: member.name,
        avatarUrl: member.avatarUrl,
        role: member.role,
      }),
    ),
  };
}

export async function getGoatBrainEnrichmentEnabledAction(
  brainRef: string,
): Promise<{ enabled: boolean } | null> {
  const response = await (await serverApiClient()).v1.brains[":brainId"].enrichment.$get({
    param: { brainId: brainRef },
  });
  if (!response.ok) return null;
  return (await response.json()).data;
}

export async function setGoatBrainEnrichmentAction(input: {
  brainRef: string;
  enabled: boolean;
}): Promise<GoatWorkspaceActionResult> {
  try {
    const response = await (await serverApiClient()).v1.brains[":brainId"].enrichment.$put({
      param: { brainId: input.brainRef },
      json: { enabled: input.enabled },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not update enrichment."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not update enrichment.");
  }
}

export async function getGoatBrainIntelligenceAction(
  brainRef: string,
): Promise<{ intelligence: GoatBrainIntelligence } | null> {
  const response = await (await serverApiClient()).v1.brains[":brainId"].intelligence.$get({
    param: { brainId: brainRef },
  });
  if (!response.ok) return null;
  return (await response.json()).data;
}

export async function setGoatBrainIntelligenceAction(input: {
  brainRef: string;
  intelligence: GoatBrainIntelligence;
}): Promise<GoatWorkspaceActionResult> {
  if (input.intelligence !== "basic" && input.intelligence !== "frontier") {
    return { ok: false, error: "Unknown intelligence tier." };
  }
  try {
    const response = await (await serverApiClient()).v1.brains[":brainId"].intelligence.$put({
      param: { brainId: input.brainRef },
      json: { intelligence: input.intelligence },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not update intelligence."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not update intelligence.");
  }
}

export async function listGoatWorkspaceMembersAction(): Promise<GoatWorkspaceMemberView[]> {
  const settings = await getGoatWorkspaceSettingsAction();
  return settings.members;
}

export async function inviteToGoatWorkspaceAction(
  email: string,
): Promise<GoatWorkspaceActionResult> {
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
    console.error("[goat] Failed to send workspace invitation", error);
    return errorResult(error, "Could not send the invitation.");
  }
}

export async function listGoatWorkspaceInvitationsAction(): Promise<GoatWorkspaceInvitationView[]> {
  try {
    const settings = await getGoatWorkspaceSettingsAction();
    return settings.invitations;
  } catch (error) {
    console.error("[goat] Failed to list workspace invitations", error);
    return [];
  }
}

export async function revokeGoatWorkspaceInvitationAction(
  invitationId: string,
): Promise<GoatWorkspaceActionResult> {
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

export async function removeGoatWorkspaceMemberAction(
  userWorkosId: string,
): Promise<GoatWorkspaceActionResult> {
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

export async function updateGoatWorkspaceNameAction(
  name: string,
): Promise<GoatWorkspaceActionResult> {
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

export async function getGoatWorkspaceSettingsAction(): Promise<{
  workspace: { id: string; name: string };
  role: "admin" | "member";
  plan: "hobby" | "pro";
  memberCap: number;
  members: GoatWorkspaceMemberView[];
  invitations: GoatWorkspaceInvitationView[];
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
        avatarUrl: string | null;
        role: "admin" | "member";
      }) => ({
        userWorkosId: member.id,
        email: member.email,
        name: member.name,
        avatarUrl: member.avatarUrl,
        role: member.role,
      }),
    ),
    invitations: settings.invitations,
  };
}
