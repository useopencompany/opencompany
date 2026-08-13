import { applyGoatIntegrationCapabilityMode } from "@opencompany/db/goat-integrations";
import { getGoatWorkspaceRole } from "@opencompany/db/goat-workspaces";
import { resolveGoatActionCatalog } from "@opencompany/goat-agent/actions/catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { alwaysAllowGoatAction } from "./goat-action-permissions";

vi.mock("@opencompany/db/goat-integrations", () => ({
  applyGoatIntegrationCapabilityMode: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/db/goat-workspaces", () => ({
  getGoatWorkspaceRole: vi.fn(async () => "member"),
}));
vi.mock("@opencompany/goat-agent/actions/catalog", () => ({
  resolveGoatActionCatalog: vi.fn(),
}));
vi.mock("@opencompany/goat-agent/capabilities/resolve", () => ({
  resolveGoatManagedCapabilities: vi.fn(),
}));

describe("alwaysAllowGoatAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoatWorkspaceRole).mockResolvedValue("member");
    vi.mocked(resolveGoatActionCatalog).mockResolvedValue({
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
      alwaysAllowGoatAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: "gmail.send_email",
      }),
    ).resolves.toEqual({ changed: true });
    expect(applyGoatIntegrationCapabilityMode).toHaveBeenCalledWith({
      integrationIds: ["gint_1", "gint_2"],
      capabilityId: "write",
      mode: "on",
    });
  });

  it("fails closed after workspace membership is revoked", async () => {
    vi.mocked(getGoatWorkspaceRole).mockResolvedValue(null);
    await expect(
      alwaysAllowGoatAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: "gmail.send_email",
      }),
    ).rejects.toThrow("no longer a member");
    expect(resolveGoatActionCatalog).not.toHaveBeenCalled();
  });

  it("is a safe no-op when the action no longer needs a standing permission", async () => {
    vi.mocked(resolveGoatActionCatalog).mockResolvedValue({ providers: [], actions: [] });
    await expect(
      alwaysAllowGoatAction({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: "gmail.send_email",
      }),
    ).resolves.toEqual({ changed: false });
    expect(applyGoatIntegrationCapabilityMode).not.toHaveBeenCalled();
  });
});
