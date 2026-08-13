import type { Actor } from "@opencompany/core";
import type { GoatBrainIntelligence, GoatBrainVisibility } from "@opencompany/db/goat-schema";
import {
  createGoatBrain,
  getGoatBrainAccess,
  listGoatBrainMemberIds,
  listGoatWorkspaceMembers,
  replaceGoatBrainMembers,
  updateGoatBrainEnrichmentEnabled,
  updateGoatBrainIntelligence,
  updateGoatBrainVisibility,
} from "@opencompany/db/goat-workspaces";
import { ApiError } from "./errors";

// Follows the repo-wide injectable-db convention for services that only need a
// drizzle handle without dragging the full inferred schema type across packages.
type DbLike = any;

export type BrainControlMember = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "admin" | "member";
};

export type BrainControlService = {
  switchBrain(actor: Actor, brainId: string): Promise<{ brainId: string }>;
  createBrain(
    actor: Actor,
    input: { name: string; visibility: GoatBrainVisibility; description?: string },
  ): Promise<{ brainId: string }>;
  getAccess(
    actor: Actor,
    brainId: string,
  ): Promise<{
    visibility: GoatBrainVisibility;
    memberIds: string[];
    workspaceMembers: BrainControlMember[];
  }>;
  setAccess(
    actor: Actor,
    brainId: string,
    input: { visibility: GoatBrainVisibility; memberIds: string[] },
  ): Promise<void>;
  getEnrichment(actor: Actor, brainId: string): Promise<{ enabled: boolean }>;
  setEnrichment(actor: Actor, brainId: string, enabled: boolean): Promise<void>;
  getIntelligence(actor: Actor, brainId: string): Promise<{ intelligence: GoatBrainIntelligence }>;
  setIntelligence(
    actor: Actor,
    brainId: string,
    intelligence: GoatBrainIntelligence,
  ): Promise<void>;
};

export function createBrainControlService(input: { db: DbLike }): BrainControlService {
  const db = input.db;
  return {
    async switchBrain(actor, brainId) {
      await requireWorkspaceBrain(db, actor, brainId);
      return { brainId };
    },

    async createBrain(actor, command) {
      requireAdmin(actor, "Only workspace admins can create brains.");
      const brain = await createGoatBrain(
        {
          workspaceId: actor.workspaceId,
          name: command.name,
          visibility: command.visibility,
          description: command.description ?? null,
          createdByWorkosId: actor.userId,
        },
        { db },
      );
      return { brainId: brain.id };
    },

    async getAccess(actor, brainId) {
      requireAdmin(actor, "Only workspace admins can view brain access.");
      const access = await requireWorkspaceBrain(db, actor, brainId);
      const [memberIds, members] = await Promise.all([
        listGoatBrainMemberIds(brainId, { db }),
        listGoatWorkspaceMembers(actor.workspaceId, { db }),
      ]);
      return {
        visibility: access.brain.visibility,
        memberIds,
        workspaceMembers: members.map(workspaceMemberView),
      };
    },

    async setAccess(actor, brainId, command) {
      requireAdmin(actor, "Only workspace admins can change brain access.");
      await requireWorkspaceBrain(db, actor, brainId);
      const workspaceMembers = await listGoatWorkspaceMembers(actor.workspaceId, { db });
      const allowed = new Set(workspaceMembers.map((entry) => entry.user.workosUserId));
      if (command.memberIds.some((memberId) => !allowed.has(memberId))) {
        throw new ApiError(400, "invalid_request", "A selected member is not in this workspace.");
      }
      await updateGoatBrainVisibility(
        {
          brainRef: brainId,
          visibility: command.visibility,
          actingUserWorkosId: actor.userId,
        },
        { db },
      );
      if (command.visibility === "restricted") {
        await replaceGoatBrainMembers(
          {
            brainRef: brainId,
            userWorkosIds: [...new Set([...command.memberIds, actor.userId])],
            addedByWorkosId: actor.userId,
          },
          { db },
        );
      }
    },

    async getEnrichment(actor, brainId) {
      requireAdmin(actor, "Only workspace admins can view enrichment settings.");
      const access = await requireWorkspaceBrain(db, actor, brainId);
      return { enabled: access.brain.enrichmentEnabled };
    },

    async setEnrichment(actor, brainId, enabled) {
      requireAdmin(actor, "Only workspace admins can change enrichment.");
      await requireWorkspaceBrain(db, actor, brainId);
      await updateGoatBrainEnrichmentEnabled({ brainRef: brainId, enabled }, { db });
    },

    async getIntelligence(actor, brainId) {
      requireAdmin(actor, "Only workspace admins can view intelligence settings.");
      const access = await requireWorkspaceBrain(db, actor, brainId);
      return { intelligence: access.brain.intelligence };
    },

    async setIntelligence(actor, brainId, intelligence) {
      requireAdmin(actor, "Only workspace admins can change intelligence.");
      await requireWorkspaceBrain(db, actor, brainId);
      await updateGoatBrainIntelligence({ brainRef: brainId, intelligence }, { db });
    },
  };
}

function requireAdmin(actor: Actor, message: string) {
  if (actor.role !== "admin") throw new ApiError(403, "forbidden", message);
}

async function requireWorkspaceBrain(db: DbLike, actor: Actor, brainId: string) {
  const access = await getGoatBrainAccess(
    { userWorkosId: actor.userId, brainRef: brainId },
    { db },
  );
  if (!access || access.brain.workspaceId !== actor.workspaceId) {
    throw new ApiError(404, "not_found", "Brain not found in this workspace.");
  }
  return access;
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
}): BrainControlMember {
  return {
    id: entry.user.workosUserId,
    email: entry.user.email,
    name:
      [entry.user.firstName, entry.user.lastName].filter(Boolean).join(" ").trim() ||
      entry.user.email,
    avatarUrl: entry.user.avatarUrl,
    role: entry.member.role,
  };
}
