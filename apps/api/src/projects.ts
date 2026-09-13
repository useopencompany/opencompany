import {
  type Actor,
  actorHasPermission,
  CHAT_READ_PERMISSION,
  CHAT_WRITE_PERMISSION,
} from "@opencompany/core";
import { chatSessions, projects, users, workspaceMembers } from "@opencompany/db/product-schema";
import type { ProjectDto } from "@opencompany/protocol";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { ApiError } from "./errors";

export type ProjectService = ReturnType<typeof createProjectService>;

// Follows the repo-wide injectable-db convention for services that only need a drizzle handle
// without dragging the full inferred schema type across packages.
type DbLike = any;

/**
 * Sidebar Projects: named folders that group a member's chats and Tasks.
 *
 * Projects are personal to their creator and scoped to one workspace, matching the chat list they
 * reorganize. Membership lives on `chat_sessions.project_id`, so a chat and the conversation
 * behind a Task are filed the same way and a deleted project simply empties back into Recents.
 *
 * Every mutation returns the whole list: it is a handful of rows, and handing back authoritative
 * state means the sidebar never has to reconstruct it from a partial response.
 */
export function createProjectService(input: { db: DbLike; now?: () => Date }) {
  const now = () => input.now?.() ?? new Date();

  async function authorize(actor: Actor, write = false) {
    if (!actorHasPermission(actor, write ? CHAT_WRITE_PERMISSION : CHAT_READ_PERMISSION)) {
      throw new ApiError(403, "forbidden", "You do not have permission to access projects.");
    }
    const [user] = await input.db
      .select({ enabled: users.sidebarProjectsEnabled })
      .from(users)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userWorkosId, users.workosUserId),
          eq(workspaceMembers.workspaceId, actor.workspaceId),
        ),
      )
      .where(eq(users.workosUserId, actor.userId))
      .limit(1);
    if (!user?.enabled) throw new ApiError(404, "not_found", "Projects are not enabled.");
  }

  const ownedProject = (actor: Actor, projectId: string) =>
    and(
      eq(projects.id, projectId),
      eq(projects.userWorkosId, actor.userId),
      eq(projects.workspaceId, actor.workspaceId),
    );

  async function requireProject(actor: Actor, projectId: string) {
    const [project] = await input.db
      .select({ id: projects.id })
      .from(projects)
      .where(ownedProject(actor, projectId))
      .limit(1);
    if (!project) throw new ApiError(404, "not_found", "Project not found.");
  }

  async function list(actor: Actor): Promise<ProjectDto[]> {
    const rows = await input.db
      .select({
        id: projects.id,
        name: projects.name,
        createdAt: projects.createdAt,
        conversationId: chatSessions.id,
      })
      .from(projects)
      .leftJoin(
        chatSessions,
        and(
          eq(chatSessions.projectId, projects.id),
          eq(chatSessions.userWorkosId, actor.userId),
          isNull(chatSessions.closedAt),
        ),
      )
      .where(
        and(eq(projects.userWorkosId, actor.userId), eq(projects.workspaceId, actor.workspaceId)),
      )
      .orderBy(asc(projects.createdAt), asc(projects.id), desc(chatSessions.updatedAt));

    const byId = new Map<string, ProjectDto>();
    for (const row of rows) {
      const existing = byId.get(row.id);
      const project =
        existing ??
        ({
          id: row.id,
          name: row.name,
          conversationIds: [],
          createdAt: new Date(row.createdAt).toISOString(),
        } satisfies ProjectDto);
      if (!existing) byId.set(row.id, project);
      if (row.conversationId) project.conversationIds.push(row.conversationId);
    }
    return [...byId.values()];
  }

  return {
    list: async (actor: Actor) => {
      await authorize(actor);
      return list(actor);
    },

    /**
     * Rejects a project the actor does not own so that filing a new chat under an unknown id fails
     * loudly instead of quietly creating an unfiled conversation.
     */
    async assertOwned(actor: Actor, projectId: string) {
      await authorize(actor, true);
      await requireProject(actor, projectId);
    },

    async create(actor: Actor, command: { id: string; name: string }) {
      await authorize(actor, true);
      // The client retains this id across retries, so a replayed create is a no-op rather than a
      // second folder with the same name.
      await input.db
        .insert(projects)
        .values({
          id: command.id,
          userWorkosId: actor.userId,
          workspaceId: actor.workspaceId,
          name: command.name,
        })
        .onConflictDoNothing();
      await requireProject(actor, command.id);
      return list(actor);
    },

    async rename(actor: Actor, projectId: string, name: string) {
      await authorize(actor, true);
      const [renamed] = await input.db
        .update(projects)
        .set({ name, updatedAt: now() })
        .where(ownedProject(actor, projectId))
        .returning({ id: projects.id });
      if (!renamed) throw new ApiError(404, "not_found", "Project not found.");
      return list(actor);
    },

    async remove(actor: Actor, projectId: string) {
      await authorize(actor, true);
      const [deleted] = await input.db
        .delete(projects)
        .where(ownedProject(actor, projectId))
        .returning({ id: projects.id });
      if (!deleted) throw new ApiError(404, "not_found", "Project not found.");
      return list(actor);
    },

    async fileConversation(actor: Actor, projectId: string, conversationId: string) {
      await authorize(actor, true);
      await requireProject(actor, projectId);
      const [filed] = await input.db
        .update(chatSessions)
        .set({ projectId })
        .where(
          and(eq(chatSessions.id, conversationId), eq(chatSessions.userWorkosId, actor.userId)),
        )
        .returning({ id: chatSessions.id });
      if (!filed) throw new ApiError(404, "not_found", "Conversation not found.");
      return list(actor);
    },

    async removeConversation(actor: Actor, projectId: string, conversationId: string) {
      await authorize(actor, true);
      await requireProject(actor, projectId);
      // Scoped to the project the caller believes the row is in, so a stale sidebar cannot unfile
      // a conversation that has since moved somewhere else.
      const [removed] = await input.db
        .update(chatSessions)
        .set({ projectId: null })
        .where(
          and(
            eq(chatSessions.id, conversationId),
            eq(chatSessions.userWorkosId, actor.userId),
            eq(chatSessions.projectId, projectId),
          ),
        )
        .returning({ id: chatSessions.id });
      if (!removed) throw new ApiError(404, "not_found", "Conversation not found in this project.");
      return list(actor);
    },
  };
}
