import { createCipheriv, randomBytes } from "node:crypto";
import { createMCPClient } from "@ai-sdk/mcp";
import { type AgentConfig, policyMapKey, resolveToolDecision } from "@opencompany/agent-runtime";
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
    // MCP beta is off (no experiment row), so Linear can't connect.
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
        message: "Linear MCP is enabled on this agent, but the workspace MCP beta is off.",
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
    // Linear: beta on but no server row -> not configured (fails). Slack: fully connected.
    db.queryResults = [
      [{ enabled: true }],
      [],
      [{ enabled: true }],
      [slackServerRow()],
      [slackOAuthConnectionRow()],
    ];
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

    // Linear degrades to a stub, Slack builds its real tool.
    expect(tools.linear__get_connection_status).toBeDefined();
    expect(tools.slack__search).toBeDefined();

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

  it("surfaces missing encryption key configuration for Linear MCP credentials", async () => {
    db.queryResults = [[{ enabled: true }], [linearServerRow()], [linearConnectionRow()]];
    vi.unstubAllEnvs();

    // Infra misconfig (missing encryption key) also degrades to a stub rather than
    // killing the turn — but it is still logged + reported so ops gets alerted.
    const mcpTools = await createMcpToolSet(baseInput());
    const stubOutput = await mcpTools.tools.linear__get_connection_status?.execute?.(
      {},
      { toolCallId: "call_stub", messages: [], abortSignal: new AbortController().signal },
    );
    expect(stubOutput).toMatchObject({
      ok: false,
      error: {
        code: "mcp_not_connected",
        message: "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is required.",
      },
    });
    expect(observability.logger.error).toHaveBeenCalledWith(
      "Linear MCP connection setup failed",
      expect.objectContaining({
        event: "opencompany.runner_mcp_connection_failed",
        mcp_failure_reason: "encryption_key_configuration",
        mcp_server: "linear",
        workspace_id: "wks_123",
      }),
    );
    expect(observability.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: "opencompany.runner_mcp_connection_failed",
        mcp_failure_reason: "encryption_key_configuration",
      }),
    );
  });

  it("wraps discovered Linear MCP tools with runtime lifecycle writes", async () => {
    const execute = vi.fn(async () => ({ identifier: "OC-123" }));
    db.queryResults = [[{ enabled: true }], [linearServerRow()], [linearConnectionRow()]];
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
    const linearTool = (mcpTools.tools as ToolSet).linear__create_issue;
    await linearTool?.onInputAvailable?.({
      input: { title: "Fix login" },
      toolCallId: "call_123",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    expect(toolStartCoordinator.read("call_123")).toEqual({
      toolCallId: "call_123",
      name: "linear__create_issue",
      input: { title: "Fix login" },
    });
    toolStartCoordinator.markStarted("call_123");
    const output = await linearTool?.execute?.(
      { title: "Fix login" },
      {
        toolCallId: "call_123",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );

    expect(output).toEqual({ identifier: "OC-123" });
    expect(execute).toHaveBeenCalledWith({ title: "Fix login" }, { toolCallId: "call_123" });
    expect(leaseWrites.appendRuntimeEventForLease).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool.started" }),
    );
    expect(leaseWrites.appendRuntimeEventForLease).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool.completed" }),
    );
    expect(leaseWrites.insertToolMessageForLease).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "linear__create_issue", toolCallId: "call_123" }),
    );

    await mcpTools.close();
    expect(mcpClient.close).toHaveBeenCalled();
  });

  it("annotates discovered Linear MCP tools with effective workspace policy", async () => {
    db.queryResults = [[{ enabled: true }], [linearServerRow()], [linearConnectionRow()]];
    mcpClient.listTools.mockResolvedValueOnce({
      tools: [{ name: "list_teams" }, { name: "create_issue" }],
    } as never);
    mcpClient.toolsFromDefinitions.mockReturnValueOnce({
      list_teams: {
        description: "List Linear teams",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: vi.fn(),
      },
      create_issue: {
        description: "Create a Linear issue",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: vi.fn(),
      },
    });

    const mcpTools = await createMcpToolSet(
      baseInput(agentConfig, createToolStartCoordinator(), {
        policy: new Map([
          [policyMapKey("linear", "read"), "ask"],
          [policyMapKey("linear", "post"), "deny"],
          [policyMapKey("linear", "modify"), "deny"],
          [policyMapKey("linear", "admin"), "deny"],
        ]),
        suspendable: true,
      }),
    );

    const tools = mcpTools.tools as Record<string, { description?: string }>;
    expect(tools.linear__list_teams?.description).toContain("Permission: Read (ask first).");
    expect(tools.linear__create_issue?.description).toContain("Permission: Post (deny).");

    await mcpTools.close();
  });

  it("logs handled MCP tool failures to Braintrust", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Linear unavailable");
    });
    db.queryResults = [[{ enabled: true }], [linearServerRow()], [linearConnectionRow()]];
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
    const linearTool = (mcpTools.tools as ToolSet).linear__create_issue;
    await linearTool?.onInputAvailable?.({
      input: { title: "Fix login" },
      toolCallId: "call_123",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    toolStartCoordinator.markStarted("call_123");
    const output = await linearTool?.execute?.(
      { title: "Fix login" },
      {
        toolCallId: "call_123",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );

    expect(output).toMatchObject({
      ok: false,
      error: { code: "mcp_tool_execution_failed", recoverable: true },
    });
    expect(braintrust.logBraintrustCurrentSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ name: "Error", message: "Linear unavailable" }),
        metadata: expect.objectContaining({
          session_id: "ses_123",
          message_id: "msg_123",
          tool_call_id: "call_123",
          tool_name: "linear__create_issue",
          mcp_server: "linear",
          mcp_tool_name: "create_issue",
        }),
      }),
    );
  });

  it("prefers stored Linear MCP OAuth credentials over bearer tokens", async () => {
    db.queryResults = [
      [{ enabled: true }],
      [linearServerRow()],
      [linearConnectionRow(), linearOAuthConnectionRow()],
    ];

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
    db.queryResults = [[{ enabled: true }], [slackServerRow()], [slackOAuthConnectionRow()]];
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
    const slackTool = (mcpTools.tools as ToolSet).slack__search;
    await slackTool?.onInputAvailable?.({
      input: { query: "launch" },
      toolCallId: "call_slack",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    toolStartCoordinator.markStarted("call_slack");
    const output = await slackTool?.execute?.(
      { query: "launch" },
      {
        toolCallId: "call_slack",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );

    expect(output).toEqual({ messages: [{ text: "hello" }] });
    expect(execute).toHaveBeenCalledWith({ query: "launch" }, { toolCallId: "call_slack" });
    expect(leaseWrites.insertToolMessageForLease).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "slack__search", toolCallId: "call_slack" }),
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
