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
  loadConnection: vi.fn(),
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
vi.mock("./integrations/posthog-mcp", () => ({
  POSTHOG_MCP_ENDPOINT_URL: "https://mcp.posthog.com/mcp",
  getPostHogIntegrationState: vi.fn(),
  loadPostHogMcpWorkerConnection: vi.fn(),
}));
vi.mock("./integrations/neon-mcp", () => ({
  NEON_MCP_ENDPOINT_URL: "https://mcp.neon.tech/mcp",
  getNeonIntegrationState: vi.fn(),
  loadNeonMcpWorkerConnection: vi.fn(),
}));
vi.mock("./integrations/latitude-mcp", () => ({
  LATITUDE_MCP_ENDPOINT_URL: "https://api.latitude.so/v1/mcp",
  getLatitudeIntegrationState: vi.fn(),
  loadLatitudeMcpWorkerConnection: vi.fn(),
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
