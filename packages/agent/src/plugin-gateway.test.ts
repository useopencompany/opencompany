import type { PluginGatewayRegistrationRecord } from "@opencompany/db/plugin-gateway-repository";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimRefresh: vi.fn(async () => true),
  isActive: vi.fn(async () => true),
  listRegistrations: vi.fn(),
  storeFailure: vi.fn(async () => undefined),
  storeSnapshot: vi.fn(async () => true),
  discoverSnapshot: vi.fn(),
  getState: vi.fn(),
  getGitHubState: vi.fn(),
  getGmailState: vi.fn(),
  loadConnection: vi.fn(),
  loadGitHubConnection: vi.fn(),
  loadGmailConnection: vi.fn(),
  getNeonState: vi.fn(),
  loadNeonConnection: vi.fn(),
  getBetterStackState: vi.fn(),
  loadBetterStackConnection: vi.fn(),
  getSlackState: vi.fn(),
  loadSlackConnection: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({ getDb: () => ({ sentinel: "db" }) }));
vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  claimPluginGatewayDiscoveryRefresh: mocks.claimRefresh,
  isPluginGatewayRegistrationActive: mocks.isActive,
  listActivePluginGatewayRegistrations: mocks.listRegistrations,
  storePluginGatewayDiscoveryFailure: mocks.storeFailure,
  storePluginGatewayDiscoverySnapshot: mocks.storeSnapshot,
}));
vi.mock("./actions/remote-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  discoverRemoteMcpSnapshot: mocks.discoverSnapshot,
}));
vi.mock("./integrations/linear-mcp", () => ({
  LINEAR_MCP_ENDPOINT_URL: "https://mcp.linear.app/mcp",
  getLinearIntegrationState: mocks.getState,
  loadLinearMcpWorkerConnection: mocks.loadConnection,
}));
vi.mock("./integrations/betterstack-mcp", () => ({
  BETTERSTACK_MCP_ENDPOINT_URL: "https://mcp.betterstack.com",
  getBetterStackIntegrationState: mocks.getBetterStackState,
  loadBetterStackMcpWorkerConnection: mocks.loadBetterStackConnection,
}));
vi.mock("./integrations/github-user-mcp", () => ({
  GITHUB_USER_MCP_ENDPOINT_URL: "https://api.githubcopilot.com/mcp/",
  getGitHubUserMcpIntegrationState: mocks.getGitHubState,
  loadGitHubUserMcpWorkerConnection: mocks.loadGitHubConnection,
}));
vi.mock("./integrations/gmail-mcp", () => ({
  GMAIL_MCP_ENDPOINT_URL: "https://gmailmcp.googleapis.com/mcp/v1",
  getGmailMcpIntegrationState: mocks.getGmailState,
  loadGmailMcpWorkerConnection: mocks.loadGmailConnection,
}));
vi.mock("./integrations/posthog-mcp", () => ({
  POSTHOG_MCP_ENDPOINT_URL: "https://mcp.posthog.com/mcp",
  getPostHogIntegrationState: vi.fn(),
  loadPostHogMcpWorkerConnection: vi.fn(),
}));
vi.mock("./integrations/neon-mcp", () => ({
  NEON_MCP_ENDPOINT_URL:
    "https://mcp.neon.tech/mcp?readonly=true&category=projects&category=branches&category=schema&category=querying",
  getNeonIntegrationState: mocks.getNeonState,
  loadNeonMcpWorkerConnection: mocks.loadNeonConnection,
}));
vi.mock("./integrations/latitude-mcp", () => ({
  LATITUDE_MCP_ENDPOINT_URL: "https://api.latitude.so/v1/mcp",
  getLatitudeIntegrationState: vi.fn(),
  loadLatitudeMcpWorkerConnection: vi.fn(),
}));
vi.mock("./integrations/slack-mcp", () => ({
  SLACK_MCP_ENDPOINT_URL: "https://mcp.slack.com/mcp",
  getSlackMcpIntegrationState: mocks.getSlackState,
  loadSlackMcpWorkerConnection: mocks.loadSlackConnection,
}));

