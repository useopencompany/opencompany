// Wiki management: create a named wiki, edit its name and instructions, and set
// who can reach it. Mirrors ./brain-control, which solved the same problem for
// the predecessor Brain entity.
//
// This is the *management* surface only. Reading and writing wiki content is
// authorized inside @opencompany/core (KnowledgeApplicationService and
// WikiCommandApplicationService), because chat, MCP, and the runner all enter
// there and a route-level check would leave those paths open.

import type { Actor } from "@opencompany/core";
import type { WikiAccessLevel } from "@opencompany/db/product-schema";
import {
  createWiki,
  listWikiMemberIds,
  listWikisForUser,
  replaceWikiMembers,
  resolveWikiForUser,
  updateWikiAccess,
  updateWikiSettings,
  WikiAccessError,
} from "@opencompany/db/wikis";
import { listWorkspaceMembers } from "@opencompany/db/workspaces";
import { ApiError } from "./errors";

// Follows the repo-wide injectable-db convention for services that only need a
// drizzle handle without dragging the full inferred schema type across packages.
type DbLike = any;

export type WikiControlMember = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "admin" | "member";
};

export type WikiControlView = {
  id: string;
  name: string;
  slug: string;
  instructions: string;
  access: WikiAccessLevel;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type WikiControlAccessView = {
  access: WikiAccessLevel;
  memberIds: string[];
  workspaceMembers: WikiControlMember[];
};

export type WikiControlService = {
  listWikis(actor: Actor): Promise<WikiControlView[]>;
  createWiki(
    actor: Actor,
    input: { name: string; access: WikiAccessLevel; instructions?: string },
  ): Promise<WikiControlView>;
  updateWiki(
    actor: Actor,
    wikiId: string,
    input: { name?: string; instructions?: string },
  ): Promise<WikiControlView>;
  getAccess(actor: Actor, wikiId: string): Promise<WikiControlAccessView>;
  setAccess(
    actor: Actor,
    wikiId: string,
    input: { access: WikiAccessLevel; memberIds: string[] },
  ): Promise<WikiControlAccessView>;
};

export function createWikiControlService(input: { db: DbLike }): WikiControlService {
  const db = input.db;

  async function requireReachableWiki(actor: Actor, wikiId: string) {
    const wiki = await resolveWikiForUser(
      { userWorkosId: actor.userId, workspaceId: actor.workspaceId, wikiId },
      { db },
    );
    // A restricted wiki the actor cannot reach is reported as absent, so its
    // existence cannot be probed by iterating ids.
    if (!wiki) throw new ApiError(404, "not_found", "Wiki not found in this workspace.");
    return wiki;
  }

  /**
   * Any workspace member may create a wiki — in a small team, gating that behind
   * an admin is friction with no security benefit, since a restricted wiki is
   * only reachable by the people its creator invites. Changing an *existing*
   * wiki is narrower: only its creator or an admin, so a member cannot restrict
   * a shared wiki someone else set up and lock the rest of the team out of it.
   */
  async function requireWikiOwner(actor: Actor, wikiId: string) {
    const wiki = await requireReachableWiki(actor, wikiId);
    if (actor.role !== "admin" && wiki.createdByWorkosId !== actor.userId) {
      throw new ApiError(403, "forbidden", "Only an admin or the wiki's creator can change it.");
    }
    return wiki;
  }

  async function accessView(
    actor: Actor,
    wikiId: string,
    access: WikiAccessLevel,
  ): Promise<WikiControlAccessView> {
    const [memberIds, members] = await Promise.all([
      listWikiMemberIds(wikiId, { db }),
      listWorkspaceMembers(actor.workspaceId, { db }),
    ]);
    return { access, memberIds, workspaceMembers: members.map(workspaceMemberView) };
  }

  return {
    async listWikis(actor) {
      const wikis = await listWikisForUser(
        { userWorkosId: actor.userId, workspaceId: actor.workspaceId },
        { db },
      );
      return wikis.map(wikiView);
    },

    async createWiki(actor, command) {
      try {
        const wiki = await createWiki(
          {
            workspaceId: actor.workspaceId,
            name: command.name,
            access: command.access,
            ...(command.instructions !== undefined ? { instructions: command.instructions } : {}),
            createdByWorkosId: actor.userId,
          },
          { db },
        );
        return wikiView(wiki);
      } catch (error) {
        throw wikiControlError(error);
      }
    },

    async updateWiki(actor, wikiId, command) {
      await requireWikiOwner(actor, wikiId);
      try {
        const wiki = await updateWikiSettings(
          {
            wikiId,
            ...(command.name !== undefined ? { name: command.name } : {}),
            ...(command.instructions !== undefined ? { instructions: command.instructions } : {}),
          },
          { db },
        );
        return wikiView(wiki);
      } catch (error) {
        throw wikiControlError(error);
      }
    },

    async getAccess(actor, wikiId) {
      const wiki = await requireReachableWiki(actor, wikiId);
      return accessView(actor, wikiId, wiki.access);
    },

    async setAccess(actor, wikiId, command) {
      const wiki = await requireWikiOwner(actor, wikiId);
      // The default wiki is what every entry point without a selector resolves
      // to, so restricting it would cut the rest of the workspace off from the
      // wiki their agents write to.
      if (wiki.isDefault && command.access === "restricted") {
        throw new ApiError(
          400,
          "invalid_request",
          "The default wiki is always available to the workspace. Create a separate wiki to share with specific people.",
        );
      }
      const workspaceMembers = await listWorkspaceMembers(actor.workspaceId, { db });
      const allowed = new Set(
        workspaceMembers.map(
          (entry: { user: { workosUserId: string } }) => entry.user.workosUserId,
        ),
      );
      if (command.memberIds.some((memberId) => !allowed.has(memberId))) {
        throw new ApiError(400, "invalid_request", "A selected member is not in this workspace.");
      }
      await updateWikiAccess(
        { wikiId, access: command.access, actingUserWorkosId: actor.userId },
        { db },
      );
      if (command.access === "restricted") {
        await replaceWikiMembers(
          {
            wikiId,
            // The acting user always keeps access, so a restricted wiki can
            // never be left with no one able to reach it.
            userWorkosIds: [...new Set([...command.memberIds, actor.userId])],
            addedByWorkosId: actor.userId,
          },
          { db },
        );
      }
      return accessView(actor, wikiId, command.access);
    },
  };
}

function wikiView(wiki: {
  id: string;
  name: string;
  slug: string;
  instructions: string;
  access: WikiAccessLevel;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): WikiControlView {
  return {
    id: wiki.id,
    name: wiki.name,
    slug: wiki.slug,
    instructions: wiki.instructions,
    access: wiki.access,
    isDefault: wiki.isDefault,
    createdAt: wiki.createdAt,
    updatedAt: wiki.updatedAt,
  };
}

function wikiControlError(error: unknown) {
  if (error instanceof WikiAccessError) {
    return new ApiError(400, "invalid_request", error.message);
  }
  return error;
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
}): WikiControlMember {
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
