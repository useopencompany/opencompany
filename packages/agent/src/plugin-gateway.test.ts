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
  loadGmailConnection: vi.fn(),
  getGranolaState: vi.fn(),
  loadGranolaConnection: vi.fn(),
  getGoogleCalendarState: vi.fn(),
  loadConnection: vi.fn(),
  loadGitHubConnection: vi.fn(),
  getGoogleDriveState: vi.fn(),
  loadGoogleDriveConnection: vi.fn(),
  loadGoogleCalendarConnection: vi.fn(),
  getHubSpotState: vi.fn(),
  loadHubSpotConnection: vi.fn(),
  getJamieState: vi.fn(),
  loadJamieConnection: vi.fn(),
  getLatitudeState: vi.fn(),
  loadLatitudeConnection: vi.fn(),
  getNeonState: vi.fn(),
  loadNeonConnection: vi.fn(),
  getBetterStackState: vi.fn(),
  loadBetterStackConnection: vi.fn(),
  getRenderState: vi.fn(),
  loadRenderConnection: vi.fn(),
  getPostHogState: vi.fn(),
  loadPostHogConnection: vi.fn(),
  getSlackState: vi.fn(),
  loadSlackConnection: vi.fn(),
  getSigNozState: vi.fn(),
  loadSigNozConnection: vi.fn(),
  getStripeState: vi.fn(),
  loadStripeConnection: vi.fn(),
  getXState: vi.fn(),
  loadXConnection: vi.fn(),
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
  GMAIL_MCP_ENDPOINT_URL: "https://api.opencompany.chat/mcp/plugins/gmail",
  gmailMcpRuntimeEndpointUrl: () => "https://api.opencompany.chat/mcp/plugins/gmail",
  getGmailMcpIntegrationState: mocks.getGmailState,
  loadGmailMcpWorkerConnection: mocks.loadGmailConnection,
}));
vi.mock("./integrations/granola-mcp", () => ({
  GRANOLA_MCP_ENDPOINT_URL: "https://mcp.granola.ai/mcp",
  getGranolaMcpIntegrationState: mocks.getGranolaState,
  loadGranolaMcpWorkerConnection: mocks.loadGranolaConnection,
}));
vi.mock("./integrations/google-calendar-mcp", () => ({
  GOOGLE_CALENDAR_MCP_ENDPOINT_URL: "https://api.opencompany.chat/mcp/plugins/google-calendar",
  googleCalendarMcpRuntimeEndpointUrl: () =>
    "https://api.opencompany.chat/mcp/plugins/google-calendar",
  getGoogleCalendarMcpIntegrationState: mocks.getGoogleCalendarState,
  loadGoogleCalendarMcpWorkerConnection: mocks.loadGoogleCalendarConnection,
}));
vi.mock("./integrations/google-drive-mcp", () => ({
  GOOGLE_DRIVE_MCP_ENDPOINT_URL: "https://api.opencompany.chat/mcp/plugins/google-drive",
  googleDriveMcpRuntimeEndpointUrl: () => "https://api.opencompany.chat/mcp/plugins/google-drive",
  getGoogleDriveMcpIntegrationState: mocks.getGoogleDriveState,
  loadGoogleDriveMcpWorkerConnection: mocks.loadGoogleDriveConnection,
}));
vi.mock("./integrations/hubspot-mcp", () => ({
  HUBSPOT_MCP_ENDPOINT_URL: "https://mcp.hubspot.com",
  getHubSpotMcpIntegrationState: mocks.getHubSpotState,
  loadHubSpotMcpWorkerConnection: mocks.loadHubSpotConnection,
}));
vi.mock("./integrations/jamie-mcp", () => ({
  JAMIE_MCP_ENDPOINT_URL: "https://mcp.meetjamie.ai/mcp",
  getJamieMcpIntegrationState: mocks.getJamieState,
  loadJamieMcpWorkerConnection: mocks.loadJamieConnection,
}));
vi.mock("./integrations/posthog-mcp", () => ({
  POSTHOG_MCP_ENDPOINT_URL:
    "https://mcp.posthog.com/mcp?mode=tools&tools=dashboards-get-all,dashboard-get,dashboard-insights-run,insights-list,insight-get,insight-query,read-data-schema,query-trends,query-funnel,query-retention,query-paths,query-stickiness,query-lifecycle,insight-create",
  getPostHogIntegrationState: mocks.getPostHogState,
  loadPostHogMcpWorkerConnection: mocks.loadPostHogConnection,
}));
vi.mock("./integrations/render-mcp", () => ({
  RENDER_MCP_ENDPOINT_URL: "https://mcp.render.com/mcp",
  getRenderIntegrationState: mocks.getRenderState,
  loadRenderMcpWorkerConnection: mocks.loadRenderConnection,
}));
vi.mock("./integrations/neon-mcp", () => ({
  NEON_MCP_ENDPOINT_URL:
    "https://mcp.neon.tech/mcp?readonly=true&category=projects&category=branches&category=schema&category=querying",
  getNeonIntegrationState: mocks.getNeonState,
  loadNeonMcpWorkerConnection: mocks.loadNeonConnection,
}));
vi.mock("./integrations/latitude-mcp", () => ({
  LATITUDE_MCP_ENDPOINT_URL: "https://api.latitude.so/v1/mcp",
  getLatitudeIntegrationState: mocks.getLatitudeState,
  loadLatitudeMcpWorkerConnection: mocks.loadLatitudeConnection,
}));
vi.mock("./integrations/slack-mcp", () => ({
  SLACK_MCP_ENDPOINT_URL: "https://mcp.slack.com/mcp",
  getSlackMcpIntegrationState: mocks.getSlackState,
  loadSlackMcpWorkerConnection: mocks.loadSlackConnection,
}));
vi.mock("./integrations/signoz-mcp", () => ({
  SIGNOZ_MCP_ENDPOINT_URL: "https://mcp.us.signoz.cloud/mcp",
  getSigNozIntegrationState: mocks.getSigNozState,
  loadSigNozMcpWorkerConnection: mocks.loadSigNozConnection,
}));
vi.mock("./integrations/stripe", () => ({
  STRIPE_MCP_ENDPOINT_URL: "https://mcp.stripe.com",
  getStripeMcpIntegrationState: mocks.getStripeState,
  loadStripeMcpWorkerConnection: mocks.loadStripeConnection,
}));
vi.mock("./integrations/x-mcp", () => ({
  X_MCP_ENDPOINT_URL: "https://api.x.com/mcp",
  getXMcpIntegrationState: mocks.getXState,
  loadXMcpWorkerConnection: mocks.loadXConnection,
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

  it("binds X credentials only to X's exact hosted MCP endpoint", async () => {
    const xRecord = record({
      pluginName: "x",
      pluginLabel: "x",
      pluginDescription: "Official X plugin tools.",
      connectionProvider: "x",
      server: {
        name: "x",
        type: "streamable-http",
        url: "https://api.x.com/mcp",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([xRecord]);

    const [registration] = await resolvePluginGatewayRegistrations(identity, { db, now });
    expect(registration).toMatchObject({
      source: "plugin:x:x",
      connectionProvider: "x_account",
    });
    expect(registration?.getState).toBe(mocks.getXState);
    expect(registration?.loadConnection).toBe(mocks.loadXConnection);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...xRecord,
        server: { ...xRecord.server, url: "https://api.x.com.evil.example/mcp" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds Gmail access only to opencompany's exact hosted MCP endpoint", async () => {
    const gmailRecord = record({
      pluginName: "gmail",
      pluginLabel: "gmail",
      pluginDescription: "Gmail plugin tools.",
      connectionProvider: "gmail",
      server: {
        name: "gmail",
        type: "streamable-http",
        url: "https://api.opencompany.chat/mcp/plugins/gmail",
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

    const registrations = await resolvePluginGatewayRegistrations(identity, { db, now });
    expect(registrations).toEqual([
      expect.objectContaining({
        source: "plugin:gmail:gmail",
        connectionProvider: "gmail",
        getState: mocks.getGmailState,
      }),
    ]);
    await registrations[0]!.loadConnection({
      ...identity,
      operation: { type: "tools/list" },
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    expect(mocks.loadGmailConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        ...identity,
        registrationId: "plugin_gateway_1",
        operation: { type: "tools/list" },
      }),
    );

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...gmailRecord,
        server: {
          ...gmailRecord.server,
          url: "https://api.opencompany.chat.evil.example/mcp/plugins/gmail",
        },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds Google credentials only to opencompany's exact Calendar MCP endpoint", async () => {
    const calendarRecord = record({
      pluginName: "google-calendar",
      pluginLabel: "google-calendar",
      pluginDescription: "Google Calendar plugin tools.",
      connectionProvider: "google-calendar",
      server: {
        name: "google-calendar",
        type: "streamable-http",
        url: "https://api.opencompany.chat/mcp/plugins/google-calendar",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([calendarRecord]);

    const registrations = await resolvePluginGatewayRegistrations(identity, { db, now });
    expect(registrations).toEqual([
      expect.objectContaining({
        source: "plugin:google-calendar:google-calendar",
        connectionProvider: "google_calendar",
        getState: mocks.getGoogleCalendarState,
      }),
    ]);
    await registrations[0]!.loadConnection({
      ...identity,
      operation: { type: "tools/list" },
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    expect(mocks.loadGoogleCalendarConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        ...identity,
        registrationId: "plugin_gateway_1",
        operation: { type: "tools/list" },
      }),
    );

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...calendarRecord,
        server: {
          ...calendarRecord.server,
          url: "https://api.opencompany.chat.evil.example/mcp/plugins/google-calendar",
        },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds Granola OAuth only to Granola's exact hosted MCP endpoint", async () => {
    const granolaRecord = record({
      pluginName: "granola",
      pluginLabel: "granola",
      pluginDescription: "Granola meeting tools.",
      connectionProvider: "granola",
      server: {
        name: "granola",
        type: "streamable-http",
        url: "https://mcp.granola.ai/mcp",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([granolaRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:granola:granola",
        connectionProvider: "granola",
        getState: mocks.getGranolaState,
        loadConnection: mocks.loadGranolaConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...granolaRecord,
        server: { ...granolaRecord.server, url: "https://mcp.granola.ai.evil.example/mcp" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds Google credentials only to opencompany's exact Drive MCP endpoint", async () => {
    const googleDriveRecord = record({
      pluginName: "google-drive",
      pluginLabel: "google-drive",
      pluginDescription: "Google Drive plugin tools.",
      connectionProvider: "google-drive",
      server: {
        name: "google-drive",
        type: "streamable-http",
        url: "https://api.opencompany.chat/mcp/plugins/google-drive",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([googleDriveRecord]);

    const registrations = await resolvePluginGatewayRegistrations(identity, { db, now });
    expect(registrations).toEqual([
      expect.objectContaining({
        source: "plugin:google-drive:google-drive",
        connectionProvider: "google_drive",
        getState: mocks.getGoogleDriveState,
      }),
    ]);
    await registrations[0]!.loadConnection({
      ...identity,
      operation: { type: "tools/list" },
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    expect(mocks.loadGoogleDriveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        ...identity,
        registrationId: "plugin_gateway_1",
        operation: { type: "tools/list" },
      }),
    );

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...googleDriveRecord,
        server: {
          ...googleDriveRecord.server,
          url: "https://api.opencompany.chat.evil.example/mcp/plugins/google-drive",
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

  it("binds SigNoz credentials only to the reviewed US Cloud endpoint", async () => {
    mocks.listRegistrations.mockResolvedValueOnce([
      record({
        pluginName: "signoz",
        pluginLabel: "signoz",
        pluginDescription: "SigNoz plugin tools.",
        connectionProvider: "signoz",
        server: {
          name: "signoz",
          type: "streamable-http",
          url: "https://mcp.us.signoz.cloud/mcp",
          headers: {},
        },
        refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
      }),
    ]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:signoz:signoz",
        connectionProvider: "signoz",
        getState: mocks.getSigNozState,
        loadConnection: mocks.loadSigNozConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      record({
        pluginName: "signoz",
        connectionProvider: "signoz",
        server: {
          name: "signoz",
          type: "streamable-http",
          url: "https://mcp.eu.signoz.cloud/mcp",
          headers: {},
        },
      }),
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds PostHog credentials only to the reviewed tool-filtered endpoint", async () => {
    const endpoint =
      "https://mcp.posthog.com/mcp?mode=tools&tools=dashboards-get-all,dashboard-get,dashboard-insights-run,insights-list,insight-get,insight-query,read-data-schema,query-trends,query-funnel,query-retention,query-paths,query-stickiness,query-lifecycle,insight-create";
    const posthogRecord = record({
      pluginName: "posthog",
      pluginLabel: "posthog",
      pluginDescription: "PostHog analytics tools.",
      connectionProvider: "posthog",
      server: {
        name: "posthog",
        type: "streamable-http",
        url: endpoint,
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([posthogRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:posthog:posthog",
        connectionProvider: "posthog",
        getState: mocks.getPostHogState,
        loadConnection: mocks.loadPostHogConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...posthogRecord,
        server: { ...posthogRecord.server, url: "https://mcp.posthog.com/mcp" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds Latitude credentials only to Latitude's exact hosted MCP endpoint", async () => {
    const latitudeRecord = record({
      pluginName: "latitude",
      pluginLabel: "latitude",
      pluginDescription: "Latitude observability tools.",
      connectionProvider: "latitude",
      server: {
        name: "latitude",
        type: "streamable-http",
        url: "https://api.latitude.so/v1/mcp",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([latitudeRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:latitude:latitude",
        connectionProvider: "latitude",
        getState: mocks.getLatitudeState,
        loadConnection: mocks.loadLatitudeConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...latitudeRecord,
        server: { ...latitudeRecord.server, url: "https://api.latitude.so/v1/mcp/other" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds HubSpot credentials only to HubSpot's exact hosted MCP endpoint", async () => {
    const hubspotRecord = record({
      pluginName: "hubspot",
      pluginLabel: "hubspot",
      pluginDescription: "HubSpot CRM tools.",
      connectionProvider: "hubspot",
      server: {
        name: "hubspot",
        type: "streamable-http",
        url: "https://mcp.hubspot.com",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([hubspotRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:hubspot:hubspot",
        connectionProvider: "hubspot",
        getState: mocks.getHubSpotState,
        loadConnection: mocks.loadHubSpotConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...hubspotRecord,
        server: { ...hubspotRecord.server, url: "https://evil.example/mcp" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds Jamie OAuth credentials only to Jamie's exact hosted MCP endpoint", async () => {
    const jamieRecord = record({
      pluginName: "jamie",
      pluginLabel: "jamie",
      pluginDescription: "Jamie meeting tools.",
      connectionProvider: "jamie",
      server: {
        name: "jamie",
        type: "streamable-http",
        url: "https://mcp.meetjamie.ai/mcp",
        headers: {},
      },
      capabilities: [
        {
          id: "query",
          label: "Read meetings & tasks",
          defaultMode: "ask",
          tools: ["list_meetings", "get_meeting", "list_tasks"],
        },
      ],
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([jamieRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:jamie:jamie",
        connectionProvider: "jamie",
        getState: mocks.getJamieState,
        loadConnection: mocks.loadJamieConnection,
        capabilities: [
          expect.objectContaining({
            id: "query",
            defaultMode: "ask",
            tools: ["list_meetings", "get_meeting", "list_tasks"],
          }),
        ],
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...jamieRecord,
        server: { ...jamieRecord.server, url: "https://mcp.meetjamie.ai.evil.example/mcp" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
  });

  it("binds Stripe credentials only to the reviewed hosted endpoint", async () => {
    const stripeRecord = record({
      pluginName: "stripe",
      pluginLabel: "stripe",
      pluginDescription: "Stripe account tools.",
      connectionProvider: "stripe",
      server: {
        name: "stripe",
        type: "streamable-http",
        url: "https://mcp.stripe.com",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([stripeRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:stripe:stripe",
        connectionProvider: "stripe",
        getState: mocks.getStripeState,
        loadConnection: mocks.loadStripeConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...stripeRecord,
        server: { ...stripeRecord.server, url: "https://mcp.example.com" },
      },
    ]);
    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([]);
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

  it("binds Render API-key credentials only to Render's exact hosted MCP endpoint", async () => {
    const renderRecord = record({
      pluginName: "render",
      pluginLabel: "render",
      pluginDescription: "Render plugin tools.",
      connectionProvider: "render",
      server: {
        name: "render",
        type: "streamable-http",
        url: "https://mcp.render.com/mcp",
        headers: {},
      },
      refreshAfter: new Date("2026-08-26T13:00:00.000Z"),
    });
    mocks.listRegistrations.mockResolvedValueOnce([renderRecord]);

    await expect(resolvePluginGatewayRegistrations(identity, { db, now })).resolves.toEqual([
      expect.objectContaining({
        source: "plugin:render:render",
        connectionProvider: "render",
        getState: mocks.getRenderState,
        loadConnection: mocks.loadRenderConnection,
      }),
    ]);

    mocks.listRegistrations.mockResolvedValueOnce([
      {
        ...renderRecord,
        server: { ...renderRecord.server, url: "https://mcp.render.com.evil.example/mcp" },
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
