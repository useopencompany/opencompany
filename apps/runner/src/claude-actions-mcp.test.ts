import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClaudeActionGatewayTicket } from "@opencompany/agent-runtime";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerClaudeActionsMcpRoute } from "./claude-actions-mcp";
import type { RunnerEnv } from "./env";

const env = { internalToken: "runner-secret" } as RunnerEnv;
const capability = {
  codexChatSessionId: "session_1",
  codexChatTurnId: "run_1",
  attemptId: "attempt_1",
  leaseId: "lease_1",
};
const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

describe("runner Claude actions MCP", () => {
  it("rejects a missing sandbox capability", async () => {
    const app = Fastify();
    apps.push(app);
    registerClaudeActionsMcpRoute(app, env, {
      authorize: vi.fn(async () => ({
        actorId: "user_1",
        workspaceId: "workspace_1",
        conversationId: "conversation_1",
        sandboxId: "sandbox_1",
      })),
    });

    const missing = await app.inject({
      method: "POST",
      url: "/internal/goat/claude-actions",
    });
    expect(missing.statusCode).toBe(401);
  });

  it("rejects an oversized MCP body before tool dispatch", async () => {
    const app = Fastify();
    apps.push(app);
    const executeAction = vi.fn();
    registerClaudeActionsMcpRoute(app, env, { executeAction });

    const response = await app.inject({
      method: "POST",
      url: "/internal/goat/claude-actions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ value: "x".repeat(256 * 1024) }),
    });

    expect(response.statusCode).toBe(413);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("initializes and reauthorizes every MCP tool operation", async () => {
    const authorize = vi.fn(async () => ({
      actorId: "user_1",
      workspaceId: "workspace_1",
      conversationId: "conversation_1",
      sandboxId: "sandbox_1",
    }));
    const executeAction = vi.fn(async () => ({ ok: true as const, sources: [] }));
    const app = Fastify();
    apps.push(app);
    registerClaudeActionsMcpRoute(app, env, { authorize, executeAction });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createClaudeActionGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/claude-actions`),
      { requestInit: { headers: { "x-goat-action-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "publish_artifact",
        "list_actions",
        "use_action",
      ]);
      const result = await client.callTool({ name: "list_actions", arguments: {} });
      expect(result.isError).toBe(false);
      expect(executeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          request: { operation: "list", sessionId: "session_1", turnId: "run_1" },
        }),
      );
      expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      await client.close();
    }
  });

  it("fails a tool call if its lease becomes stale", async () => {
    const authorized = {
      actorId: "user_1",
      workspaceId: "workspace_1",
      conversationId: "conversation_1",
      sandboxId: "sandbox_1",
    };
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(authorized)
      .mockResolvedValueOnce(authorized)
      .mockResolvedValueOnce(null);
    const executeAction = vi.fn(async () => ({ ok: true as const, sources: [] }));
    const app = Fastify();
    apps.push(app);
    registerClaudeActionsMcpRoute(app, env, { authorize, executeAction });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createClaudeActionGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/claude-actions`),
      { requestInit: { headers: { "x-goat-action-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      await expect(client.callTool({ name: "list_actions", arguments: {} })).rejects.toThrow(
        "This Claude Code turn is no longer active",
      );
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
