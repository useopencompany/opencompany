import { createCipheriv, randomBytes } from "node:crypto";
import { createMCPClient } from "@ai-sdk/mcp";
import { type AgentConfig, resolveToolDecision } from "@opencompany/agent-runtime";
import { jsonSchema, type ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpToolSet } from "./mcp-tools";
import { createToolStartCoordinator } from "./tool-start-coordinator";

const db = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  select: vi.fn(),
}));

const mcpClient = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  listTools: vi.fn(async () => ({ tools: [] })),
  toolsFromDefinitions: vi.fn(() => ({})),
}));

const leaseWrites = vi.hoisted(() => ({
  appendRuntimeEventForLease: vi.fn((event) => Promise.resolve(event)),
  insertToolMessageForLease: vi.fn((message) => Promise.resolve(message)),
  requireLeaseWrite: vi.fn(async (write) => write),
}));

const observability = vi.hoisted(() => ({
  captureException: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const braintrust = vi.hoisted(() => ({
  logBraintrustCurrentSpan: vi.fn(),
  traceBraintrustStep: vi.fn(
    async (
      _name: string,
      run: (span: { log: (fields: unknown) => void } | undefined) => Promise<unknown>,
    ) => run({ log: vi.fn() }),
  ),
}));

vi.mock("./db", () => ({
  getDb: () => db,
}));

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async () => mcpClient),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: observability.captureException,
  createLogger: vi.fn(() => observability.logger),
}));

vi.mock("@opencompany/observability/braintrust", () => braintrust);

vi.mock("./lease-writes", () => leaseWrites);

vi.mock("./model-messages", () => ({
  buildToolModelMessage: vi.fn((input) => ({ role: "tool", content: [input] })),
  serializeToolOutputForStorage: vi.fn((output) => JSON.stringify(output)),
  toPersistedModelMessage: vi.fn((message) => message),
}));

const agentConfig: AgentConfig = {
  schemaVersion: "agent.v1",
  title: "Linear",
  instructions: "Use @linear.",
  model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
  tools: [
    {
      id: "linear",
      type: "mcp",
      server: "linear",
      label: "linear",
      description: "Use workspace-configured Linear MCP tools.",
    },
  ],
  brain: [],
  integrations: { github: { repositories: [] } },
  triggers: [],
};

