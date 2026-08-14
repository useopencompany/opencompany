import type { Actor } from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { createEngineSessionService } from "./engine-sessions";
import { ApiError } from "./errors";
import type { RunnerClient } from "./runner-client";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: ["chat:read", "chat:write"],
  authenticationMethod: "session",
};

describe("engine session service", () => {
  it("returns qualified runtime status without exposing the sandbox identity", async () => {
    const requestJson = vi.fn(async () => ({ ok: true, status: "sleeping" as const }));
    const service = createEngineSessionService({
      db: queryDb([
        { id: "engine_session_1", conversationId: "conversation_1", sandboxId: "sandbox_secret" },
      ]),
      runner: runnerClient(requestJson),
    });

    await expect(service.getRuntimeStatus(actor, "conversation_1")).resolves.toBe("sleeping");
    expect(requestJson).toHaveBeenCalledWith(
      "/internal/goat/codex-chat/sandboxes/sandbox_secret/status",
      { method: "GET", errorFormat: "error-message" },
    );
  });

  it("returns only a short-lived browser access capability", async () => {
    const requestJson = vi.fn(async () => ({
      ticket: "short-lived-ticket",
      expiresAt: 1_786_449_900,
      sandboxStatus: "running" as const,
    }));
    const service = createEngineSessionService({
      db: queryDb([
        { id: "engine_session_1", conversationId: "conversation_1", sandboxId: "sandbox_secret" },
      ]),
      runner: runnerClient(requestJson),
      runnerPublicUrl: "https://runner.example.test/",
    });

    const access = await service.createRuntimeAccess(actor, "conversation_1");

    expect(access).toEqual({
      conversationId: "conversation_1",
      websocketUrl: "wss://runner.example.test/goat/runtime",
      ticket: "short-lived-ticket",
      expiresAt: 1_786_449_900,
      runtimeStatus: "running",
    });
    expect(access).not.toHaveProperty("sandboxId");
    expect(requestJson).toHaveBeenCalledWith(
      "/internal/goat/coding-workspaces/sessions/engine_session_1/runtime-access",
      {
        method: "POST",
        body: { userWorkosId: "user_1" },
        errorFormat: "error-message",
      },
    );
  });

  it("fails closed when no actor-qualified engine session exists", async () => {
    const service = createEngineSessionService({
      db: queryDb([]),
      runner: runnerClient(vi.fn()),
    });

    await expect(service.getRuntimeStatus(actor, "conversation_1")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    } satisfies Partial<ApiError>);
  });
});

function queryDb(rows: unknown[]) {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    limit: async () => rows,
  };
  return { select: () => builder };
}

function runnerClient(requestJson: unknown): RunnerClient {
  return {
    requestJson: requestJson as RunnerClient["requestJson"],
    postJson: vi.fn(async () => {
      throw new Error("Unexpected legacy runner request.");
    }),
  };
}
