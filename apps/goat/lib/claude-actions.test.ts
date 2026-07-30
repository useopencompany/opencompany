import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GoatCodexActionGatewayRequest } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { registerGoatClaudeActionTools } from "./claude-actions";
import type { executeGoatCodexActionGateway } from "./codex-actions";

type RegisteredTool = {
  config: Record<string, unknown>;
  callback: (args: unknown) => Promise<{
    content: Array<{ text?: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
};

function registerTools(executeAction: typeof executeGoatCodexActionGateway) {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: vi.fn(
      (name: string, config: Record<string, unknown>, callback: RegisteredTool["callback"]) => {
        tools.set(name, { config, callback });
      },
    ),
  } as unknown as McpServerType;
  registerGoatClaudeActionTools(
    server,
    { codexChatSessionId: "codex_session_1", codexChatTurnId: "codex_turn_1" },
    { executeAction },
  );
  return tools;
}

function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} was not registered`);
  return tool;
}

describe("registerGoatClaudeActionTools", () => {
  it("registers list_actions and use_action", () => {
    const tools = registerTools(vi.fn<typeof executeGoatCodexActionGateway>());
    expect([...tools.keys()]).toEqual(["list_actions", "use_action"]);
  });

  it("translates a list_actions call into a gateway list request", async () => {
    const executeAction = vi.fn<typeof executeGoatCodexActionGateway>(async () => ({
      ok: true,
      sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
    }));
    const tools = registerTools(executeAction);

    const result = await getTool(tools, "list_actions").callback({ source: "gmail" });

    const call = executeAction.mock.calls[0];
    if (!call) throw new Error("executeAction was not called");
    expect(call[0].request).toEqual({
      operation: "list",
      codexChatSessionId: "codex_session_1",
      codexChatTurnId: "codex_turn_1",
      source: "gmail",
    } satisfies GoatCodexActionGatewayRequest);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      ok: true,
      sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
    });
  });

  it("translates a use_action call into a gateway execute request with a unique toolCallId", async () => {
    const executeAction = vi.fn<typeof executeGoatCodexActionGateway>(async () => ({
      ok: true,
      action: "gmail.list",
      result: [],
    }));
    const tools = registerTools(executeAction);

    await getTool(tools, "use_action").callback({ action: "gmail.list", params: { limit: 5 } });
    await getTool(tools, "use_action").callback({ action: "gmail.list", params: { limit: 5 } });

    const firstCall = executeAction.mock.calls[0];
    const secondCall = executeAction.mock.calls[1];
    if (!firstCall || !secondCall) throw new Error("executeAction was not called twice");
    const firstRequest = firstCall[0].request;
    const secondRequest = secondCall[0].request;
    expect(firstRequest).toMatchObject({
      operation: "execute",
      codexChatSessionId: "codex_session_1",
      codexChatTurnId: "codex_turn_1",
      action: "gmail.list",
      params: { limit: 5 },
    });
    expect("toolCallId" in firstRequest ? firstRequest.toolCallId : undefined).not.toEqual(
      "toolCallId" in secondRequest ? secondRequest.toolCallId : undefined,
    );
  });

  it("marks the MCP result as an error when the gateway response is not ok", async () => {
    const executeAction = vi.fn<typeof executeGoatCodexActionGateway>(async () => ({
      ok: false,
      error: { code: "not_permitted", message: "nope" },
    }));
    const tools = registerTools(executeAction);

    const result = await getTool(tools, "list_actions").callback({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not_permitted");
  });

  // The tests above register against a mocked server object and call the resulting
  // callback directly, which never exercises the SDK's real zod-to-JSON-schema
  // conversion or wire-protocol round-trip. Verify that path separately against a
  // real McpServer/Client pair so a schema that "looks right" but breaks conversion
  // wouldn't slip through.
  it("survives a real MCP client/server round-trip", async () => {
    const server = new McpServer({ name: "test", version: "0.1.0" });
    registerGoatClaudeActionTools(
      server,
      { codexChatSessionId: "codex_session_1", codexChatTurnId: "codex_turn_1" },
      {
        executeAction: vi.fn<typeof executeGoatCodexActionGateway>(async ({ request }) =>
          request.operation === "list"
            ? { ok: true, sources: [{ id: "gmail", label: "Gmail", description: "d" }] }
            : { ok: true, action: request.action, result: { echoedParams: request.params } },
        ),
      },
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "smoke-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["list_actions", "use_action"]);

    const listResult = await client.callTool({ name: "list_actions", arguments: {} });
    expect(listResult.structuredContent).toEqual({
      ok: true,
      sources: [{ id: "gmail", label: "Gmail", description: "d" }],
    });

    const useResult = await client.callTool({
      name: "use_action",
      arguments: { action: "gmail.list", params: { limit: 5 } },
    });
    expect(useResult.structuredContent).toEqual({
      ok: true,
      action: "gmail.list",
      result: { echoedParams: { limit: 5 } },
    });
  });
});
