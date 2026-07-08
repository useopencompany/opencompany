"use server";

import { getDb } from "@opencompany/db/client";
import {
  type GoatBrainVisibility,
  type GoatWorkspace,
  goatWorkspaces,
} from "@opencompany/db/goat-schema";
import {
  createGoatBrain,
  getGoatBrainAccess,
  listGoatBrainMemberIds,
  listGoatWorkspaceMembers,
  removeGoatWorkspaceMember,
  replaceGoatBrainMembers,
  setGoatWorkspaceOrganizationId,
  updateGoatBrainVisibility,
  updateGoatWorkspaceName,
} from "@opencompany/db/goat-workspaces";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { currentGoatUser, GOAT_ACTIVE_BRAIN_COOKIE } from "@/lib/auth";
import { getWorkOSClient } from "@/lib/workos-client";

const ADMIN_ROLE = "admin";
const MEMBER_ROLE = "member";

export type GoatWorkspaceActionResult = { ok: true } | { ok: false; error: string };

export type GoatWorkspaceMemberView = {
  userWorkosId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "admin" | "member";
};

export type GoatWorkspaceInvitationView = {
  id: string;
  email: string;
  state: string;
  expiresAt: string | null;
};

function errorResult(error: unknown, fallback: string): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

export async function switchGoatBrainAction(brainId: string): Promise<GoatWorkspaceActionResult> {
  const { user } = await currentGoatUser();
  const access = await getGoatBrainAccess({ userWorkosId: user.workosUserId, brainRef: brainId });
  if (!access) return { ok: false, error: "You do not have access to that brain." };

  const cookieStore = await cookies();
  cookieStore.set(GOAT_ACTIVE_BRAIN_COOKIE, access.brain.id, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function createGoatBrainAction(input: {
  name: string;
  visibility: GoatBrainVisibility;
  description?: string;
}): Promise<GoatWorkspaceActionResult & { brainId?: string }> {
  const context = await currentGoatUser();
  try {
    const brain = await createGoatBrain({
      workspaceId: context.workspace.id,
      name: input.name,
      visibility: input.visibility,
      description: input.description ?? null,
      createdByWorkosId: context.user.workosUserId,
    });
    const cookieStore = await cookies();
    cookieStore.set(GOAT_ACTIVE_BRAIN_COOKIE, brain.id, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
    revalidatePath("/", "layout");
    return { ok: true, brainId: brain.id };
  } catch (error) {
    return errorResult(error, "Could not create the brain.");
  }
}

export async function setGoatBrainAccessAction(input: {
  brainId: string;
  visibility: GoatBrainVisibility;
  memberWorkosIds: string[];
}): Promise<GoatWorkspaceActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can change brain access." };
  }
  const access = await getGoatBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef: input.brainId,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) {
    return { ok: false, error: "Brain not found in this workspace." };
  }

  try {
    await updateGoatBrainVisibility({
      brainRef: input.brainId,
      visibility: input.visibility,
      actingUserWorkosId: context.user.workosUserId,
    });
    if (input.visibility === "restricted") {
      const memberIds = new Set(input.memberWorkosIds);
      // The acting admin always keeps access so the brain cannot be orphaned.
      memberIds.add(context.user.workosUserId);
      await replaceGoatBrainMembers({
        brainRef: input.brainId,
        userWorkosIds: [...memberIds],
        addedByWorkosId: context.user.workosUserId,
      });
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not update brain access.");
  }
}

export async function getGoatBrainAccessDetailsAction(brainId: string): Promise<{
  visibility: GoatBrainVisibility;
  memberWorkosIds: string[];
  workspaceMembers: GoatWorkspaceMemberView[];
} | null> {
  const context = await currentGoatUser();
  const access = await getGoatBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef: brainId,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;

  const [memberWorkosIds, workspaceMembers] = await Promise.all([
    listGoatBrainMemberIds(brainId),
    listGoatWorkspaceMembersAction(),
  ]);
  return {
    visibility: access.brain.visibility,
    memberWorkosIds,
    workspaceMembers,
  };
}

export async function listGoatWorkspaceMembersAction(): Promise<GoatWorkspaceMemberView[]> {
  const context = await currentGoatUser();
  const members = await listGoatWorkspaceMembers(context.workspace.id);
  return members.map((entry) => ({
    userWorkosId: entry.user.workosUserId,
    email: entry.user.email,
    name:
      [entry.user.firstName, entry.user.lastName].filter(Boolean).join(" ").trim() ||
      entry.user.email,
    avatarUrl: entry.user.avatarUrl,
    role: entry.member.role,
  }));
}

// Creates the WorkOS organization for a workspace on first need (first invite)
// and backfills memberships for every existing local member.
async function ensureGoatWorkspaceOrganization(workspace: GoatWorkspace): Promise<string> {
  if (workspace.workosOrganizationId) return workspace.workosOrganizationId;

  const workos = getWorkOSClient();
  let organizationId: string | undefined;
  try {
    const organization = await workos.organizations.createOrganization(
      { name: workspace.name },
      { idempotencyKey: workspace.id },
    );
    organizationId = organization.id;

    const members = await listGoatWorkspaceMembers(workspace.id);
    for (const entry of members) {
      await workos.userManagement.createOrganizationMembership({
        organizationId: organization.id,
        userId: entry.user.workosUserId,
        roleSlug: entry.member.role === "admin" ? ADMIN_ROLE : MEMBER_ROLE,
      });
    }

    await setGoatWorkspaceOrganizationId({
      workspaceId: workspace.id,
      workosOrganizationId: organization.id,
    });
    return organization.id;
  } catch (error) {
    if (organizationId) {
      try {
        await workos.organizations.deleteOrganization(organizationId);
      } catch (cleanupError) {
        console.error("[goat] Failed to clean up WorkOS organization", cleanupError);
      }
    }
    throw error;
  }
}

export async function inviteToGoatWorkspaceAction(
  email: string,
): Promise<GoatWorkspaceActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can invite members." };
  }
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  try {
    const organizationId = await ensureGoatWorkspaceOrganization(context.workspace);
    await getWorkOSClient().userManagement.sendInvitation({
      email: trimmed,
      organizationId,
      inviterUserId: context.authUser.id,
      roleSlug: MEMBER_ROLE,
    });
    revalidatePath("/settings/workspace");
    return { ok: true };
  } catch (error) {
    console.error("[goat] Failed to send workspace invitation", error);
    return errorResult(error, "Could not send the invitation.");
  }
}

