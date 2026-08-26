import type { OAuthClientProvider } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyRemoteTool,
  type RemoteMcpGatewayRegistration,
  resolveRemoteMcpActions,
} from "./remote-mcp";
import { type ActionExecuteContext, ActionPermissionError } from "./types";

const authProvider = {} as OAuthClientProvider;
const context: ActionExecuteContext = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  chatSessionId: "session_1",
  toolCallId: "tool_call_1",
  sourceTurnId: "turn_1",
  sourceEngine: "codex",
  signal: new AbortController().signal,
  currentDate: new Date("2026-08-26T00:00:00.000Z"),
  userTimezone: "UTC",
};

function connectedState(capabilityModes: Record<string, unknown> = {}) {
  return {
    connected: true,
    integrationId: "gint_linear_1",
    capabilityModes,
  };
}

function registration(
  overrides: Partial<RemoteMcpGatewayRegistration> = {},
): RemoteMcpGatewayRegistration {
  return {
    source: "plugin:linear:linear",
    connectionProvider: "linear",
    label: "Linear",
    description: "Linear workspace tools.",
    server: {
      name: "linear",
      type: "streamable-http",
      url: "https://mcp.linear.app/mcp",
      headers: { "X-Package-Version": "1" },
    },
    capabilities: [
      {
        id: "read",
        label: "Read Linear",
        defaultMode: "on",
        tools: ["list_issues"],
      },
      {
        id: "write",
        label: "Manage issues",
        defaultMode: "ask",
        tools: ["save_issue"],
      },
    ],
    getState: vi.fn(async () => connectedState()),
    loadConnection: vi.fn(async () => ({
      ok: true as const,
      integrationId: "gint_linear_1",
      authProvider,
    })),
    ...overrides,
  };
}

