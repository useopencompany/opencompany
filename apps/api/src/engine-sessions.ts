import type { Actor } from "@opencompany/core";
import { chatSessions, codexChatSessions, workspaceMembers } from "@opencompany/db/product-schema";
import type { EngineRuntimeAccess, EngineRuntimeStatus } from "@opencompany/protocol";
import { and, eq, isNull, or } from "drizzle-orm";
import { ApiError } from "./errors";
import type { RunnerClient } from "./runner-client";

type DbLike = any;

type QualifiedEngineSession = {
  id: string;
  conversationId: string;
  sandboxId: string | null;
};

export type EngineSessionService = {
  getRuntimeStatus(actor: Actor, conversationId: string): Promise<EngineRuntimeStatus | null>;
  createRuntimeAccess(actor: Actor, conversationId: string): Promise<EngineRuntimeAccess>;
};

export function createEngineSessionService(input: {
  db: DbLike;
  runner: RunnerClient;
  runnerPublicUrl?: string;
}): EngineSessionService {
  const load = async (actor: Actor, conversationId: string): Promise<QualifiedEngineSession> => {
    const [row] = await input.db
      .select({
        id: codexChatSessions.id,
        conversationId: codexChatSessions.chatSessionId,
        sandboxId: codexChatSessions.sandboxId,
      })
      .from(codexChatSessions)
      .innerJoin(chatSessions, eq(chatSessions.id, codexChatSessions.chatSessionId))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, actor.workspaceId),
          eq(workspaceMembers.userWorkosId, actor.userId),
        ),
      )
      .where(
        and(
          eq(codexChatSessions.chatSessionId, conversationId),
          eq(codexChatSessions.userWorkosId, actor.userId),
          or(
            eq(codexChatSessions.workspaceId, actor.workspaceId),
            isNull(codexChatSessions.workspaceId),
          ),
          isNull(chatSessions.closedAt),
        ),
      )
      .limit(1);
    if (!row) throw new ApiError(404, "not_found", "Engine session not found.");
    return row;
  };

  return {
    async getRuntimeStatus(actor, conversationId) {
      const session = await load(actor, conversationId);
      if (!session.sandboxId) return null;
      try {
        const result = await input.runner.requestJson<{
          ok: boolean;
          status: EngineRuntimeStatus;
        }>(`/internal/goat/codex-chat/sandboxes/${encodeURIComponent(session.sandboxId)}/status`, {
          method: "GET",
          errorFormat: "error-message",
        });
        return result.status;
      } catch (error) {
        throw runnerUnavailable(error, "Unable to load the coding workspace status.");
      }
    },

    async createRuntimeAccess(actor, conversationId) {
      const session = await load(actor, conversationId);
      if (!session.sandboxId) {
        throw new ApiError(
          409,
          "conflict",
          "The coding workspace is not ready yet. Send a message first.",
        );
      }
      let access: { ticket: string; expiresAt: number; sandboxStatus: "running" | "sleeping" };
      try {
        access = await input.runner.requestJson<{
          ticket: string;
          expiresAt: number;
          sandboxStatus: "running" | "sleeping";
        }>(
          `/internal/goat/coding-workspaces/sessions/${encodeURIComponent(session.id)}/runtime-access`,
          {
            method: "POST",
            body: { userWorkosId: actor.userId },
            errorFormat: "error-message",
          },
        );
      } catch (error) {
        throw runnerUnavailable(error, "Unable to connect to the coding workspace.");
      }
      const publicUrl =
        input.runnerPublicUrl?.trim() || process.env.RUNNER_PUBLIC_URL?.trim() || undefined;
      if (!publicUrl) {
        throw new ApiError(503, "unavailable", "Coding workspace access is not configured.", true);
      }
      const websocketUrl = new URL("/goat/runtime", `${publicUrl.replace(/\/+$/, "")}/`);
      websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
      return {
        conversationId,
        websocketUrl: websocketUrl.toString(),
        ticket: access.ticket,
        expiresAt: access.expiresAt,
        runtimeStatus: access.sandboxStatus,
      };
    },
  };
}

function runnerUnavailable(error: unknown, fallback: string) {
  if (error instanceof ApiError) return error;
  return new ApiError(
    503,
    "unavailable",
    error instanceof Error && error.message ? error.message : fallback,
    true,
  );
}
