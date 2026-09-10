import { ACTION_EFFECTS_READ } from "@opencompany/agent/actions/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAttioActions: vi.fn(),
  resolveGmailActions: vi.fn(),
  resolveGoogleCalendarActions: vi.fn(),
  resolveGoogleDriveActions: vi.fn(),
  resolveLatitudeActions: vi.fn(),
  resolveNeonActions: vi.fn(),
  resolveLinearActions: vi.fn(),
  resolvePostHogActions: vi.fn(),
  resolveStripeActions: vi.fn(),
  resolveRevolutActions: vi.fn(),
  resolvePluginGatewayRegistrations: vi.fn(async () => []),
  resolveRemoteMcpActions: vi.fn(),
  listWorkspaceCapabilities: vi.fn(),
}));

vi.mock("@opencompany/db/capabilities", () => ({
  listWorkspaceCapabilities: mocks.listWorkspaceCapabilities,
}));

vi.mock("@opencompany/agent/actions/attio", () => ({
  resolveAttioActions: mocks.resolveAttioActions,
}));
vi.mock("@opencompany/agent/actions/gmail", () => ({
  resolveGmailActions: mocks.resolveGmailActions,
}));
vi.mock("@opencompany/agent/actions/google-calendar", () => ({
  resolveGoogleCalendarActions: mocks.resolveGoogleCalendarActions,
}));
vi.mock("@opencompany/agent/actions/google-drive", () => ({
  resolveGoogleDriveActions: mocks.resolveGoogleDriveActions,
}));
vi.mock("@opencompany/agent/actions/latitude", () => ({
  resolveLatitudeActions: mocks.resolveLatitudeActions,
}));
vi.mock("@opencompany/agent/actions/linear", () => ({
  resolveLinearActions: mocks.resolveLinearActions,
}));
vi.mock("@opencompany/agent/actions/neon", () => ({
  resolveNeonActions: mocks.resolveNeonActions,
}));
vi.mock("@opencompany/agent/actions/posthog", () => ({
  resolvePostHogActions: mocks.resolvePostHogActions,
}));
vi.mock("@opencompany/agent/actions/stripe", () => ({
  resolveStripeActions: mocks.resolveStripeActions,
}));
vi.mock("@opencompany/agent/actions/revolut", () => ({
  resolveRevolutActions: mocks.resolveRevolutActions,
}));
vi.mock("@opencompany/agent/plugin-gateway", () => ({
  resolvePluginGatewayRegistrations: mocks.resolvePluginGatewayRegistrations,
}));
vi.mock("@opencompany/agent/actions/remote-mcp", () => ({
  resolveRemoteMcpActions: mocks.resolveRemoteMcpActions,
}));

import { isChatActionsKilled, resolveActionCatalog } from "@/lib/actions/catalog";
import type { ActionProviderCatalog } from "@/lib/actions/types";

