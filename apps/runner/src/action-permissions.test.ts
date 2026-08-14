import { resolveActionCatalog } from "@opencompany/agent/actions/catalog";
import { applyIntegrationCapabilityMode } from "@opencompany/db/integrations";
import { getWorkspaceRole } from "@opencompany/db/workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { alwaysAllowAction } from "./action-permissions";

vi.mock("@opencompany/db/integrations", () => ({
  applyIntegrationCapabilityMode: vi.fn(async () => undefined),
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

  it("is a safe no-op when the action no longer needs a standing permission", async () => {
    vi.mocked(resolveActionCatalog).mockResolvedValue({ providers: [], actions: [] });
    await expect(
      alwaysAllowAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: "gmail.send_email",
      }),
    ).resolves.toEqual({ changed: false });
    expect(applyIntegrationCapabilityMode).not.toHaveBeenCalled();
  });
});