export async function listGoatWorkspaceInvitationsAction(): Promise<GoatWorkspaceInvitationView[]> {
  const context = await currentGoatUser();
  if (context.role !== "admin" || !context.workspace.workosOrganizationId) return [];

  try {
    const invitations = await getWorkOSClient().userManagement.listInvitations({
      organizationId: context.workspace.workosOrganizationId,
    });
    return invitations.data
      .filter((invitation) => invitation.state === "pending")
      .map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        state: invitation.state,
        expiresAt: invitation.expiresAt ?? null,
      }));
  } catch (error) {
    console.error("[goat] Failed to list workspace invitations", error);
    return [];
  }
}

export async function revokeGoatWorkspaceInvitationAction(
  invitationId: string,
): Promise<GoatWorkspaceActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can revoke invitations." };
  }
  try {
    await getWorkOSClient().userManagement.revokeInvitation(invitationId);
    revalidatePath("/settings/workspace");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not revoke the invitation.");
  }
}

export async function removeGoatWorkspaceMemberAction(
  userWorkosId: string,
): Promise<GoatWorkspaceActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can remove members." };
  }
  if (userWorkosId === context.user.workosUserId) {
    return { ok: false, error: "You cannot remove yourself from the workspace." };
  }

  try {
    if (context.workspace.workosOrganizationId) {
      const workos = getWorkOSClient();
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId: userWorkosId,
        organizationId: context.workspace.workosOrganizationId,
      });
      for (const membership of memberships.data) {
        await workos.userManagement.deleteOrganizationMembership(membership.id);
      }
    }
    await removeGoatWorkspaceMember({
      workspaceId: context.workspace.id,
      userWorkosId,
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not remove the member.");
  }
}

export async function updateGoatWorkspaceNameAction(
  name: string,
): Promise<GoatWorkspaceActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can rename the workspace." };
  }
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name cannot be empty." };
  if (trimmed.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };

  try {
    if (context.workspace.workosOrganizationId) {
      await getWorkOSClient().organizations.updateOrganization({
        organization: context.workspace.workosOrganizationId,
        name: trimmed,
      });
    }
    await updateGoatWorkspaceName({ workspaceId: context.workspace.id, name: trimmed });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not rename the workspace.");
  }
}

export async function getGoatWorkspaceSettingsAction(): Promise<{
  workspace: { id: string; name: string };
  role: "admin" | "member";
  members: GoatWorkspaceMemberView[];
  invitations: GoatWorkspaceInvitationView[];
}> {
  const context = await currentGoatUser();
  const db = getDb();
  const [workspaceRow] = await db
    .select()
    .from(goatWorkspaces)
    .where(eq(goatWorkspaces.id, context.workspace.id))
    .limit(1);
  const [members, invitations] = await Promise.all([
    listGoatWorkspaceMembersAction(),
    listGoatWorkspaceInvitationsAction(),
  ]);
  return {
    workspace: {
      id: context.workspace.id,
      name: workspaceRow?.name ?? context.workspace.name,
    },
    role: context.role,
    members,
    invitations,
  };
}