function providerCatalog(
  id:
    | "gmail"
    | "google_calendar"
    | "google_drive"
    | "latitude"
    | "neon"
    | "linear"
    | "posthog"
    | "attio"
    | "stripe"
    | "revolut",
): ActionProviderCatalog {
  return {
    id,
    label: `${id} label`,
    description: `${id} description`,
    actions: [
      {
        id: `${id}.read_something`,
        provider: id,
        capability: "read",
        effects: ACTION_EFFECTS_READ,
        permissionMode: "on",
        description: "read",
        params: { type: "object" },
        execute: vi.fn(),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePluginGatewayRegistrations.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isChatActionsKilled", () => {
  it("is off unless the env var is exactly true", () => {
    vi.stubEnv("OPENCOMPANY_CHAT_ACTIONS_KILL_SWITCH", "");
    expect(isChatActionsKilled()).toBe(false);
    vi.stubEnv("OPENCOMPANY_CHAT_ACTIONS_KILL_SWITCH", "1");
    expect(isChatActionsKilled()).toBe(false);
    vi.stubEnv("OPENCOMPANY_CHAT_ACTIONS_KILL_SWITCH", "true");
    expect(isChatActionsKilled()).toBe(true);
  });
});

describe("resolveActionCatalog", () => {
  it("does not expose legacy connections without a personal plugin installation", async () => {
    for (const resolver of [
      mocks.resolveGmailActions,
      mocks.resolveLinearActions,
      mocks.resolveNeonActions,
      mocks.resolveStripeActions,
      mocks.resolveRevolutActions,
    ]) {
      resolver.mockResolvedValue(providerCatalog("linear"));
    }
    const catalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog).toEqual({ providers: [], actions: [] });
    expect(mocks.resolvePluginGatewayRegistrations).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    for (const resolver of [
      mocks.resolveGmailActions,
      mocks.resolveLinearActions,
      mocks.resolveNeonActions,
      mocks.resolveStripeActions,
      mocks.resolveRevolutActions,
    ]) {
      expect(resolver).not.toHaveBeenCalled();
    }
  });

  it("keeps other personal plugins when one resolver throws", async () => {
    mocks.resolvePluginGatewayRegistrations.mockResolvedValue([
      { source: "plugin:linear:linear" },
      { source: "plugin:neon:neon" },
    ] as never);
    mocks.resolveRemoteMcpActions
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(providerCatalog("neon"));
    const catalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["neon"]);
  });

  it("returns an empty catalog when nothing is connected", async () => {
    mocks.resolveGmailActions.mockResolvedValue(null);
    mocks.resolveGoogleCalendarActions.mockResolvedValue(null);
    mocks.resolveGoogleDriveActions.mockResolvedValue(null);
    mocks.resolveLinearActions.mockResolvedValue(null);
    mocks.resolvePostHogActions.mockResolvedValue(null);
    mocks.resolveLatitudeActions.mockResolvedValue(null);
    mocks.resolveNeonActions.mockResolvedValue(null);
    mocks.resolveAttioActions.mockResolvedValue(null);
    mocks.resolveStripeActions.mockResolvedValue(null);
    mocks.resolveRevolutActions.mockResolvedValue(null);

    const catalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog).toEqual({ providers: [], actions: [] });
  });

  it("uses the installed Linear plugin catalog exactly once and removes it when uninstalled", async () => {
    for (const resolver of [
      mocks.resolveGmailActions,
      mocks.resolveGoogleCalendarActions,
      mocks.resolveGoogleDriveActions,
      mocks.resolvePostHogActions,
      mocks.resolveLatitudeActions,
      mocks.resolveNeonActions,
      mocks.resolveAttioActions,
      mocks.resolveStripeActions,
      mocks.resolveRevolutActions,
    ]) {
      resolver.mockResolvedValue(null);
    }
    const pluginAction = {
      ...providerCatalog("linear").actions[0]!,
      id: "plugin:linear:linear.list_issues",
      provider: "plugin:linear:linear" as const,
    };
    mocks.resolveLinearActions.mockResolvedValue(providerCatalog("linear"));
    mocks.resolvePluginGatewayRegistrations.mockResolvedValue([
      { source: "plugin:linear:linear" },
    ] as never);
    mocks.resolveRemoteMcpActions.mockResolvedValue({
      id: "plugin:linear:linear",
      label: "Linear",
      description: "Plugin Linear tools",
      actions: [pluginAction],
    });

    const pluginCatalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(mocks.resolveLinearActions).not.toHaveBeenCalled();
    expect(pluginCatalog.actions.map((action) => action.id)).toEqual([
      "plugin:linear:linear.list_issues",
    ]);

    mocks.resolvePluginGatewayRegistrations.mockResolvedValue([]);
    const fallbackCatalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(mocks.resolveLinearActions).not.toHaveBeenCalled();
    expect(fallbackCatalog.actions).toEqual([]);
  });

  it("uses the installed Neon plugin catalog exactly once and removes it when uninstalled", async () => {
    for (const resolver of [
      mocks.resolveGmailActions,
      mocks.resolveGoogleCalendarActions,
      mocks.resolveGoogleDriveActions,
      mocks.resolveLinearActions,
      mocks.resolvePostHogActions,
      mocks.resolveLatitudeActions,
      mocks.resolveAttioActions,
      mocks.resolveStripeActions,
      mocks.resolveRevolutActions,
    ]) {
      resolver.mockResolvedValue(null);
    }
    const pluginAction = {
      ...providerCatalog("neon").actions[0]!,
      id: "plugin:neon:neon.list_projects",
      provider: "plugin:neon:neon" as const,
    };
    mocks.resolveNeonActions.mockResolvedValue(providerCatalog("neon"));
    mocks.resolvePluginGatewayRegistrations.mockResolvedValue([
      { source: "plugin:neon:neon" },
    ] as never);
    mocks.resolveRemoteMcpActions.mockResolvedValue({
      id: "plugin:neon:neon",
      label: "Neon",
      description: "Plugin Neon tools",
      actions: [pluginAction],
    });

    const pluginCatalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(mocks.resolveNeonActions).not.toHaveBeenCalled();
    expect(pluginCatalog.actions.map((action) => action.id)).toEqual([
      "plugin:neon:neon.list_projects",
    ]);

    mocks.resolvePluginGatewayRegistrations.mockResolvedValue([]);
    const fallbackCatalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(mocks.resolveNeonActions).not.toHaveBeenCalled();
    expect(fallbackCatalog.actions).toEqual([]);
  });

  it("adds enabled managed sources to the same compact catalog", async () => {
    vi.stubEnv("MONID_API_KEY", "monid_test");
    vi.stubEnv("OPENCOMPANY_MANAGED_CAPABILITIES_KILL_SWITCH", "");
    mocks.resolveGmailActions.mockResolvedValue(null);
    mocks.resolveGoogleCalendarActions.mockResolvedValue(null);
    mocks.resolveGoogleDriveActions.mockResolvedValue(null);
    mocks.resolveLinearActions.mockResolvedValue(null);
    mocks.resolvePostHogActions.mockResolvedValue(null);
    mocks.resolveLatitudeActions.mockResolvedValue(null);
    mocks.resolveNeonActions.mockResolvedValue(null);
    mocks.resolveAttioActions.mockResolvedValue(null);
    mocks.resolveStripeActions.mockResolvedValue(null);
    mocks.resolveRevolutActions.mockResolvedValue(null);
    mocks.listWorkspaceCapabilities.mockResolvedValue([
      { source: "x", enabled: true },
      { source: "linkedin", enabled: false },
      { source: "youtube", enabled: true },
      { source: "instagram", enabled: true },
      { source: "tiktok", enabled: true },
      { source: "lead", enabled: true },
      { source: "seo", enabled: true },
    ]);

    const catalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog.providers.map((source) => [source.id, source.kind])).toEqual([
      ["x", "managed"],
      ["youtube", "managed"],
      ["instagram", "managed"],
      ["tiktok", "managed"],
      ["lead", "managed"],
      ["seo", "managed"],
    ]);
    expect(catalog.actions).not.toContainEqual(expect.objectContaining({ provider: "linkedin" }));
    expect(catalog.actions.filter((action) => action.provider === "x")).toHaveLength(7);
    expect(catalog.actions.filter((action) => action.provider === "lead")).toHaveLength(5);
    expect(catalog.actions.filter((action) => action.provider === "seo")).toHaveLength(6);
    expect(catalog.actions.find((action) => action.id === "youtube.get_transcript")).toMatchObject({
      provider: "youtube",
      maxResultChars: 256_000,
    });

    vi.stubEnv("OPENCOMPANY_DISABLED_MANAGED_CAPABILITY_ACTIONS", "x.search_posts");
    const endpointDisabledCatalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(endpointDisabledCatalog.actions.some((action) => action.id === "x.search_posts")).toBe(
      false,
    );
    expect(
      endpointDisabledCatalog.actions.filter((action) => action.provider === "x"),
    ).toHaveLength(6);
    expect(endpointDisabledCatalog.providers.some((source) => source.id === "x")).toBe(true);
  });

  it("removes managed sources behind the dedicated global kill switch", async () => {
    vi.stubEnv("MONID_API_KEY", "monid_test");
    vi.stubEnv("OPENCOMPANY_MANAGED_CAPABILITIES_KILL_SWITCH", "true");
    mocks.resolveGmailActions.mockResolvedValue(providerCatalog("gmail"));
    mocks.resolveGoogleCalendarActions.mockResolvedValue(null);
    mocks.resolveGoogleDriveActions.mockResolvedValue(null);
    mocks.resolveLinearActions.mockResolvedValue(null);
    mocks.resolvePostHogActions.mockResolvedValue(null);
    mocks.resolveLatitudeActions.mockResolvedValue(null);
    mocks.resolveNeonActions.mockResolvedValue(null);
    mocks.resolveAttioActions.mockResolvedValue(null);
    mocks.resolveStripeActions.mockResolvedValue(null);
    mocks.resolveRevolutActions.mockResolvedValue(null);

    const catalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog.providers).toEqual([]);
    expect(mocks.listWorkspaceCapabilities).not.toHaveBeenCalled();
  });
});
