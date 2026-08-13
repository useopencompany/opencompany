"use server";

import { getDb } from "@opencompany/db/client";
import { getGoatWorkspacePlan, goatWorkspaceMemberCap } from "@opencompany/db/goat-billing";
import { goatWorkspaces } from "@opencompany/db/goat-schema";
import {
  DEFAULT_GOAT_BRAIN_SLUG,
  hasOwnedGoatHobbyWorkspace,
  listAccessibleGoatBrains,
  listGoatWorkspaceMembers,
  listGoatWorkspacesForUser,
  removeGoatWorkspaceMember,
  updateGoatWorkspaceName,
} from "@opencompany/db/goat-workspaces";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { currentGoatUser } from "@/lib/auth";
import { syncGoatStripeSeatQuantityForWorkspace } from "@/lib/billing/seats";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";
import { getWorkOSClient } from "@/lib/workos-client";
import { ensureGoatWorkspaceOrganization } from "@/lib/workos-organizations";
import {
  GoatWorkspaceProvisioningError,
  provisionGoatWorkspace,
} from "@/lib/workspace-provisioning";
import { activateGoatWorkspace, GOAT_ACTIVE_BRAIN_COOKIE } from "@/lib/workspace-session";

const MEMBER_ROLE = "member";
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
  const context = await currentGoatUser();
  const workspaces = await listGoatWorkspacesForUser(context.user.workosUserId);
  const target = workspaces.find((entry) => entry.workspace.id === workspaceId);
  if (!target) return { ok: false, error: "You do not have access to that workspace." };
  if (!target.workspace.workosOrganizationId) {
    return { ok: false, error: "That workspace is not linked to a WorkOS organization." };
  }

  const brains = await listAccessibleGoatBrains({
    userWorkosId: context.user.workosUserId,
    workspaceId: target.workspace.id,
  });
  const activeBrain =
    brains.find((brain) => brain.slug === DEFAULT_GOAT_BRAIN_SLUG) ?? brains[0] ?? null;

  try {
    await activateGoatWorkspace({
      workspaceId: target.workspace.id,
      workosOrganizationId: target.workspace.workosOrganizationId,
      brainId: activeBrain?.id ?? null,
    });
  } catch (error) {
    // AuthKit uses redirects for organization-specific SSO and MFA. Preserve
    // that framework control flow while translating ordinary refresh failures
    // into the server action's inline-error contract.
    unstable_rethrow(error);
    console.error("[goat] Failed to activate workspace organization", {
      workspaceId: target.workspace.id,
      workosOrganizationId: target.workspace.workosOrganizationId,
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

  const context = await currentGoatUser();
  try {
    if (await hasOwnedGoatHobbyWorkspace(context.user.workosUserId)) {
      return {
        ok: false,
        error:
          "Hobby includes one workspace. Upgrade your Hobby workspace to Pro to create another.",
      };
    }
  } catch (error) {
    console.error("[goat] Failed to verify Hobby workspace ownership", error);
    return { ok: false, error: CREATE_WORKSPACE_ERROR_MESSAGE };
  }
  let created: Awaited<ReturnType<typeof provisionGoatWorkspace>>;
  try {
    created = await provisionGoatWorkspace({
      authUserId: context.authUser.id,
      userWorkosId: context.user.workosUserId,
      name: validation.name,
    });
  } catch (error) {
    const provisioning = error instanceof GoatWorkspaceProvisioningError ? error : null;
    console.error("[goat] Failed to create workspace organization", {
      workspaceId: provisioning?.workspaceId,
      workosOrganizationId: provisioning?.workosOrganizationId,
      localWorkspacePersisted: provisioning?.localWorkspacePersisted,
      error,
    });
    return { ok: false, error: CREATE_WORKSPACE_ERROR_MESSAGE };
  }

  try {
    await activateGoatWorkspace({
      workspaceId: created.workspace.id,
      workosOrganizationId: created.workspace.workosOrganizationId,
      brainId: created.brain.id,
    });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[goat] Failed to activate newly created workspace organization", {
      workspaceId: created.workspace.id,
      workosOrganizationId: created.workspace.workosOrganizationId,
      error,
    });
    // The WorkOS organization and local workspace are durable at this point.
    // Keep them intact and invalidate the picker so the user can retry the
    // switch instead of creating a duplicate organization.
    revalidatePath("/", "layout");
    return { ok: false, error: ACTIVATE_CREATED_WORKSPACE_ERROR_MESSAGE };
  }
  revalidatePath("/", "layout");
  return { ok: true, workspaceId: created.workspace.id };
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
    // Members plus pending invites must stay under the plan limit. Acceptance
    // races can still overshoot by one or two
    // — the adoption path deliberately never blocks a sign-in — so this check
    // plus the members-panel over-cap banner is the enforcement.
    const [members, invitations, plan] = await Promise.all([
      listGoatWorkspaceMembers(context.workspace.id),
      listGoatWorkspaceInvitationsAction(),
      getGoatWorkspacePlan(context.workspace.id),
    ]);
    const memberCap = goatWorkspaceMemberCap(plan);
    if (members.length + invitations.length >= memberCap) {
      return {
        ok: false,
        error:
          memberCap === 1
            ? "Hobby includes one member. Upgrade to Pro to invite teammates."
            : `Workspaces allow up to ${memberCap} members (including pending invites). Remove a member or revoke an invite first.`,
      };
    }
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
    await syncGoatStripeSeatQuantityForWorkspace(context.workspace.id).catch((error) => {
      console.error("[goat] Failed to sync Stripe seat quantity after member removal", error);
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
  plan: "hobby" | "pro";
  memberCap: number;
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
  const [members, invitations, plan] = await Promise.all([
    listGoatWorkspaceMembersAction(),
    listGoatWorkspaceInvitationsAction(),
    getGoatWorkspacePlan(context.workspace.id),
  ]);
  return {
    workspace: {
      id: context.workspace.id,
      name: workspaceRow?.name ?? context.workspace.name,
    },
    role: context.role,
    plan,
    memberCap: goatWorkspaceMemberCap(plan),
    members,
    invitations,
  };
}
