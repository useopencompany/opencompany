import { syncGoatStripeSeatQuantityForWorkspace } from "@opencompany/billing/seats";
import type { Actor } from "@opencompany/core";
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
import { ensureGoatWorkspaceOrganization } from "@opencompany/goat-agent/workspaces/organizations";
import {
  GoatWorkspaceProvisioningError,
  provisionGoatWorkspace,
} from "@opencompany/goat-agent/workspaces/provisioning";
import { createLogger } from "@opencompany/observability";
import type { WorkOS } from "@workos-inc/node";
import { eq } from "drizzle-orm";
import { ApiError } from "./errors";

type DbLike = any;

const logger = createLogger({ service: "opencompany-api", runtime: "workspace-control" });
const MEMBER_ROLE = "member";

export type WorkspaceMemberView = {
  id: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  role: "admin" | "member";
};

export type WorkspaceInvitationView = {
  id: string;
  email: string;
  state: string;
  expiresAt: string | null;
};

export type WorkspaceSettingsView = {
  workspace: { id: string; name: string };
  role: "admin" | "member";
  plan: "hobby" | "pro";
  memberCap: number;
  members: WorkspaceMemberView[];
  invitations: WorkspaceInvitationView[];
};

export type WorkspaceActivationView = {
  workspaceId: string;
  organizationId: string;
  brainId: string | null;
};

export type WorkspaceControlService = {
  getSettings(actor: Actor): Promise<WorkspaceSettingsView>;
  invite(actor: Actor, email: string): Promise<void>;
  revokeInvitation(actor: Actor, invitationId: string): Promise<void>;
  removeMember(actor: Actor, userId: string): Promise<void>;
  rename(actor: Actor, name: string): Promise<{ id: string; name: string }>;
  create(
    actor: Actor,
    input: { workspaceId: string; name: string },
  ): Promise<WorkspaceActivationView>;
  switch(actor: Actor, workspaceId: string): Promise<WorkspaceActivationView>;
};

