import { resolvePlugin } from "@opencompany/agent-runtime";
import { createOfficialPluginFetcher } from "@opencompany/agent-runtime/official-plugin-artifacts";
import { OFFICIAL_PLUGIN_SOURCES } from "@opencompany/agent-runtime/official-plugin-catalog";
import type { PluginGatewayDiscoveredTool } from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { type RemoteMcpGatewayRegistration, resolveRemoteMcpActions } from "../actions/remote-mcp";
import type { ActionExecuteContext } from "../actions/types";
import { executeXApiTool } from "./x-api-tools";
import { xMcpCapabilities, xMcpDiscoverySnapshot } from "./x-mcp-catalog";
import { createXMcpClient } from "./x-mcp-client";

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductServerEvent: vi.fn(async () => undefined),
}));

const identity = { userWorkosId: "user_1", workspaceId: "workspace_1" };
const context = {
  ...identity,
  chatSessionId: "chat_1",
  signal: new AbortController().signal,
  currentDate: new Date(),
  userTimezone: "UTC",
} as ActionExecuteContext;

function tool(name: string): PluginGatewayDiscoveredTool {
  return {
    name,
    inputSchema: { type: "object" },
    classification: {
      capabilityId: "write",
      capabilityLabel: "Unknown",
      defaultMode: "ask",
      bucket: "write",
      curated: false,
    },
  };
}

describe("X gateway catalog", () => {
  it("classifies hosted spellings against the shipped immutable package", async () => {
    const plugin = await resolvePlugin({
      url: OFFICIAL_PLUGIN_SOURCES.x,
      fetcher: (await createOfficialPluginFetcher({ url: OFFICIAL_PLUGIN_SOURCES.x }))!,
      trustedCapabilitySources: ["useopencompany/plugins"],
    });
    const capabilities = xMcpCapabilities(plugin.capabilities);
    const snapshot = xMcpDiscoverySnapshot(
      [
        tool("get_posts_by_ids"),
        tool("get_users_bookmarks"),
        tool("unknown_future_tool"),
        tool("create_posts"),
      ],
      capabilities,
    );
    expect(snapshot.find((t) => t.name === "get_posts_by_ids")?.classification).toMatchObject({
      capabilityId: "read",
      curated: true,
      defaultMode: "on",
    });
    expect(snapshot.find((t) => t.name === "get_users_bookmarks")?.classification).toMatchObject({
      capabilityId: "query",
      curated: true,
      defaultMode: "ask",
    });
    expect(snapshot.find((t) => t.name === "unknown_future_tool")?.classification).toMatchObject({
      curated: false,
      defaultMode: "ask",
    });
    expect(snapshot.filter((t) => t.name === "create_posts")).toHaveLength(1);
    expect(snapshot.find((t) => t.name === "get_posts_analytics")?.classification).toMatchObject({
      capabilityId: "query",
      bucket: "read",
      defaultMode: "ask",
    });
  });

  function registration(): RemoteMcpGatewayRegistration {
    const capabilities = xMcpCapabilities([]);
    return {
      pluginName: "x",
      source: "plugin:x:x",
      connectionProvider: "x_account",
      label: "X",
      description: "X",
      server: { name: "x", type: "streamable-http", url: "https://api.x.com/mcp", headers: {} },
      capabilities,
      discoverySnapshot: xMcpDiscoverySnapshot([], capabilities),
      getState: vi.fn(async () => ({
        connected: true,
        integrationId: "gint_x",
        capabilityModes: {},
        toolModes: {},
      })),
      isEnabled: vi.fn(async () => true),
      loadConnection: vi.fn(),
    };
  }

  it("exposes new tools on old snapshots and honors write-off and individual tool overrides", async () => {
    const reg = registration();
    reg.getState = vi.fn(async () => ({
      connected: true,
      integrationId: "gint_x",
      capabilityModes: { write: "off", query: "ask" },
      toolModes: { search_posts_recent: "ask" },
    }));
    const catalog = await resolveRemoteMcpActions(identity, reg);
    expect(catalog?.actions.map((a) => a.id)).toEqual([
      "plugin:x:x.search_posts_recent",
      "plugin:x:x.get_posts_analytics",
    ]);
    expect(catalog?.actions.every((a) => a.permissionMode === "ask")).toBe(true);
  });

  it("validates, dispatches, audits, and unwraps an approved post through the real gateway and X adapter", async () => {
    const reg = registration();
    const apiCall = vi.fn().mockResolvedValue({ data: { id: "123", text: "" } });
    const createRemoteClient = vi.fn();
    const recordDispatch = vi.fn(async () => undefined);
    reg.loadConnection = vi.fn(async () => ({
      ok: true as const,
      integrationId: "gint_x",
      createClient: createXMcpClient({
        connection: { userWorkosId: identity.userWorkosId, integrationId: "gint_x" },
        createRemoteClient,
        executeApiTool: (input) => executeXApiTool({ ...input, apiCall }),
      }),
    }));
    const action = (await resolveRemoteMcpActions(identity, reg, { recordDispatch }))!.actions.find(
      (entry) => entry.id === "plugin:x:x.create_posts",
    )!;
    expect(action.permissionMode).toBe("ask");
    await expect(action.execute({ media_ids: ["456"] }, context)).resolves.toMatchObject({
      data: { id: "123", url: "https://x.com/i/status/123" },
    });
    expect(apiCall).toHaveBeenCalledExactlyOnceWith(
      { userWorkosId: identity.userWorkosId, integrationId: "gint_x" },
      "POST",
      new URL("https://api.x.com/2/tweets"),
      { signal: context.signal, body: { text: "", media: { media_ids: ["456"] } } },
    );
    expect(recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "plugin:x:x",
        integrationId: "gint_x",
        tool: "create_posts",
        capability: "write",
      }),
    );
    expect(createRemoteClient).not.toHaveBeenCalled();
    await expect(action.execute({ text: "hello", draft: true }, context)).rejects.toThrow();
    expect(apiCall).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "account_changed", "permission_changed", "wrong_user", "wrong_workspace"])(
    "blocks %s before invoking an API client",
    async (scenario) => {
      const reg = registration();
      reg.getState = vi.fn(async () => ({
        connected: true,
        integrationId: "gint_x",
        capabilityModes: { write: "on" },
        toolModes: {},
      }));
      const action = (await resolveRemoteMcpActions(identity, reg))!.actions.find((a) =>
        a.id.endsWith(".create_posts"),
      )!;
      let executionContext = context;
      if (scenario === "disabled") reg.isEnabled = vi.fn(async () => false);
      if (scenario === "account_changed")
        reg.getState = vi.fn(async () => ({
          connected: true,
          integrationId: "other",
          capabilityModes: {},
          toolModes: {},
        }));
      if (scenario === "permission_changed")
        reg.getState = vi.fn(async () => ({
          connected: true,
          integrationId: "gint_x",
          capabilityModes: { write: "ask" },
          toolModes: {},
        }));
      if (scenario === "wrong_user") executionContext = { ...context, userWorkosId: "other" };
      if (scenario === "wrong_workspace") executionContext = { ...context, workspaceId: "other" };
      await expect(action.execute({ text: "hello" }, executionContext)).rejects.toThrow();
      expect(reg.loadConnection).not.toHaveBeenCalled();
    },
  );
});
