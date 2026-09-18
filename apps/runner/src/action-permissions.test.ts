import { resolveActionCatalog } from "@opencompany/agent/actions/catalog";
import {
  applyIntegrationCapabilityMode,
  applyIntegrationToolMode,
} from "@opencompany/db/integrations";
import { getWorkspaceRole } from "@opencompany/db/workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { alwaysAllowAction } from "./action-permissions";

vi.mock("@opencompany/db/integrations", () => ({
  applyIntegrationCapabilityMode: vi.fn(async () => undefined),
  applyIntegrationToolMode: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/db/workspaces", () => ({
  getWorkspaceRole: vi.fn(async () => "member"),
}));
vi.mock("@opencompany/agent/actions/catalog", () => ({
  resolveActionCatalog: vi.fn(),
}));
vi.mock("@opencompany/agent/capabilities/resolve", () => ({
  resolveManagedCapabilities: vi.fn(),
}));

describe("alwaysAllowAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorkspaceRole).mockResolvedValue("member");
    vi.mocked(resolveActionCatalog).mockResolvedValue({
      providers: [],
      actions: [
        {
          id: "gmail.send_email",
          provider: "gmail",
          capability: "write",
          effects: {
            mutatesExternalSystem: true,
            metered: false,
            idempotent: false,
            destructive: false,
            uncertainAfterDispatch: true,
          },
          permissionMode: "ask",
          permission: {
            provider: "gmail",
            capabilityId: "write",
            label: "Send emails",
            integrationIds: ["gint_1", "gint_2"],
          },
          description: "Send email",
          params: {},
          execute: vi.fn(),
        },
      ],
    });
  });

  it("re-resolves the action and enables only its ask-mode connections", async () => {
    await expect(
      alwaysAllowAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: "gmail.send_email",
      }),
    ).resolves.toEqual({ changed: true });
    expect(applyIntegrationCapabilityMode).toHaveBeenCalledWith({
      integrationIds: ["gint_1", "gint_2"],
      capabilityId: "write",
      mode: "on",
    });
  });

  it("saves a plugin tool's standing grant against that tool, never its whole capability", async () => {
    const catalog = await vi.mocked(resolveActionCatalog)({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    const action = catalog.actions[0]!;
    action.id = "plugin:gmail:gmail.label_thread";
    action.permission!.toolId = "label_thread";
    vi.mocked(resolveActionCatalog).mockResolvedValue(catalog);
    await expect(
      alwaysAllowAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: action.id,
      }),
    ).resolves.toEqual({ changed: true });
    expect(applyIntegrationToolMode).toHaveBeenCalledWith({
      integrationIds: ["gint_1", "gint_2"],
      toolId: "label_thread",
      mode: "on",
    });
    // The sibling trash tools in the same capability must not be granted along with it.
    expect(applyIntegrationCapabilityMode).not.toHaveBeenCalled();
  });

  it("saves a custom MCP tool's standing grant, because the grant names that one tool", async () => {
    const catalog = await vi.mocked(resolveActionCatalog)({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    const action = catalog.actions[0]!;
    action.permission!.provider = "custom_mcp";
    action.permission!.toolId = "run_query";
    vi.mocked(resolveActionCatalog).mockResolvedValue(catalog);
    await expect(
      alwaysAllowAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: action.id,
      }),
    ).resolves.toEqual({ changed: true });
    expect(applyIntegrationToolMode).toHaveBeenCalledWith({
      integrationIds: ["gint_1", "gint_2"],
      toolId: "run_query",
      mode: "on",
    });
  });

  it("keeps custom MCP capability-wide grants unavailable when there is no tool key", async () => {
    const catalog = await vi.mocked(resolveActionCatalog)({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    const action = catalog.actions[0]!;
    action.permission!.provider = "custom_mcp";
    vi.mocked(resolveActionCatalog).mockResolvedValue(catalog);
    await expect(
      alwaysAllowAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: action.id,
      }),
    ).rejects.toThrow("individual custom MCP tools in Plugins");
    expect(applyIntegrationCapabilityMode).not.toHaveBeenCalled();
  });

  it("fails closed after workspace membership is revoked", async () => {
    vi.mocked(getWorkspaceRole).mockResolvedValue(null);
    await expect(
      alwaysAllowAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: "gmail.send_email",
      }),
    ).rejects.toThrow("no longer a member");
    expect(resolveActionCatalog).not.toHaveBeenCalled();
  });

  it("is a safe no-op when the action is already allowed", async () => {
    const catalog = await resolveActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    catalog.actions[0]!.permissionMode = "on";
    delete catalog.actions[0]!.permission;
    await expect(
      alwaysAllowAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: "gmail.send_email",
      }),
    ).resolves.toEqual({ changed: false });
    expect(applyIntegrationCapabilityMode).not.toHaveBeenCalled();
  });

  it("reports a save failure when the action disappears from the catalog", async () => {
    vi.mocked(resolveActionCatalog).mockResolvedValue({ providers: [], actions: [] });
    await expect(
      alwaysAllowAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: "gmail.send_email",
      }),
    ).rejects.toThrow("no longer available");
    expect(applyIntegrationCapabilityMode).not.toHaveBeenCalled();
  });
});