import { createPluginGatewayLifecycle, resolvePluginGatewayRegistrations } from "./plugin-gateway";

const db = { sentinel: "db" };
const identity = { userWorkosId: "user_1", workspaceId: "workspace_1" };
const now = new Date("2026-08-26T12:00:00.000Z");

function record(overrides: Partial<PluginGatewayRegistrationRecord> = {}) {
  return {
    id: "plugin_gateway_1",
    workspaceId: "workspace_1",
    pluginId: "plugin_1",
    pluginName: "linear",
    pluginLabel: "linear",
    pluginDescription: "Linear plugin tools.",
    connectionProvider: "linear",
    server: {
      name: "linear",
      type: "streamable-http" as const,
      url: "https://mcp.linear.app/mcp",
      headers: {},
    },
    capabilities: [
      { id: "read" as const, label: "Read Linear", defaultMode: "on" as const, tools: [] },
    ],
    discoverySnapshot: [],
    discoveredAt: null,
    refreshAfter: new Date("2026-08-26T11:00:00.000Z"),
    lastDiscoveryError: null,
    ...overrides,
  } satisfies PluginGatewayRegistrationRecord;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimRefresh.mockResolvedValue(true);
  mocks.isActive.mockResolvedValue(true);
  mocks.listRegistrations.mockResolvedValue([record()]);
  mocks.discoverSnapshot.mockResolvedValue([
    {
      name: "new_tool",
      inputSchema: { type: "object" },
      classification: {
        capabilityId: "write",
        capabilityLabel: "Write & other tools",
        defaultMode: "ask",
        bucket: "write",
        curated: false,
      },
    },
  ]);
});

