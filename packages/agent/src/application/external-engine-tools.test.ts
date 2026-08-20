import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ACTION_TOOL_CONTRACT, type ActionGatewayRequest } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryActionTurnGovernance, serveActionRequest } from "../actions/service";
import {
  type ExternalEngineToolDependencies,
  registerExternalEngineServiceTools,
} from "./external-engine-tools";

type RegisteredTool = {
  config: Record<string, unknown>;
  callback: (
    args: Record<string, unknown>,
    extra?: { requestId: string | number; sessionId?: string },
  ) => Promise<{
    content: Array<{ text?: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
};

function registerTools(
  executeAction: ExternalEngineToolDependencies["executeAction"],
  publishArtifact = vi.fn<ExternalEngineToolDependencies["publishArtifact"]>(),
) {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: vi.fn(
      (name: string, config: Record<string, unknown>, callback: RegisteredTool["callback"]) => {
        tools.set(name, { config, callback });
      },
    ),
  } as unknown as McpServerType;
  registerExternalEngineServiceTools(
    server,
    { sessionId: "codex_session_1", runId: "codex_turn_1" },
    { executeAction, publishArtifact },
  );
  return tools;
}

function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} was not registered`);
  return tool;
}

describe("registerExternalEngineServiceTools", () => {
  it("registers file publication and action tools", () => {
    const tools = registerTools(vi.fn<ExternalEngineToolDependencies["executeAction"]>());
    expect([...tools.keys()]).toEqual(["publish_artifact", "list_actions", "use_action"]);
    expect(getTool(tools, "list_actions").config.annotations).toEqual(
      ACTION_TOOL_CONTRACT.list.annotations,
    );
    expect(getTool(tools, "use_action").config.annotations).toEqual(
      ACTION_TOOL_CONTRACT.execute.annotations,
    );
    expect(ACTION_TOOL_CONTRACT.execute.annotations.idempotentHint).toBe(false);
  });

  it("publishes a sandbox file through the turn-scoped runner bridge", async () => {
    const publishArtifact = vi.fn<ExternalEngineToolDependencies["publishArtifact"]>(async () => ({
      ok: true,
      artifact: {
        artifactId: "artifact_1",
        artifactVersionId: "artifact_version_1",
        version: 1,
        title: "Plan",
        filename: "plan.md",
        mediaType: "text/markdown",
        sizeBytes: 42,
        state: "ready",
      },
    }));
    const tools = registerTools(
      vi.fn<ExternalEngineToolDependencies["executeAction"]>(),
      publishArtifact,
    );

    const result = await getTool(tools, "publish_artifact").callback(
      {
        path: "/home/user/opencompany-goat/claude-chat/plan.md",
        title: "Plan",
      },
      { requestId: "request_1", sessionId: "transport_1" },
    );

    expect(publishArtifact).toHaveBeenCalledWith({
      sessionId: "codex_session_1",
      runId: "codex_turn_1",
      toolCallId: "mcp:codex_turn_1:transport_1:request_1",
      arguments: {
        path: "/home/user/opencompany-goat/claude-chat/plan.md",
        title: "Plan",
      },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      artifact: { artifactVersionId: "artifact_version_1" },
    });
  });

  it("translates a list_actions call into a gateway list request", async () => {
    const executeAction = vi.fn<ExternalEngineToolDependencies["executeAction"]>(async () => ({
      ok: true,
      sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
    }));
    const tools = registerTools(executeAction);

    const result = await getTool(tools, "list_actions").callback({ source: "gmail" });

    const call = executeAction.mock.calls[0];
    if (!call) throw new Error("executeAction was not called");
    expect(call[0].request).toEqual({
      operation: "list",
      sessionId: "codex_session_1",
      turnId: "codex_turn_1",
      source: "gmail",
    } satisfies ActionGatewayRequest);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      ok: true,
      sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
    });
  });

  it("derives stable, distinct invocation ids from separate MCP requests", async () => {
    const executeAction = vi.fn<ExternalEngineToolDependencies["executeAction"]>(async () => ({
      ok: true,
      action: "gmail.list",
      result: [],
    }));
    const firstRequestTools = registerTools(executeAction);
    const secondRequestTools = registerTools(executeAction);

    await getTool(firstRequestTools, "use_action").callback(
      { action: "gmail.list", params: { limit: 5 } },
      { requestId: "jsonrpc_41", sessionId: "transport_1" },
    );
    await getTool(secondRequestTools, "use_action").callback(
      { action: "gmail.list", params: { limit: 5 } },
      { requestId: "jsonrpc_42", sessionId: "transport_1" },
    );
    await getTool(firstRequestTools, "use_action").callback(
      { action: "gmail.list", params: { limit: 5 } },
      { requestId: "jsonrpc_41", sessionId: "transport_1" },
    );

    const firstCall = executeAction.mock.calls[0];
    const secondCall = executeAction.mock.calls[1];
    const retryCall = executeAction.mock.calls[2];
    if (!firstCall || !secondCall || !retryCall) {
      throw new Error("executeAction was not called three times");
    }
    const firstRequest = firstCall[0].request;
    const secondRequest = secondCall[0].request;
    expect(firstRequest).toMatchObject({
      operation: "execute",
      sessionId: "codex_session_1",
      turnId: "codex_turn_1",
      action: "gmail.list",
      params: { limit: 5 },
      invocationId: "mcp:codex_turn_1:transport_1:jsonrpc_41",
    });
    expect(secondRequest).toMatchObject({
      invocationId: "mcp:codex_turn_1:transport_1:jsonrpc_42",
    });
    expect(retryCall[0].request).toMatchObject({
      invocationId: "mcp:codex_turn_1:transport_1:jsonrpc_41",
    });
    expect(firstRequest).not.toEqual(secondRequest);
  });

  it("surfaces call_budget on call 17 from the shared service", async () => {
    const governance = createInMemoryActionTurnGovernance();
    const executeAction = vi.fn<ExternalEngineToolDependencies["executeAction"]>(
      async ({ request }) =>
        serveActionRequest({
          request,
          catalog: {
            sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
            actions: [
              {
                id: "gmail.search",
                source: "gmail",
                description: "Search email.",
                params: { type: "object" },
              },
            ],
          },
          governance,
          execute: async ({ action }) => ({ ok: true, action, result: [] }),
        }),
    );
    const tools = registerTools(executeAction);

    await getTool(tools, "list_actions").callback({ source: "gmail" });
    for (let callNumber = 1; callNumber <= 16; callNumber += 1) {
      const result = await getTool(tools, "use_action").callback(
        { action: "gmail.search", params: {} },
        { requestId: callNumber, sessionId: "transport_1" },
      );
      expect(result.isError).toBe(false);
    }
    const rejected = await getTool(tools, "use_action").callback(
      { action: "gmail.search", params: {} },
      { requestId: 17, sessionId: "transport_1" },
    );

    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      ok: false,
      error: { code: "call_budget" },
    });
  });

  it("marks the MCP result as an error when the gateway response is not ok", async () => {
    const executeAction = vi.fn<ExternalEngineToolDependencies["executeAction"]>(async () => ({
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
    registerExternalEngineServiceTools(
      server,
      { sessionId: "codex_session_1", runId: "codex_turn_1" },
      {
        executeAction: vi.fn<ExternalEngineToolDependencies["executeAction"]>(
          async ({ request }) =>
            request.operation === "list"
              ? { ok: true, sources: [{ id: "gmail", label: "Gmail", description: "d" }] }
              : { ok: true, action: request.action, result: { echoedParams: request.params } },
        ),
        publishArtifact: vi.fn<ExternalEngineToolDependencies["publishArtifact"]>(),
      },
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "smoke-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "publish_artifact",
      "list_actions",
      "use_action",
    ]);
    expect(tools.tools.find((tool) => tool.name === "publish_artifact")?.inputSchema).toMatchObject(
      {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, expected_version: { type: "integer" } },
      },
    );
    expect(tools.tools.find((tool) => tool.name === "use_action")?.inputSchema).toMatchObject({
      type: "object",
      required: ["action", "params"],
      properties: {
        action: { type: "string" },
        params: { type: "object" },
      },
    });

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

    await expect(
      client.callTool({
        name: "use_action",
        arguments: { action: "gmail.list" },
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Input validation error") }],
    });
  });
});
