"use server";

import { getWorkspacePlan, workspaceMemberCap } from "@opencompany/db/billing";
import { getDb } from "@opencompany/db/client";
import { type BrainIntelligence, type BrainVisibility, workspaces } from "@opencompany/db/schema";
import {
  createBrain,
  createWorkspaceForUser,
  DEFAULT_BRAIN_SLUG,
  getBrainAccess,
  hasOwnedHobbyWorkspace,
  listAccessibleBrains,
  listBrainMemberIds,
  listWorkspaceMembers,
  listWorkspacesForUser,
  newWorkspaceId,
  removeWorkspaceMember,
  replaceBrainMembers,
  updateBrainEnrichmentEnabled,
  updateBrainIntelligence,
  updateBrainVisibility,
  updateWorkspaceName,
} from "@opencompany/db/workspaces";
import { switchToOrganization } from "@workos-inc/authkit-nextjs";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { ACTIVE_BRAIN_COOKIE, ACTIVE_WORKSPACE_COOKIE, currentUser } from "@/lib/auth";
import { syncStripeSeatQuantityForWorkspace } from "@/lib/billing/seats";
import { getWorkOSClient } from "@/lib/workos-client";
import { ensureWorkspaceOrganization } from "@/lib/workos-organizations";

const MEMBER_ROLE = "member";
const ADMIN_ROLE = "admin";
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

