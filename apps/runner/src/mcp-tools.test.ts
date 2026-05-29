import { createCipheriv, randomBytes } from "node:crypto";
import { createMCPClient } from "@ai-sdk/mcp";
import type { AgentConfig } from "@opencompany/agent-runtime";
import { jsonSchema, type ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpToolSet } from "./mcp-tools";

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

vi.mock("@opencompany/db/client", () => ({
  getDb: () => db,
}));

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async () => mcpClient),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: observability.captureException,
  createLogger: vi.fn(() => observability.logger),
}));

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
  it("fails clearly when Linear MCP is enabled on the agent but not configured", async () => {
    await expect(createMcpToolSet(baseInput())).rejects.toThrow(
      "Linear MCP is enabled on this agent, but the workspace MCP beta is off.",
    );
  });

  it("surfaces missing encryption key configuration for Linear MCP credentials", async () => {
    db.queryResults = [[{ enabled: true }], [linearServerRow()], [linearConnectionRow()]];
    vi.unstubAllEnvs();

    await expect(createMcpToolSet(baseInput())).rejects.toThrow(
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is required for MCP credential storage.",
    );
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

    const mcpTools = await createMcpToolSet(baseInput());
    const linearTool = (mcpTools.tools as ToolSet).linear__create_issue;
    await linearTool?.onInputAvailable?.({
      input: { title: "Fix login" },
      toolCallId: "call_123",
      messages: [],
      abortSignal: new AbortController().signal,
    });
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
    expect(leaseWrites.appendRuntimeEventForLease).toHaveBeenCalledWith(
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

    const mcpTools = await createMcpToolSet(baseInput(slackAgentConfig));
    const slackTool = (mcpTools.tools as ToolSet).slack__search;
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

function baseInput(config: AgentConfig = agentConfig) {
  return {
    sessionId: "ses_123",
    assistantMessageId: "msg_123",
    runLeaseId: "lease_123",
    runLeaseOwner: "runner_123",
    workspaceId: "wks_123",
    agentConfig: config,
    signal: new AbortController().signal,
    checkAbort: async () => {},
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
