import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type IntegrationState, integrationStateFromRows } from "@/lib/integration-state";
import { InferenceSettingsPanel } from "./InferenceSettingsPanel";

const { refresh, setCodexWorkspaceEngineEnabled } = vi.hoisted(() => ({
  refresh: vi.fn(),
  setCodexWorkspaceEngineEnabled: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("@/lib/codex-auth", () => ({
  setCodexWorkspaceEngineEnabled,
}));

describe("InferenceSettingsPanel", () => {
  beforeEach(() => {
    refresh.mockReset();
    setCodexWorkspaceEngineEnabled.mockReset();
  });

  it("lets a connected workspace admin enable subscription-backed models", async () => {
    const integrations = integrationStateFromRows([]) as IntegrationState;
    integrations.codex.connected = true;
    setCodexWorkspaceEngineEnabled.mockResolvedValue({ ok: true });

    render(<InferenceSettingsPanel integration={integrations.codex} canManage />);

    fireEvent.click(screen.getByRole("button", { name: "Enable with my account" }));

    await waitFor(() => expect(setCodexWorkspaceEngineEnabled).toHaveBeenCalledWith(true));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows the active provider and reauthorization state", () => {
    const integrations = integrationStateFromRows([]) as IntegrationState;
    integrations.codex.workspaceEngine = {
      enabled: true,
      providerDisplayName: "Provider Admin",
      providerEmail: "provider@example.com",
      credentialStatus: "needs_reauth",
      credentialStatusReason: "Reconnect Codex.",
      lastValidatedAt: null,
      isCurrentUser: false,
    };

    render(<InferenceSettingsPanel integration={integrations.codex} canManage />);

    expect(screen.getByText(/Enabled · Provider Admin/)).toHaveTextContent(
      "Enabled · Provider Admin (provider@example.com)",
    );
    expect(screen.getByText("Reconnect Codex.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled();
  });

  it("keeps the workspace setting read-only for members", () => {
    const integrations = integrationStateFromRows([]) as IntegrationState;

    render(<InferenceSettingsPanel integration={integrations.codex} canManage={false} />);

    expect(screen.getByText("Managed by workspace admins.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