async function activateWorkspace(input: {
  workspaceId: string;
  workosOrganizationId: string;
  brainId: string | null;
}) {
  // WorkOS owns the authenticated organization context, including any
  // organization-specific SSO/MFA requirements. the app's cookies only remember
  // which local workspace and brain to render after AuthKit has switched.
  await switchToOrganization(input.workosOrganizationId, {
    revalidationStrategy: "none",
  });

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, input.workspaceId, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  if (input.brainId) {
    cookieStore.set(ACTIVE_BRAIN_COOKIE, input.brainId, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  } else {
    cookieStore.delete(ACTIVE_BRAIN_COOKIE);
  }
}

export async function switchBrainAction(brainRef: string): Promise<WorkspaceActionResult> {
  const { user } = await currentUser();
  const access = await getBrainAccess({ userWorkosId: user.workosUserId, brainRef });
  if (!access) return { ok: false, error: "You do not have access to that brain." };

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_BRAIN_COOKIE, access.brain.id, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function switchWorkspaceAction(workspaceId: string): Promise<WorkspaceActionResult> {
  const context = await currentUser();
  const workspaces = await listWorkspacesForUser(context.user.workosUserId);
  const target = workspaces.find((entry) => entry.workspace.id === workspaceId);
  if (!target) return { ok: false, error: "You do not have access to that workspace." };
  if (!target.workspace.workosOrganizationId) {
    return { ok: false, error: "That workspace is not linked to a WorkOS organization." };
  }

  const brains = await listAccessibleBrains({
    userWorkosId: context.user.workosUserId,
    workspaceId: target.workspace.id,
  });
  const activeBrain =
    brains.find((brain) => brain.slug === DEFAULT_BRAIN_SLUG) ?? brains[0] ?? null;

  try {
    await activateWorkspace({
      workspaceId: target.workspace.id,
      workosOrganizationId: target.workspace.workosOrganizationId,
      brainId: activeBrain?.id ?? null,
    });
  } catch (error) {
    // AuthKit uses redirects for organization-specific SSO and MFA. Preserve
    // that framework control flow while translating ordinary refresh failures
    // into the server action's inline-error contract.
    unstable_rethrow(error);
    console.error("[app] Failed to activate workspace organization", {
      workspaceId: target.workspace.id,
      workosOrganizationId: target.workspace.workosOrganizationId,
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

  const context = await currentUser();
  try {
    if (await hasOwnedHobbyWorkspace(context.user.workosUserId)) {
      return {
        ok: false,
        error:
          "Hobby includes one workspace. Upgrade your Hobby workspace to Pro to create another.",
      };
    }
  } catch (error) {
    console.error("[app] Failed to verify Hobby workspace ownership", error);
    return { ok: false, error: CREATE_WORKSPACE_ERROR_MESSAGE };
  }
  const workspaceId = newWorkspaceId();
  const workos = getWorkOSClient();
  let workosOrganizationId: string | null = null;
  let localWorkspacePersisted = false;
  let created: Awaited<ReturnType<typeof createWorkspaceForUser>> | null = null;

  try {
    const organization = await workos.organizations.createOrganization(
      {
        name: validation.name,
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
      userId: context.authUser.id,
      roleSlug: ADMIN_ROLE,
    });

    created = await createWorkspaceForUser({
      workspaceId,
      workosOrganizationId: organization.id,
      userWorkosId: context.user.workosUserId,
      name: organization.name || validation.name,
    });
    localWorkspacePersisted = true;
  } catch (error) {
    console.error("[app] Failed to create workspace organization", {
      workspaceId,
      workosOrganizationId,
      localWorkspacePersisted,
      error,
    });
    if (workosOrganizationId && !localWorkspacePersisted) {
      try {
        await workos.organizations.deleteOrganization(workosOrganizationId);
      } catch (cleanupError) {
        console.error("[app] Failed to clean up workspace organization", {
          workspaceId,
          workosOrganizationId,
          error: cleanupError,
        });
      }
    }
    return { ok: false, error: CREATE_WORKSPACE_ERROR_MESSAGE };
  }

  try {
    await activateWorkspace({
      workspaceId: created.workspace.id,
      workosOrganizationId: created.workspace.workosOrganizationId ?? workosOrganizationId,
      brainId: created.brain.id,
    });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[app] Failed to activate newly created workspace organization", {
      workspaceId: created.workspace.id,
      workosOrganizationId: created.workspace.workosOrganizationId ?? workosOrganizationId,
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

export async function createBrainAction(input: {
  name: string;
  visibility: BrainVisibility;
  description?: string;
}): Promise<WorkspaceActionResult & { brainRef?: string }> {
  const context = await currentUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can create brains." };
  }
  try {
    const brain = await createBrain({
      workspaceId: context.workspace.id,
      name: input.name,
      visibility: input.visibility,
      description: input.description ?? null,
      createdByWorkosId: context.user.workosUserId,
    });
    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_BRAIN_COOKIE, brain.id, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
    revalidatePath("/", "layout");
    return { ok: true, brainRef: brain.id };
  } catch (error) {
    return errorResult(error, "Could not create the brain.");
  }
}

export async function setBrainAccessAction(input: {
  brainRef: string;
  visibility: BrainVisibility;
  memberWorkosIds: string[];
}): Promise<WorkspaceActionResult> {
  const context = await currentUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can change brain access." };
  }
  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef: input.brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) {
    return { ok: false, error: "Brain not found in this workspace." };
  }

  try {
    await updateBrainVisibility({
      brainRef: input.brainRef,
      visibility: input.visibility,
      actingUserWorkosId: context.user.workosUserId,
    });
    if (input.visibility === "restricted") {
      const memberIds = new Set(input.memberWorkosIds);
      // The acting admin always keeps access so the brain cannot be orphaned.
      memberIds.add(context.user.workosUserId);
      await replaceBrainMembers({
        brainRef: input.brainRef,
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

export async function getBrainAccessDetailsAction(brainRef: string): Promise<{
  visibility: BrainVisibility;
  memberWorkosIds: string[];
  workspaceMembers: WorkspaceMemberView[];
} | null> {
  const context = await currentUser();
  if (context.role !== "admin") return null;
  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;

  const [memberWorkosIds, workspaceMembers] = await Promise.all([
    listBrainMemberIds(brainRef),
    listWorkspaceMembersAction(),
  ]);
  return {
    visibility: access.brain.visibility,
    memberWorkosIds,
    workspaceMembers,
  };
}

export async function getBrainEnrichmentEnabledAction(
  brainRef: string,
): Promise<{ enabled: boolean } | null> {
  const context = await currentUser();
  if (context.role !== "admin") return null;
  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;
  return { enabled: access.brain.enrichmentEnabled };
}

export async function setBrainEnrichmentAction(input: {
  brainRef: string;
  enabled: boolean;
}): Promise<WorkspaceActionResult> {
  const context = await currentUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can change enrichment." };
  }
  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef: input.brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) {
    return { ok: false, error: "Brain not found in this workspace." };
  }
  try {
    await updateBrainEnrichmentEnabled({
      brainRef: input.brainRef,
      enabled: input.enabled,
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not update enrichment.");
  }
}

export async function getBrainIntelligenceAction(
  brainRef: string,
): Promise<{ intelligence: BrainIntelligence } | null> {
  const context = await currentUser();
  if (context.role !== "admin") return null;
  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;
  return { intelligence: access.brain.intelligence };
}

export async function setBrainIntelligenceAction(input: {
  brainRef: string;
  intelligence: BrainIntelligence;
}): Promise<WorkspaceActionResult> {
  const context = await currentUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can change intelligence." };
  }
  if (input.intelligence !== "basic" && input.intelligence !== "frontier") {
    return { ok: false, error: "Unknown intelligence tier." };
  }
  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef: input.brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) {
    return { ok: false, error: "Brain not found in this workspace." };
  }
  try {
    await updateBrainIntelligence({
      brainRef: input.brainRef,
      intelligence: input.intelligence,
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not update intelligence.");
  }
}

export async function listWorkspaceMembersAction(): Promise<WorkspaceMemberView[]> {
  const context = await currentUser();
  const members = await listWorkspaceMembers(context.workspace.id);
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

export async function inviteToWorkspaceAction(email: string): Promise<WorkspaceActionResult> {
  const context = await currentUser();
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
      listWorkspaceMembers(context.workspace.id),
      listWorkspaceInvitationsAction(),
      getWorkspacePlan(context.workspace.id),
    ]);
    const memberCap = workspaceMemberCap(plan);
    if (members.length + invitations.length >= memberCap) {
      return {
        ok: false,
        error:
          memberCap === 1
            ? "Hobby includes one member. Upgrade to Pro to invite teammates."
            : `Workspaces allow up to ${memberCap} members (including pending invites). Remove a member or revoke an invite first.`,
      };
    }
    const organizationId = await ensureWorkspaceOrganization(context.workspace);
    await getWorkOSClient().userManagement.sendInvitation({
      email: trimmed,
      organizationId,
      inviterUserId: context.authUser.id,
      roleSlug: MEMBER_ROLE,
    });
    revalidatePath("/settings/workspace");
    return { ok: true };
  } catch (error) {
    console.error("[app] Failed to send workspace invitation", error);
    return errorResult(error, "Could not send the invitation.");
  }
}

export async function listWorkspaceInvitationsAction(): Promise<WorkspaceInvitationView[]> {
  const context = await currentUser();
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
    console.error("[app] Failed to list workspace invitations", error);
    return [];
  }
}

export async function revokeWorkspaceInvitationAction(
  invitationId: string,
): Promise<WorkspaceActionResult> {
  const context = await currentUser();
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

export async function removeWorkspaceMemberAction(
  userWorkosId: string,
): Promise<WorkspaceActionResult> {
  const context = await currentUser();
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
    await removeWorkspaceMember({
      workspaceId: context.workspace.id,
      userWorkosId,
    });
    await syncStripeSeatQuantityForWorkspace(context.workspace.id).catch((error) => {
      console.error("[app] Failed to sync Stripe seat quantity after member removal", error);
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not remove the member.");
  }
}

export async function updateWorkspaceNameAction(name: string): Promise<WorkspaceActionResult> {
  const context = await currentUser();
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
    await updateWorkspaceName({ workspaceId: context.workspace.id, name: trimmed });
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
  const context = await currentUser();
  const db = getDb();
  const [workspaceRow] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, context.workspace.id))
    .limit(1);
  const [members, invitations, plan] = await Promise.all([
    listWorkspaceMembersAction(),
    listWorkspaceInvitationsAction(),
    getWorkspacePlan(context.workspace.id),
  ]);
  return {
    workspace: {
      id: context.workspace.id,
      name: workspaceRow?.name ?? context.workspace.name,
    },
    role: context.role,
    plan,
    memberCap: workspaceMemberCap(plan),
    members,
    invitations,
  };
}