export function createWorkspaceControlService(input: {
  db: DbLike;
  workos: WorkOS;
}): WorkspaceControlService {
  const { db, workos } = input;

  async function currentWorkspace(actor: Actor) {
    const [workspace] = await db
      .select()
      .from(goatWorkspaces)
      .where(eq(goatWorkspaces.id, actor.workspaceId))
      .limit(1);
    if (!workspace) throw new ApiError(404, "not_found", "Workspace not found.");
    return workspace;
  }

  async function listInvitations(
    actor: Actor,
    organizationId: string | null,
    swallowFailure: boolean,
  ): Promise<WorkspaceInvitationView[]> {
    if (actor.role !== "admin" || !organizationId) return [];
    try {
      const result = await workos.userManagement.listInvitations({ organizationId });
      return result.data
        .filter((invitation) => invitation.state === "pending")
        .map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          state: invitation.state,
          expiresAt: invitation.expiresAt ?? null,
        }));
    } catch (error) {
      if (!swallowFailure) throw error;
      logger.warn("Workspace invitation list unavailable", {
        event: "opencompany.api_workspace_invitations_list_failed",
        workspace_id: actor.workspaceId,
        error_name: error instanceof Error ? error.name : typeof error,
      });
      return [];
    }
  }

  return {
    async getSettings(actor) {
      const workspace = await currentWorkspace(actor);
      const [members, invitations, plan] = await Promise.all([
        listGoatWorkspaceMembers(actor.workspaceId, { db }),
        listInvitations(actor, workspace.workosOrganizationId, true),
        getGoatWorkspacePlan(actor.workspaceId, { db }),
      ]);
      return {
        workspace: { id: workspace.id, name: workspace.name },
        role: actor.role === "admin" ? "admin" : "member",
        plan,
        memberCap: goatWorkspaceMemberCap(plan),
        members: members.map(workspaceMemberView),
        invitations,
      };
    },

    async invite(actor, rawEmail) {
      requireAdmin(actor, "Only workspace admins can invite members.");
      const email = rawEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ApiError(400, "invalid_request", "Enter a valid email address.");
      }
      const workspace = await currentWorkspace(actor);
      const [members, invitations, plan] = await Promise.all([
        listGoatWorkspaceMembers(actor.workspaceId, { db }),
        listInvitations(actor, workspace.workosOrganizationId, true),
        getGoatWorkspacePlan(actor.workspaceId, { db }),
      ]);
      const memberCap = goatWorkspaceMemberCap(plan);
      if (members.length + invitations.length >= memberCap) {
        throw new ApiError(
          409,
          "conflict",
          memberCap === 1
            ? "Hobby includes one member. Upgrade to Pro to invite teammates."
            : `Workspaces allow up to ${memberCap} members (including pending invites). Remove a member or revoke an invite first.`,
        );
      }
      const organizationId = await ensureGoatWorkspaceOrganization(workspace, { workos, db });
      await workos.userManagement.sendInvitation({
        email,
        organizationId,
        inviterUserId: actor.userId,
        roleSlug: MEMBER_ROLE,
      });
    },

    async revokeInvitation(actor, invitationId) {
      requireAdmin(actor, "Only workspace admins can revoke invitations.");
      const workspace = await currentWorkspace(actor);
      if (!workspace.workosOrganizationId) {
        throw new ApiError(404, "not_found", "Invitation not found in this workspace.");
      }
      const invitations = await listInvitations(actor, workspace.workosOrganizationId, false);
      if (!invitations.some((invitation) => invitation.id === invitationId)) {
        throw new ApiError(404, "not_found", "Invitation not found in this workspace.");
      }
      await workos.userManagement.revokeInvitation(invitationId);
    },

    async removeMember(actor, userId) {
      requireAdmin(actor, "Only workspace admins can remove members.");
      if (userId === actor.userId) {
        throw new ApiError(
          400,
          "invalid_request",
          "You cannot remove yourself from the workspace.",
        );
      }
      const [workspace, members] = await Promise.all([
        currentWorkspace(actor),
        listGoatWorkspaceMembers(actor.workspaceId, { db }),
      ]);
      if (!members.some((entry) => entry.user.workosUserId === userId)) {
        throw new ApiError(404, "not_found", "Member not found in this workspace.");
      }
      if (workspace.workosOrganizationId) {
        const memberships = await workos.userManagement.listOrganizationMemberships({
          userId,
          organizationId: workspace.workosOrganizationId,
        });
        for (const membership of memberships.data) {
          await workos.userManagement.deleteOrganizationMembership(membership.id);
        }
      }
      await removeGoatWorkspaceMember(
        { workspaceId: actor.workspaceId, userWorkosId: userId },
        { db },
      );
      await syncGoatStripeSeatQuantityForWorkspace(actor.workspaceId, { db }).catch((error) => {
        logger.warn("Stripe seat sync failed after workspace member removal", {
          event: "opencompany.api_workspace_seat_sync_failed",
          workspace_id: actor.workspaceId,
          error_name: error instanceof Error ? error.name : typeof error,
        });
      });
    },

    async rename(actor, rawName) {
      requireAdmin(actor, "Only workspace admins can rename the workspace.");
      const name = validWorkspaceName(rawName);
      const workspace = await currentWorkspace(actor);
      if (workspace.workosOrganizationId) {
        await workos.organizations.updateOrganization({
          organization: workspace.workosOrganizationId,
          name,
        });
      }
      await updateGoatWorkspaceName({ workspaceId: actor.workspaceId, name }, { db });
      return { id: actor.workspaceId, name };
    },

    async create(actor, command) {
      const name = validWorkspaceName(command.name);
      if (await hasOwnedGoatHobbyWorkspace(actor.userId, { db })) {
        const replay = await findWorkspaceActivation(actor, command.workspaceId, db);
        if (replay) return replay;
        throw new ApiError(
          409,
          "conflict",
          "Hobby includes one workspace. Upgrade your Hobby workspace to Pro to create another.",
        );
      }
      let created: Awaited<ReturnType<typeof provisionGoatWorkspace>>;
      try {
        created = await provisionGoatWorkspace(
          {
            authUserId: actor.userId,
            userWorkosId: actor.userId,
            workspaceId: command.workspaceId,
            name,
          },
          { workos, db },
        );
      } catch (error) {
        if (!(error instanceof GoatWorkspaceProvisioningError)) throw error;
        logger.error("Workspace provisioning failed", {
          event: "opencompany.api_workspace_provisioning_failed",
          workspace_id: command.workspaceId,
          error_name: error.name,
        });
        throw new ApiError(
          503,
          "unavailable",
          "Could not create the organization. Please try again.",
          true,
        );
      }
      const organizationId = created.workspace.workosOrganizationId;
      if (!organizationId) {
        throw new ApiError(500, "internal_error", "The workspace organization is missing.", true);
      }
      return {
        workspaceId: created.workspace.id,
        organizationId,
        brainId: created.brain.id,
      };
    },

    async switch(actor, workspaceId) {
      const activation = await findWorkspaceActivation(actor, workspaceId, db);
      if (!activation) {
        throw new ApiError(404, "not_found", "You do not have access to that workspace.");
      }
      return activation;
    },
  };
}

function requireAdmin(actor: Actor, message: string) {
  if (actor.role !== "admin") throw new ApiError(403, "forbidden", message);
}

function validWorkspaceName(rawName: string) {
  const name = rawName.trim();
  if (!name) throw new ApiError(400, "invalid_request", "Name cannot be empty.");
  if (name.length > 80) {
    throw new ApiError(400, "invalid_request", "Name is too long (max 80 chars).");
  }
  return name;
}

async function findWorkspaceActivation(
  actor: Actor,
  workspaceId: string,
  db: DbLike,
): Promise<WorkspaceActivationView | null> {
  const memberships = await listGoatWorkspacesForUser(actor.userId, { db });
  const target = memberships.find((entry) => entry.workspace.id === workspaceId);
  if (!target?.workspace.workosOrganizationId) return null;
  const brains = await listAccessibleGoatBrains(
    { userWorkosId: actor.userId, workspaceId },
    { db },
  );
  const activeBrain =
    brains.find((brain) => brain.slug === DEFAULT_GOAT_BRAIN_SLUG) ?? brains[0] ?? null;
  return {
    workspaceId,
    organizationId: target.workspace.workosOrganizationId,
    brainId: activeBrain?.id ?? null,
  };
}

function workspaceMemberView(entry: {
  member: { role: "admin" | "member" };
  user: {
    workosUserId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  };
}): WorkspaceMemberView {
  return {
    id: entry.user.workosUserId,
    email: entry.user.email,
    name:
      [entry.user.firstName, entry.user.lastName].filter(Boolean).join(" ").trim() ||
      entry.user.email,
    firstName: entry.user.firstName,
    lastName: entry.user.lastName,
    avatarUrl: entry.user.avatarUrl,
    role: entry.member.role,
  };
}
