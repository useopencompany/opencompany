import { randomUUID } from "node:crypto";
import {
  type Actor,
  actorHasPermission,
  CHAT_READ_PERMISSION,
  CHAT_WRITE_PERMISSION,
} from "@opencompany/core";
import {
  chatSessions,
  codexChatSessions,
  users,
  workspaceMembers,
} from "@opencompany/db/product-schema";
import type { BotDto } from "@opencompany/protocol";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { ApiError } from "./errors";

export type BotService = ReturnType<typeof createBotService>;

export function createBotService(input: { db: any; defaultModel: string }) {
  const columns = {
    id: chatSessions.id,
    name: chatSessions.botName,
    description: chatSessions.botDescription,
  };
  const scope = (actor: Actor) =>
    and(
      eq(chatSessions.userWorkosId, actor.userId),
      eq(codexChatSessions.workspaceId, actor.workspaceId),
      isNotNull(chatSessions.botName),
      isNull(chatSessions.closedAt),
    );
  async function authorize(actor: Actor, write = false) {
    if (!actorHasPermission(actor, write ? CHAT_WRITE_PERMISSION : CHAT_READ_PERMISSION)) {
      throw new ApiError(403, "forbidden", "You do not have permission to access bots.");
    }
    const [user] = await input.db
      .select({ enabled: users.botsEnabled })
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
    if (!user?.enabled) throw new ApiError(404, "not_found", "Bots are not enabled.");
  }
  async function get(actor: Actor, id: string): Promise<BotDto> {
    await authorize(actor);
    const [bot] = await input.db
      .select(columns)
      .from(chatSessions)
      .innerJoin(codexChatSessions, eq(codexChatSessions.chatSessionId, chatSessions.id))
      .where(and(scope(actor), eq(chatSessions.id, id)))
      .limit(1);
    if (!bot) throw new ApiError(404, "not_found", "Bot not found.");
    return bot;
  }
  return {
    get,
    async authorizeConversation(actor: Actor, id: string) {
      const [session] = await input.db
        .select({ name: chatSessions.botName })
        .from(chatSessions)
        .where(and(eq(chatSessions.id, id), eq(chatSessions.userWorkosId, actor.userId)))
        .limit(1);
      if (session?.name !== null && session?.name !== undefined) await get(actor, id);
    },
    async list(actor: Actor): Promise<BotDto[]> {
      await authorize(actor);
      return input.db
        .select(columns)
        .from(chatSessions)
        .innerJoin(codexChatSessions, eq(codexChatSessions.chatSessionId, chatSessions.id))
        .where(scope(actor))
        .orderBy(desc(chatSessions.createdAt));
    },
    async create(actor: Actor, command: BotDto): Promise<BotDto> {
      await authorize(actor, true);
      // The client retains this ID across retries. Both the Conversation and its workspace-bound
      // runtime are created atomically; creating a bot does not enqueue a synthetic first turn.
      await input.db.execute(sql`
        WITH created AS (
          INSERT INTO goat.chat_sessions (id, user_workos_id, title, model, engine, bot_name, bot_description)
          VALUES (${command.id}, ${actor.userId}, ${command.name}, ${input.defaultModel}, 'opencompany', ${command.name}, ${command.description})
          ON CONFLICT (id) DO NOTHING RETURNING id
        )
        INSERT INTO goat.codex_chat_sessions (id, user_workos_id, chat_session_id, workspace_id, engine, model, status)
        SELECT ${randomUUID()}, ${actor.userId}, id, ${actor.workspaceId}, 'opencompany', ${input.defaultModel}, 'idle' FROM created
      `);
      const bot = await get(actor, command.id);
      if (bot.name !== command.name || bot.description !== command.description) {
        throw new ApiError(409, "conflict", "This creation ID has already been used. Start again.");
      }
      return bot;
    },
    async update(
      actor: Actor,
      id: string,
      command: Pick<BotDto, "name" | "description">,
    ): Promise<BotDto> {
      await authorize(actor, true);
      await get(actor, id);
      const [bot] = await input.db
        .update(chatSessions)
        .set({
          botName: command.name,
          botDescription: command.description,
          title: command.name,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatSessions.id, id),
            eq(chatSessions.userWorkosId, actor.userId),
            isNotNull(chatSessions.botName),
            isNull(chatSessions.closedAt),
          ),
        )
        .returning(columns);
      if (!bot) throw new ApiError(404, "not_found", "Bot not found.");
      return bot;
    },
  };
}