function client(input: {
  pages?: Array<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      annotations?: { readOnlyHint?: boolean };
    }>;
    nextCursor?: string;
  }>;
  result?: unknown;
}) {
  const pages = [...(input.pages ?? [{ tools: [] }])];
  return {
    listTools: vi.fn(async () => pages.shift() ?? { tools: [] }),
    callTool: vi.fn(async () => input.result ?? { content: [{ type: "text", text: "{}" }] }),
    close: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("remote MCP classification", () => {
  it("uses reviewed mappings and leaves newly discovered tools on Ask", () => {
    const capabilities = registration().capabilities;
    expect(classifyRemoteTool({ name: "list_issues" }, capabilities)).toMatchObject({
      capability: { id: "read", label: "Read Linear", defaultMode: "on" },
      bucket: "read",
      curated: true,
    });
    expect(
      classifyRemoteTool(
        { name: "new_read_tool", annotations: { readOnlyHint: true } },
        capabilities,
      ),
    ).toMatchObject({
      capability: { id: "read", label: "Read tools", defaultMode: "ask" },
      bucket: "read",
      curated: false,
    });
  });

  it("treats ambiguous mappings as uncurated instead of choosing an unsafe capability", () => {
    expect(
      classifyRemoteTool({ name: "shared", annotations: { readOnlyHint: true } }, [
        { id: "read", label: "Read", defaultMode: "on", tools: ["shared"] },
        { id: "write", label: "Write", defaultMode: "ask", tools: ["shared"] },
      ]),
    ).toMatchObject({ curated: false, capability: { defaultMode: "ask" } });
  });
});

describe("resolveRemoteMcpActions", () => {
  it("discovers paginated tools and catalogs drift as unmapped Ask", async () => {
    const discovery = client({
      pages: [
        {
          tools: [
            {
              name: "list_issues",
              description: "List issues.",
              inputSchema: { type: "object", properties: { team: { type: "string" } } },
            },
          ],
          nextCursor: "page_2",
        },
        {
          tools: [
            {
              name: "new_read_tool",
              description: "A newly shipped read tool.",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
            {
              name: "new_write_tool",
              description: "A newly shipped tool without safety annotations.",
              inputSchema: { type: "object" },
            },
          ],
        },
      ],
    });
    const recordDispatch = vi.fn(async () => {});
    const catalog = await resolveRemoteMcpActions("user_1", registration(), {
      createClient: vi.fn(async () => discovery),
      recordDispatch,
    });

    expect(catalog?.actions).toEqual([
      expect.objectContaining({
        id: "plugin:linear:linear.list_issues",
        capability: "read",
        permissionMode: "on",
      }),
      expect.objectContaining({
        id: "plugin:linear:linear.new_read_tool",
        capability: "read",
        permissionMode: "ask",
        permission: expect.objectContaining({ label: "Read tools" }),
      }),
      expect.objectContaining({
        id: "plugin:linear:linear.new_write_tool",
        capability: "write",
        permissionMode: "ask",
        permission: expect.objectContaining({ label: "Write & other tools" }),
      }),
    ]);
    expect(discovery.listTools).toHaveBeenNthCalledWith(1, {
      options: { signal: expect.any(AbortSignal) },
    });
    expect(discovery.listTools).toHaveBeenNthCalledWith(2, {
      params: { cursor: "page_2" },
      options: { signal: expect.any(AbortSignal) },
    });
    expect(recordDispatch).toHaveBeenCalledTimes(2);
    expect(recordDispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        operation: "tools/list",
        actingAgent: "action_gateway",
        actingUser: "user_1",
        capability: "read",
      }),
    );
    expect(JSON.stringify(catalog)).not.toContain("mcp.linear.app");
    expect(JSON.stringify(catalog)).not.toContain("X-Package-Version");
  });

  it("loads credentials at dispatch, logs the delegation triple, and calls server-side", async () => {
    const discovery = client({
      pages: [
        {
          tools: [
            {
              name: "list_issues",
              description: "List issues.",
              inputSchema: { type: "object" },
            },
          ],
        },
      ],
    });
    const execution = client({
      result: { content: [{ type: "text", text: '{"issues":[{"id":"issue_1"}]}' }] },
    });
    const createClient = vi.fn().mockResolvedValueOnce(discovery).mockResolvedValueOnce(execution);
    const recordDispatch = vi.fn(async () => {});
    const loadConnection = vi.fn(async () => ({
      ok: true as const,
      integrationId: "gint_linear_1",
      authProvider,
    }));
    const catalog = await resolveRemoteMcpActions("user_1", registration({ loadConnection }), {
      createClient,
      recordDispatch,
    });
    const action = catalog?.actions.find(
      (candidate) => candidate.id === "plugin:linear:linear.list_issues",
    );

    await expect(action?.execute({ team: "Platform" }, context)).resolves.toEqual({
      issues: [{ id: "issue_1" }],
    });
    expect(loadConnection).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "https://mcp.linear.app/mcp",
          authProvider,
        }),
      }),
    );
    expect(execution.callTool).toHaveBeenCalledWith({
      name: "list_issues",
      arguments: { team: "Platform" },
      options: { signal: context.signal },
    });
    expect(recordDispatch).toHaveBeenLastCalledWith({
      operation: "tools/call",
      actingAgent: "codex",
      actingUser: "user_1",
      capability: "read",
      source: "plugin:linear:linear",
      tool: "list_issues",
      integrationId: "gint_linear_1",
      workspaceId: "workspace_1",
      turnId: "turn_1",
      toolCallId: "tool_call_1",
    });
    expect(execution.close).toHaveBeenCalledOnce();
  });

  it("rechecks capability mode before loading dispatch credentials", async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce(connectedState())
      .mockResolvedValueOnce(connectedState({ read: "off" }));
    const loadConnection = vi.fn(async () => ({
      ok: true as const,
      integrationId: "gint_linear_1",
      authProvider,
    }));
    const discovery = client({
      pages: [
        {
          tools: [{ name: "list_issues", inputSchema: { type: "object" } }],
        },
      ],
    });
    const createClient = vi.fn(async () => discovery);
    const catalog = await resolveRemoteMcpActions(
      "user_1",
      registration({ getState, loadConnection }),
      { createClient, recordDispatch: vi.fn(async () => {}) },
    );

    await expect(catalog?.actions[0]?.execute({}, context)).rejects.toBeInstanceOf(
      ActionPermissionError,
    );
    expect(loadConnection).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledOnce();
  });

  it("defaults every uncurated server tool to Ask", async () => {
    const discovery = client({
      pages: [
        {
          tools: [
            {
              name: "looks_read_only",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
            { name: "other", inputSchema: { type: "object" } },
          ],
        },
      ],
    });
    const uncuratedRegistration = registration({
      getState: vi.fn(async () => connectedState({ read: "on", write: "on" })),
    });
    delete uncuratedRegistration.capabilities;
    const catalog = await resolveRemoteMcpActions("user_1", uncuratedRegistration, {
      createClient: vi.fn(async () => discovery),
      recordDispatch: vi.fn(async () => {}),
    });

    expect(catalog?.actions.map((action) => [action.capability, action.permissionMode])).toEqual([
      ["read", "ask"],
      ["write", "ask"],
    ]);
  });
});