const slackAgentConfig: AgentConfig = {
  ...agentConfig,
  title: "Slack",
  instructions: "Use @slack.",
  tools: [
    {
      id: "slack",
      type: "mcp",
      server: "slack",
      label: "slack",
      description: "Use workspace-configured Slack MCP tools.",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey());
  vi.stubEnv("SLACK_MCP_CLIENT_ID", "slack_client");
  vi.stubEnv("SLACK_MCP_CLIENT_SECRET", "slack_secret");
  db.queryResults = [];
  db.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const result = db.queryResults.shift() ?? [];
        return {
          limit: vi.fn(async () => result),
          then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject),
        };
      }),
    })),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createMcpToolSet", () => {
  it("registers a not-connected stub tool instead of aborting the turn when an integration is not set up", async () => {
    // No server row for the workspace, so Linear can't connect.
    const mcpTools = await createMcpToolSet(baseInput());
    const stub = (mcpTools.tools as ToolSet).linear__get_connection_status;
    expect(stub).toBeDefined();

    const output = await stub?.execute?.(
      {},
      { toolCallId: "call_stub", messages: [], abortSignal: new AbortController().signal },
    );
    expect(output).toEqual({
      ok: false,
      error: {
        message: "Linear MCP is enabled on this agent, but Linear is not configured.",
        code: "mcp_not_connected",
        recoverable: true,
      },
    });
    // Failure is still observed.
    expect(observability.logger.error).toHaveBeenCalledWith(
      "Linear MCP connection setup failed",
      expect.objectContaining({ mcp_server: "linear" }),
    );
  });

  it("names the stub so it is auto-allowed (no approval suspend for a no-op)", async () => {
    const mcpTools = await createMcpToolSet(baseInput());
    const stubName = Object.keys(mcpTools.tools).find((name) => name.startsWith("linear__"))!;
    // The stub must resolve to "allow"; an "ask" would suspend the run to approve a no-op.
    expect(
      resolveToolDecision({ toolName: stubName, policy: new Map(), suspendable: true }).decision,
    ).toBe("allow");
  });

  it("keeps a healthy provider when another provider in the same agent is not set up", async () => {
    const mixedConfig: AgentConfig = {
      ...agentConfig,
      tools: [...agentConfig.tools, ...slackAgentConfig.tools],
    };
    // Linear: no server row -> not configured (fails). Slack: fully connected.
    db.queryResults = [[], [slackServerRow()], [slackOAuthConnectionRow()]];
    mcpClient.listTools.mockResolvedValueOnce({ tools: [{ name: "search" }] } as never);
    mcpClient.toolsFromDefinitions.mockReturnValueOnce({
      search: {
        description: "Search Slack",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: vi.fn(async () => ({ messages: [] })),
      },
    });

    const mcpTools = await createMcpToolSet(baseInput(mixedConfig));
    const tools = mcpTools.tools as ToolSet;

    // Linear degrades to a stub, Slack exposes its two lazy meta-tools (not slack__search).
    expect(tools.linear__get_connection_status).toBeDefined();
    expect(tools.slack__search_tools).toBeDefined();
    expect(tools.slack__use_tool).toBeDefined();
    expect(tools.slack__search).toBeUndefined();

    const stubOutput = await tools.linear__get_connection_status?.execute?.(
      {},
      { toolCallId: "call_stub", messages: [], abortSignal: new AbortController().signal },
    );
    expect(stubOutput).toMatchObject({
      ok: false,
      error: {
        code: "mcp_not_connected",
        message: "Linear MCP is enabled on this agent, but Linear is not configured.",
      },
    });
  });

  it("uses the validated encryption key when process env is later unset", async () => {
    db.queryResults = [[linearServerRow()], [linearConnectionRow()]];
    vi.unstubAllEnvs();

    await createMcpToolSet(baseInput());

    expect(createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          headers: {
            Authorization: "Bearer lin_api_secret",
          },
        }),
      }),
    );
    expect(observability.logger.error).not.toHaveBeenCalledWith(
      "Linear MCP connection setup failed",
      expect.objectContaining({
        event: "opencompany.runner_mcp_connection_failed",
      }),
    );
    expect(observability.captureException).not.toHaveBeenCalled();
  });

  it("dispatches a named tool through the lazy use_tool meta-tool", async () => {
    const execute = vi.fn(async () => ({ identifier: "OC-123" }));
    db.queryResults = [[linearServerRow()], [linearConnectionRow()]];
    mcpClient.listTools.mockResolvedValueOnce({ tools: [{ name: "create_issue" }] } as never);
    mcpClient.toolsFromDefinitions.mockReturnValueOnce({
      create_issue: {
        description: "Create a Linear issue",
        inputSchema: jsonSchema({
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        }),
        execute,
      },
    });

    const toolStartCoordinator = createToolStartCoordinator();
    const mcpTools = await createMcpToolSet(baseInput(agentConfig, toolStartCoordinator));
    // The raw tool is never exposed to the model — only the two meta-tools are.
    expect((mcpTools.tools as ToolSet).linear__create_issue).toBeUndefined();
    const useTool = (mcpTools.tools as ToolSet).linear__use_tool;
    const useInput = { tool: "create_issue", arguments: { title: "Fix login" } };
    await useTool?.onInputAvailable?.({
      input: useInput,
      toolCallId: "call_123",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    expect(toolStartCoordinator.read("call_123")).toEqual({
      toolCallId: "call_123",
      name: "linear__use_tool",
      input: useInput,
    });
    toolStartCoordinator.markStarted("call_123");
    const output = await useTool?.execute?.(useInput, {
      toolCallId: "call_123",
      messages: [],
      abortSignal: new AbortController().signal,
    });

    expect(output).toEqual({ identifier: "OC-123" });
    // The underlying tool receives only its own arguments, not the use_tool envelope.
    expect(execute).toHaveBeenCalledWith({ title: "Fix login" }, { toolCallId: "call_123" });
    expect(leaseWrites.appendRuntimeEventForLease).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool.completed" }),
    );
    // The persisted tool-result keeps the invoke name so it pairs with the model's call.
    expect(leaseWrites.insertToolMessageForLease).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "linear__use_tool", toolCallId: "call_123" }),
    );

    await mcpTools.close();
    expect(mcpClient.close).toHaveBeenCalled();
  });

  it("rejects schema-invalid use_tool arguments locally without calling the server", async () => {
    const execute = vi.fn(async () => ({ identifier: "OC-123" }));
    db.queryResults = [[linearServerRow()], [linearConnectionRow()]];
    // The catalog's inputSchema comes from the listTools response — that's the schema the
    // pre-flight validator uses.
    mcpClient.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: "create_issue",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      ],
    } as never);
    mcpClient.toolsFromDefinitions.mockReturnValueOnce({
      create_issue: { description: "Create a Linear issue", execute },
    });

    const toolStartCoordinator = createToolStartCoordinator();
    const mcpTools = await createMcpToolSet(baseInput(agentConfig, toolStartCoordinator));
    const useTool = (mcpTools.tools as ToolSet).linear__use_tool;
    const useInput = { tool: "create_issue", arguments: {} };
    await useTool?.onInputAvailable?.({
      input: useInput,
      toolCallId: "call_invalid",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    toolStartCoordinator.markStarted("call_invalid");
    const output = (await useTool?.execute?.(useInput, {
      toolCallId: "call_invalid",
      messages: [],
      abortSignal: new AbortController().signal,
    })) as { ok: boolean; error: { code: string; message: string; recoverable: boolean } };

    // The server body never ran — the bad payload was caught locally with an actionable error,
    // distinct from the server-side mcp_tool_execution_failed code.
    expect(execute).not.toHaveBeenCalled();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("invalid_tool_input");
    expect(output.error.recoverable).toBe(true);
    expect(output.error.message).toContain('missing required "title"');
    const failed = leaseWrites.appendRuntimeEventForLease.mock.calls
      .map((call) => call[0] as { type: string; payload: { argResolution?: { surface: string } } })
      .find((event) => event.type === "tool.failed");
    expect(failed?.payload.argResolution?.surface).toBe("mcp");

    await mcpTools.close();
  });

  it("coerces use_tool arguments against the catalog schema before calling the server", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    db.queryResults = [[linearServerRow()], [linearConnectionRow()]];
    mcpClient.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: "list_issues",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number" } },
          },
        },
      ],
    } as never);
    mcpClient.toolsFromDefinitions.mockReturnValueOnce({
      list_issues: { description: "List issues", execute },
    });

    const toolStartCoordinator = createToolStartCoordinator();
    const mcpTools = await createMcpToolSet(baseInput(agentConfig, toolStartCoordinator));
    const useTool = (mcpTools.tools as ToolSet).linear__use_tool;
    const useInput = { tool: "list_issues", arguments: { limit: "5" } };
    await useTool?.onInputAvailable?.({
      input: useInput,
      toolCallId: "call_coerce",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    toolStartCoordinator.markStarted("call_coerce");
    await useTool?.execute?.(useInput, {
      toolCallId: "call_coerce",
      messages: [],
      abortSignal: new AbortController().signal,
    });

    // The string "5" is narrowed to a number before reaching the server body.
    expect(execute).toHaveBeenCalledWith({ limit: 5 }, { toolCallId: "call_coerce" });

    await mcpTools.close();
  });

  it("lists the server's tools through the search_tools meta-tool", async () => {
    db.queryResults = [[linearServerRow()], [linearConnectionRow()]];
    mcpClient.listTools.mockResolvedValueOnce({
      tools: [
        { name: "list_teams", description: "List Linear teams", inputSchema: { type: "object" } },
        {
          name: "create_issue",
          description: "Create a Linear issue",
          inputSchema: { type: "object" },
        },
      ],
    } as never);
    mcpClient.toolsFromDefinitions.mockReturnValueOnce({
      list_teams: { description: "List Linear teams", execute: vi.fn() },
      create_issue: { description: "Create a Linear issue", execute: vi.fn() },
    });

    const toolStartCoordinator = createToolStartCoordinator();
    const mcpTools = await createMcpToolSet(baseInput(agentConfig, toolStartCoordinator));
    const searchTool = (mcpTools.tools as ToolSet).linear__search_tools;
    await searchTool?.onInputAvailable?.({
      input: { query: "issue" },
      toolCallId: "call_search",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    toolStartCoordinator.markStarted("call_search");
    const output = (await searchTool?.execute?.(
      { query: "issue" },
      { toolCallId: "call_search", messages: [], abortSignal: new AbortController().signal },
    )) as { ok: boolean; server: string; useTool: string; tools: { name: string }[] };

    expect(output.ok).toBe(true);
    expect(output.server).toBe("linear");
    expect(output.useTool).toBe("linear__use_tool");
    // The "issue" query filters down to create_issue.
    expect(output.tools.map((entry) => entry.name)).toEqual(["create_issue"]);

    await mcpTools.close();
  });

  it("returns a recoverable error when use_tool names an unknown tool", async () => {
    db.queryResults = [[linearServerRow()], [linearConnectionRow()]];
    mcpClient.listTools.mockResolvedValueOnce({ tools: [{ name: "create_issue" }] } as never);
    mcpClient.toolsFromDefinitions.mockReturnValueOnce({
      create_issue: { description: "Create a Linear issue", execute: vi.fn() },
    });

    const toolStartCoordinator = createToolStartCoordinator();
    const mcpTools = await createMcpToolSet(baseInput(agentConfig, toolStartCoordinator));
    const useTool = (mcpTools.tools as ToolSet).linear__use_tool;
    const useInput = { tool: "delete_everything", arguments: {} };
    await useTool?.onInputAvailable?.({
      input: useInput,
      toolCallId: "call_unknown",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    toolStartCoordinator.markStarted("call_unknown");
    const output = await useTool?.execute?.(useInput, {
      toolCallId: "call_unknown",
      messages: [],
      abortSignal: new AbortController().signal,
    });

    expect(output).toMatchObject({
      ok: false,
      error: { code: "mcp_tool_execution_failed", recoverable: true },
    });

    await mcpTools.close();
  });

  it("logs handled MCP tool failures to Braintrust", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Linear unavailable");
    });
    db.queryResults = [[linearServerRow()], [linearConnectionRow()]];
    mcpClient.listTools.mockResolvedValueOnce({ tools: [{ name: "create_issue" }] } as never);
    mcpClient.toolsFromDefinitions.mockReturnValueOnce({
      create_issue: {
        description: "Create a Linear issue",
        inputSchema: jsonSchema({
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        }),
        execute,
      },
    });

    const toolStartCoordinator = createToolStartCoordinator();
    const mcpTools = await createMcpToolSet(baseInput(agentConfig, toolStartCoordinator));
    const useTool = (mcpTools.tools as ToolSet).linear__use_tool;
    const useInput = { tool: "create_issue", arguments: { title: "Fix login" } };
    await useTool?.onInputAvailable?.({
      input: useInput,
      toolCallId: "call_123",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    toolStartCoordinator.markStarted("call_123");
    const output = await useTool?.execute?.(useInput, {
      toolCallId: "call_123",
      messages: [],
      abortSignal: new AbortController().signal,
    });

    expect(output).toMatchObject({
      ok: false,
      error: { code: "mcp_tool_execution_failed", recoverable: true },
    });
    expect(observability.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Linear unavailable" }),
      expect.objectContaining({
        event: "opencompany.runner_mcp_tool_failed",
        session_id: "ses_123",
        message_id: "msg_123",
        tool_call_id: "call_123",
        tool_name: "linear__use_tool",
        mcp_server: "linear",
        mcp_tool_name: "create_issue",
      }),
    );
  });

  it("prefers stored Linear MCP OAuth credentials over bearer tokens", async () => {
    db.queryResults = [[linearServerRow()], [linearConnectionRow(), linearOAuthConnectionRow()]];

    await createMcpToolSet(baseInput());

    expect(createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "https://mcp.linear.app/mcp",
          authProvider: expect.any(Object),
        }),
      }),
    );
    const call = vi.mocked(createMCPClient).mock.calls.at(-1)?.[0] as {
      transport?: { authProvider?: { tokens: () => unknown; clientInformation: () => unknown } };
    };
    expect(call.transport?.authProvider?.tokens()).toEqual({
      access_token: "lin_access",
      refresh_token: "lin_refresh",
      token_type: "Bearer",
    });
    expect(call.transport?.authProvider?.clientInformation()).toEqual({
      client_id: "linear_client",
    });
  });

  it("loads Slack MCP OAuth tools with static env-backed client credentials", async () => {
    const execute = vi.fn(async () => ({ messages: [{ text: "hello" }] }));
    db.queryResults = [[slackServerRow()], [slackOAuthConnectionRow()]];
    mcpClient.listTools.mockResolvedValueOnce({ tools: [{ name: "search" }] } as never);
    mcpClient.toolsFromDefinitions.mockReturnValueOnce({
      search: {
        description: "Search Slack",
        inputSchema: jsonSchema({
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        }),
        execute,
      },
    });

    const toolStartCoordinator = createToolStartCoordinator();
    const mcpTools = await createMcpToolSet(baseInput(slackAgentConfig, toolStartCoordinator));
    const slackTool = (mcpTools.tools as ToolSet).slack__use_tool;
    const useInput = { tool: "search", arguments: { query: "launch" } };
    await slackTool?.onInputAvailable?.({
      input: useInput,
      toolCallId: "call_slack",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    toolStartCoordinator.markStarted("call_slack");
    const output = await slackTool?.execute?.(useInput, {
      toolCallId: "call_slack",
      messages: [],
      abortSignal: new AbortController().signal,
    });

    expect(output).toEqual({ messages: [{ text: "hello" }] });
    expect(execute).toHaveBeenCalledWith({ query: "launch" }, { toolCallId: "call_slack" });
    expect(leaseWrites.insertToolMessageForLease).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "slack__use_tool", toolCallId: "call_slack" }),
    );
    expect(createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "https://mcp.slack.com/mcp",
          authProvider: expect.any(Object),
        }),
      }),
    );
    const call = vi.mocked(createMCPClient).mock.calls.at(-1)?.[0] as {
      transport?: {
        authProvider?: {
          tokens: () => unknown;
          clientInformation: () => unknown;
          clientMetadata: { scope?: string };
        };
      };
    };
    expect(call.transport?.authProvider?.tokens()).toEqual({
      access_token: "slack_access",
      refresh_token: "slack_refresh",
      token_type: "Bearer",
    });
    expect(call.transport?.authProvider?.clientInformation()).toEqual({
      client_id: "slack_client",
      client_secret: "slack_secret",
    });
    expect(call.transport?.authProvider?.clientMetadata.scope).toContain("search:read.public");
    expect(call.transport?.authProvider?.clientMetadata.scope).toContain("channels:history");

    await mcpTools.close();
    expect(mcpClient.close).toHaveBeenCalled();
  });
});

