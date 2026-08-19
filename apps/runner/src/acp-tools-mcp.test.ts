import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createExternalEngineGatewayTicket } from "@opencompany/agent-runtime";
import { CODEX_BRAIN_TOOL_CONTRACT_VERSION } from "@opencompany/brain";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAcpToolsMcpRoute } from "./acp-tools-mcp";
import type { RunnerEnv } from "./env";

const env = { internalToken: "runner-secret" } as RunnerEnv;
const capability = {
  codexChatSessionId: "session_1",
  codexChatTurnId: "run_1",
  attemptId: "attempt_1",
  leaseId: "lease_1",
};
const apps: ReturnType<typeof Fastify>[] = [];
const authorized = {
  actorId: "user_1",
  workspaceId: "workspace_1",
  conversationId: "conversation_1",
  sandboxId: "sandbox_1",
  engine: "claude_code" as const,
  brainRef: null,
  userMessageId: "message_user_1",
  assistantMessageId: "message_assistant_1",
  hostToolContractVersion: "goat-codex-host-tools.v3",
};

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

describe("runner ACP tools MCP", () => {
  it("rejects a missing sandbox capability", async () => {
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, {
      authorize: vi.fn(async () => authorized),
    });

    const missing = await app.inject({
      method: "POST",
      url: "/internal/goat/acp-tools",
    });
    expect(missing.statusCode).toBe(401);
  });

  it("rejects an oversized MCP body before tool dispatch", async () => {
    const app = Fastify();
    apps.push(app);
    const executeAction = vi.fn();
    registerAcpToolsMcpRoute(app, env, { executeAction });

    const response = await app.inject({
      method: "POST",
      url: "/internal/goat/acp-tools",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ value: "x".repeat(256 * 1024) }),
    });

    expect(response.statusCode).toBe(413);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("initializes and reauthorizes every MCP tool operation", async () => {
    const authorize = vi.fn(async () => authorized);
    const executeAction = vi.fn(async () => ({ ok: true as const, sources: [] }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize, executeAction });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
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
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(authorized)
      .mockResolvedValueOnce(authorized)
      .mockResolvedValueOnce(null);
    const executeAction = vi.fn(async () => ({ ok: true as const, sources: [] }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize, executeAction });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      await expect(client.callTool({ name: "list_actions", arguments: {} })).rejects.toThrow(
        "This engine turn is no longer active",
      );
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("exposes actions, artifacts, Brain reads, and Brain capture to Codex", async () => {
    const authorize = vi.fn(async () => ({
      ...authorized,
      engine: "codex" as const,
      brainRef: "brain_1",
    }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "publish_artifact",
        "list_actions",
        "use_action",
        "goat_brain",
        "save_to_brain",
      ]);
    } finally {
      await client.close();
    }
  });

  it("preserves read-only Brain access for legacy pinned sessions", async () => {
    const authorize = vi.fn(async () => ({
      ...authorized,
      engine: "codex" as const,
      brainRef: "brain_1",
      hostToolContractVersion: CODEX_BRAIN_TOOL_CONTRACT_VERSION,
    }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["goat_brain"]);
    } finally {
      await client.close();
    }
  });
});
