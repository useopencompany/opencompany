import type { OAuthClientProvider } from "@ai-sdk/mcp";
import type { PluginGatewayDiscoveredTool } from "@opencompany/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyRemoteTool,
  discoverRemoteMcpSnapshot,
  type RemoteMcpGatewayRegistration,
  resolveRemoteMcpActions,
} from "./remote-mcp";
import { type ActionExecuteContext, ActionPermissionError } from "./types";

const authProvider = {} as OAuthClientProvider;
const identity = { userWorkosId: "user_1", workspaceId: "workspace_1" };
const context: ActionExecuteContext = {
  ...identity,
  chatSessionId: "session_1",
  toolCallId: "tool_call_1",
  sourceTurnId: "turn_1",
  sourceEngine: "codex",
  signal: new AbortController().signal,
  currentDate: new Date("2026-08-26T00:00:00.000Z"),
  userTimezone: "UTC",
};

function connectedState(
  capabilityModes: Record<string, unknown> = {},
  toolModes: Record<string, unknown> = {},
) {
  return {
    connected: true,
    integrationId: "gint_linear_1",
    capabilityModes,
    toolModes,
  };
}

function discoveredTool(
  name: string,
  input: Partial<Omit<PluginGatewayDiscoveredTool, "name" | "classification">> & {
    classification?: Partial<PluginGatewayDiscoveredTool["classification"]>;
  } = {},
): PluginGatewayDiscoveredTool {
  return {
    name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.inputSchema !== undefined ? { inputSchema: input.inputSchema } : {}),
    ...(input.annotations !== undefined ? { annotations: input.annotations } : {}),
    classification: {
      capabilityId: "read",
      capabilityLabel: "Read Linear",
      defaultMode: "on",
      bucket: "read",
      curated: true,
      ...input.classification,
    },
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
    discoverySnapshot: [
      discoveredTool("list_issues", {
        description: "List issues.",
        inputSchema: { type: "object" },
      }),
    ],
    getState: vi.fn(async () => connectedState()),
    loadConnection: vi.fn(async () => ({
      ok: true as const,
      integrationId: "gint_linear_1",
      authProvider,
    })),
    isEnabled: vi.fn(async () => true),
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
    expect(
      classifyRemoteTool({ name: "run_sql" }, [
        { id: "query", label: "Query database data", defaultMode: "ask", tools: ["run_sql"] },
      ]),
    ).toMatchObject({
      capability: { id: "query", label: "Query database data", defaultMode: "ask" },
      bucket: "read",
      curated: true,
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

describe("remote MCP discovery snapshots", () => {
  it("discovers paginated drift once and serves the classified snapshot from cache", async () => {
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
    const createClient = vi.fn(async () => discovery);
    const recordDispatch = vi.fn(async () => {});
    const snapshot = await discoverRemoteMcpSnapshot(identity, registration(), {
      createClient,
      recordDispatch,
    });
    const catalog = await resolveRemoteMcpActions(
      identity,
      registration({ discoverySnapshot: snapshot ?? [] }),
      { createClient, recordDispatch },
    );

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
    expect(discovery.listTools).toHaveBeenCalledTimes(2);
    expect(discovery.listTools).toHaveBeenNthCalledWith(2, {
      params: { cursor: "page_2" },
      options: { signal: expect.any(AbortSignal) },
    });
    expect(createClient).toHaveBeenCalledOnce();
    expect(recordDispatch).toHaveBeenCalledTimes(2);
    expect(recordDispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        operation: "tools/list",
        actingAgent: "action_gateway",
        actingUser: "user_1",
        workspaceId: "workspace_1",
      }),
    );
    expect(JSON.stringify(catalog)).not.toContain("mcp.linear.app");
    expect(JSON.stringify(catalog)).not.toContain("X-Package-Version");
  });
});

describe("resolveRemoteMcpActions", () => {
  it("does zero tools/list calls during execute and loads credentials only at dispatch", async () => {
    const execution = client({
      result: { content: [{ type: "text", text: '{"issues":[{"id":"issue_1"}]}' }] },
    });
    const createClient = vi.fn(async () => execution);
    const recordDispatch = vi.fn(async () => {});
    const loadConnection = vi.fn(async () => ({
      ok: true as const,
      integrationId: "gint_linear_1",
      authProvider,
    }));
    const catalog = await resolveRemoteMcpActions(identity, registration({ loadConnection }), {
      createClient,
      recordDispatch,
    });
    const action = catalog?.actions.find(
      (candidate) => candidate.id === "plugin:linear:linear.list_issues",
    );

    await expect(action?.execute({ team: "Platform" }, context)).resolves.toEqual({
      issues: [{ id: "issue_1" }],
    });
    expect(loadConnection).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledOnce();
    expect(execution.listTools).not.toHaveBeenCalled();
    expect(execution.callTool).toHaveBeenCalledWith({
      name: "list_issues",
      arguments: { team: "Platform" },
      options: { signal: context.signal },
    });
    expect(recordDispatch).toHaveBeenCalledWith({
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
  });

  it("rechecks capability mode and the plugin kill switch before loading credentials", async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce(connectedState())
      .mockResolvedValueOnce(connectedState({ read: "off" }));
    const loadConnection = vi.fn();
    const createClient = vi.fn();
    const catalog = await resolveRemoteMcpActions(
      identity,
      registration({ getState, loadConnection }),
      { createClient, recordDispatch: vi.fn(async () => {}) },
    );

    await expect(catalog?.actions[0]?.execute({}, context)).rejects.toBeInstanceOf(
      ActionPermissionError,
    );
    expect(loadConnection).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();

    const disabled = await resolveRemoteMcpActions(
      identity,
      registration({ isEnabled: vi.fn(async () => false) }),
    );
    await expect(disabled?.actions[0]?.execute({}, context)).rejects.toBeInstanceOf(
      ActionPermissionError,
    );
  });

  it("honors explicit per-tool promotion without broadly promoting uncurated tools", async () => {
    const discoverySnapshot = [
      discoveredTool("looks_read_only", {
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        classification: {
          capabilityLabel: "Read tools",
          defaultMode: "ask",
          curated: false,
        },
      }),
      discoveredTool("other", {
        inputSchema: { type: "object" },
        classification: {
          capabilityId: "write",
          capabilityLabel: "Write & other tools",
          defaultMode: "ask",
          bucket: "write",
          curated: false,
        },
      }),
    ];
    const catalog = await resolveRemoteMcpActions(
      identity,
      registration({
        discoverySnapshot,
        getState: vi.fn(async () => connectedState({ read: "on", write: "on" })),
      }),
    );
    expect(catalog?.actions.map((action) => [action.capability, action.permissionMode])).toEqual([
      ["read", "ask"],
      ["write", "ask"],
    ]);

    const getState = vi.fn(async () =>
      connectedState({ read: "on", write: "on" }, { looks_read_only: "on" }),
    );
    const execution = client({ result: { content: [{ type: "text", text: "{}" }] } });
    const overridden = await resolveRemoteMcpActions(
      identity,
      registration({
        discoverySnapshot,
        getState,
      }),
      { createClient: vi.fn(async () => execution) },
    );
    expect(overridden?.actions.map((action) => [action.capability, action.permissionMode])).toEqual(
      [
        ["read", "on"],
        ["write", "ask"],
      ],
    );

    await expect(overridden?.actions[0]?.execute({}, context)).resolves.toEqual({});
    expect(getState).toHaveBeenCalledTimes(2);
    expect(execution.callTool).toHaveBeenCalledWith({
      name: "looks_read_only",
      arguments: {},
      options: { signal: context.signal },
    });

    const withToolDisabled = await resolveRemoteMcpActions(
      identity,
      registration({
        discoverySnapshot,
        getState: vi.fn(async () =>
          connectedState({ read: "on", write: "on" }, { looks_read_only: "off" }),
        ),
      }),
    );
    expect(withToolDisabled?.actions.map((action) => action.id)).toEqual([
      "plugin:linear:linear.other",
    ]);
  });
});