function baseInput(
  config: AgentConfig = agentConfig,
  toolStartCoordinator = createToolStartCoordinator(),
  policyContext: {
    policy: Map<string, "allow" | "ask" | "deny">;
    suspendable: boolean;
  } = { policy: new Map(), suspendable: true },
) {
  return {
    sessionId: "ses_123",
    assistantMessageId: "msg_123",
    runLeaseId: "lease_123",
    runLeaseOwner: "runner_123",
    workspaceId: "wks_123",
    agentConfig: config,
    integrationCredentialEncryptionKey: Buffer.from(credentialKey(), "base64"),
    signal: new AbortController().signal,
    checkAbort: async () => {},
    toolStartCoordinator,
    policy: policyContext.policy,
    suspendable: policyContext.suspendable,
  };
}

function linearServerRow() {
  return {
    id: "wmcps_123",
    endpointUrl: "https://mcp.linear.app/mcp",
    status: "configured",
  };
}

function linearConnectionRow() {
  return {
    serverId: "wmcps_123",
    credentialKind: "bearer_token",
    encryptionKeyVersion: 1,
    encryptedPayload: encryptPayload({ bearerToken: "lin_api_secret" }, "bearer_token"),
  };
}

function linearOAuthConnectionRow() {
  return {
    serverId: "wmcps_123",
    credentialKind: "oauth",
    encryptionKeyVersion: 1,
    encryptedPayload: encryptPayload(
      {
        clientInformation: { client_id: "linear_client" },
        tokens: {
          access_token: "lin_access",
          refresh_token: "lin_refresh",
          token_type: "Bearer",
        },
      },
      "oauth",
    ),
  };
}

function slackServerRow() {
  return {
    id: "wmcps_slack",
    endpointUrl: "https://mcp.slack.com/mcp",
    status: "configured",
  };
}

function slackOAuthConnectionRow() {
  return {
    serverId: "wmcps_slack",
    credentialKind: "oauth",
    encryptionKeyVersion: 1,
    encryptedPayload: encryptPayload(
      {
        tokens: {
          access_token: "slack_access",
          refresh_token: "slack_refresh",
          token_type: "Bearer",
        },
      },
      "oauth",
      "wmcps_slack",
    ),
  };
}

function encryptPayload(payload: Record<string, unknown>, kind: string, serverId = "wmcps_123") {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(credentialKey(), "base64"), iv);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify({
        workspaceId: "wks_123",
        serverId,
        kind,
        keyVersion: 1,
      }),
      "utf8",
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function credentialKey() {
  return Buffer.alloc(32, 1).toString("base64");
}