describe("plugin gateway registration cache", () => {
  it("refreshes an expired snapshot once and returns the newly classified drift", async () => {
    const registrations = await resolvePluginGatewayRegistrations(identity, { db, now });

    expect(mocks.claimRefresh).toHaveBeenCalledWith(db, {
      workspaceId: "workspace_1",
      registrationId: "plugin_gateway_1",
      staleAt: now,
      leaseUntil: new Date("2026-08-26T12:05:00.000Z"),
    });
    expect(mocks.discoverSnapshot).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ source: "plugin:linear:linear" }),
      undefined,
    );
    expect(mocks.storeSnapshot).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        registrationId: "plugin_gateway_1",
        snapshot: [
          expect.objectContaining({
            name: "new_tool",
            classification: expect.objectContaining({ curated: false, defaultMode: "ask" }),
          }),
        ],
      }),
    );
    expect(registrations).toEqual([
      expect.objectContaining({
        source: "plugin:linear:linear",
        discoverySnapshot: [expect.objectContaining({ name: "new_tool" })],
      }),
    ]);
  });

  it("serves a fresh snapshot without discovery and rejects endpoint/provider collisions", async () => {
    mocks.listRegistrations.mockResolvedValueOnce([
      record({
        refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
        discoverySnapshot: [
          {
            name: "list_issues",
            classification: {
              capabilityId: "read",
              capabilityLabel: "Read Linear",
              defaultMode: "on",
              bucket: "read",
              curated: true,
            },
          },
        ],
      }),
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toHaveLength(1);
    expect(mocks.discoverSnapshot).not.toHaveBeenCalled();

    mocks.listRegistrations.mockResolvedValueOnce([
      record({ server: { ...record().server, url: "https://evil.example/mcp" } }),
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("maps a production GitHub package row to github_user at the pinned MCP endpoint", async () => {
    const githubRecord = record({
      pluginName: "github",
      pluginLabel: "github",
      connectionProvider: "github",
      server: {
        name: "github",
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([githubRecord]);

    const [registration] = await resolvePluginGatewayRegistrations(identity, { db, now });
    expect(registration).toMatchObject({
      source: "plugin:github:github",
      connectionProvider: "github_user",
    });
    expect(registration?.getState).toBe(mocks.getGitHubState);
    expect(registration?.loadConnection).toBe(mocks.loadGitHubConnection);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...githubRecord,
        server: { ...githubRecord.server, url: "https://api.githubcopilot.com/mcp/" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toHaveLength(1);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...githubRecord,
        server: { ...githubRecord.server, url: "https://evil.example/mcp" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds Gmail credentials only to Google's exact hosted MCP endpoint", async () => {
    const gmailRecord = record({
      pluginName: "gmail",
      pluginLabel: "gmail",
      pluginDescription: "Gmail plugin tools.",
      connectionProvider: "gmail",
      server: {
        name: "gmail",
        type: "streamable-http",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        headers: {},
      },
      capabilities: [
        {
          id: "draft",
          label: "Create drafts",
          defaultMode: "ask",
          tools: ["create_draft"],
        },
      ],
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([gmailRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:gmail:gmail",
        connectionProvider: "gmail",
        getState: mocks.getGmailState,
        loadConnection: mocks.loadGmailConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...gmailRecord,
        server: {
          ...gmailRecord.server,
          url: "https://gmailmcp.googleapis.com.evil.example/mcp/v1",
        },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds the official Neon package only to the reviewed read-only endpoint", async () => {
    const neonEndpoint =
      "https://mcp.neon.tech/mcp?readonly=true&category=projects&category=branches&category=schema&category=querying";
    mocks.listRegistrations.mockResolvedValueOnce([
      record({
        pluginName: "neon",
        pluginLabel: "neon",
        pluginDescription: "Neon plugin tools.",
        connectionProvider: "neon",
        server: { name: "neon", type: "streamable-http", url: neonEndpoint, headers: {} },
        capabilities: [
          {
            id: "query",
            label: "Query database data",
            defaultMode: "ask",
            tools: ["run_sql"],
          },
        ],
        refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
      }),
    ]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:neon:neon",
        connectionProvider: "neon",
        getState: mocks.getNeonState,
        loadConnection: mocks.loadNeonConnection,
      }),
    ]);
  });

  it("binds the official Better Stack package only to the public hosted endpoint", async () => {
    const betterStackRecord = record({
      pluginName: "betterstack",
      pluginLabel: "betterstack",
      pluginDescription: "Better Stack plugin tools.",
      connectionProvider: "betterstack",
      server: {
        name: "betterstack",
        type: "streamable-http",
        url: "https://mcp.betterstack.com",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([betterStackRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:betterstack:betterstack",
        connectionProvider: "betterstack",
        getState: mocks.getBetterStackState,
        loadConnection: mocks.loadBetterStackConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...betterStackRecord,
        server: { ...betterStackRecord.server, url: "https://evil.example/mcp" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds Slack credentials only to Slack's exact hosted MCP endpoint", async () => {
    const slackRecord = record({
      pluginName: "slack",
      pluginLabel: "slack",
      pluginDescription: "Slack plugin tools.",
      connectionProvider: "slack",
      server: {
        name: "slack",
        type: "streamable-http",
        url: "https://mcp.slack.com/mcp",
        headers: {},
      },
      capabilities: [
        {
          id: "write",
          label: "Change Slack",
          defaultMode: "ask",
          tools: ["slack_send_message"],
        },
      ],
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([slackRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:slack:slack",
        connectionProvider: "slack",
        getState: mocks.getSlackState,
        loadConnection: mocks.loadSlackConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...slackRecord,
        server: { ...slackRecord.server, url: "https://mcp.slack.com.evil.example/mcp" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("forces discovery immediately after install through the lifecycle hook", async () => {
    const lifecycle = createPluginGatewayLifecycle({ db });
    await lifecycle.refresh({
      actor: {
        userId: "user_1",
        workspaceId: "workspace_1",
        role: "admin",
        permissions: ["skill:write"],
        authenticationMethod: "session",
      },
      pluginName: "linear",
      reason: "install",
    });

    expect(mocks.listRegistrations).toHaveBeenCalledWith(db, {
      workspaceId: "workspace_1",
      pluginName: "linear",
    });
    expect(mocks.claimRefresh).not.toHaveBeenCalled();
    expect(mocks.discoverSnapshot).toHaveBeenCalledOnce();
  });
});
