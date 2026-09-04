import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type IntegrationState, integrationStateFromRows } from "@/lib/integration-state";
import { InferenceSettingsPanel } from "./InferenceSettingsPanel";

const {
  disconnectClaudeCodeAuth,
  disconnectCodexAuth,
  pollCodexDeviceAuth,
  refresh,
  saveClaudeCodeToken,
  setCodexWorkspaceEngineEnabled,
  startCodexDeviceAuth,
} = vi.hoisted(() => ({
  disconnectClaudeCodeAuth: vi.fn(),
  disconnectCodexAuth: vi.fn(),
  pollCodexDeviceAuth: vi.fn(),
  refresh: vi.fn(),
  saveClaudeCodeToken: vi.fn(),
  setCodexWorkspaceEngineEnabled: vi.fn(),
  startCodexDeviceAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("@/lib/claude-code-auth", () => ({
  disconnectClaudeCodeAuth,
  saveClaudeCodeToken,
}));

vi.mock("@/lib/codex-auth", () => ({
  disconnectCodexAuth,
  pollCodexDeviceAuth,
  setCodexWorkspaceEngineEnabled,
  startCodexDeviceAuth,
}));

function renderPanel(integrations = integrationStateFromRows([]), canManage = false) {
  return render(
    <InferenceSettingsPanel
      codex={integrations.codex}
      claudeCode={integrations.claude_code}
      canManage={canManage}
    />,
  );
}

describe("InferenceSettingsPanel", () => {
  beforeEach(() => {
    refresh.mockReset();
    disconnectClaudeCodeAuth.mockReset();
    disconnectCodexAuth.mockReset();
    pollCodexDeviceAuth.mockReset();
    saveClaudeCodeToken.mockReset();
    setCodexWorkspaceEngineEnabled.mockReset();
    startCodexDeviceAuth.mockReset();
  });

  it("places personal coding subscriptions alongside workspace model access", () => {
    renderPanel();

    const subscriptions = screen.getByRole("region", { name: "Coding subscriptions" });
    expect(within(subscriptions).getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(within(subscriptions).getByRole("heading", { name: "Claude Code" })).toBeInTheDocument();
    expect(
      within(subscriptions).getByText(/Each teammate manages their own connections/),
    ).toBeInTheDocument();

    const workspaceAccess = screen.getByRole("region", { name: "Workspace model access" });
    expect(
      within(workspaceAccess).getByRole("heading", { name: "Shared model access" }),
    ).toBeInTheDocument();
    expect(
      within(workspaceAccess).getByText("Using metered workspace credits."),
    ).toBeInTheDocument();
  });

  it("starts the Codex device sign-in flow", async () => {
    startCodexDeviceAuth.mockResolvedValue({
      ok: true,
      flow: {
        id: "gcodf_1",
        status: "code_ready",
        verificationUri: "https://example.com/device",
        userCode: "ABCD-EFGH",
        statusReason: null,
      },
    });
    renderPanel();

    const codexCard = screen.getByRole("heading", { name: "Codex" }).parentElement?.parentElement;
    expect(codexCard).not.toBeNull();
    fireEvent.click(within(codexCard as HTMLElement).getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("link", { name: "Open Codex sign-in" })).toHaveAttribute(
      "href",
      "https://example.com/device",
    );
    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
  });

  it("saves a Claude Code setup token", async () => {
    saveClaudeCodeToken.mockResolvedValue({ ok: true });
    renderPanel();

    const claudeCard = screen.getByRole("heading", { name: "Claude Code" }).parentElement
      ?.parentElement;
    expect(claudeCard).not.toBeNull();
    fireEvent.click(within(claudeCard as HTMLElement).getByRole("button", { name: "Connect" }));
    fireEvent.change(within(claudeCard as HTMLElement).getByPlaceholderText("sk-ant-oat…"), {
      target: { value: "setup-token" },
    });
    fireEvent.click(within(claudeCard as HTMLElement).getByRole("button", { name: "Save token" }));

    await waitFor(() => expect(saveClaudeCodeToken).toHaveBeenCalledWith("setup-token"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows a saved Claude Code token as pending until a successful turn validates it", () => {
    const integrations = integrationStateFromRows([]) as IntegrationState;
    integrations.claude_code = {
      provider: "claude_code",
      connected: true,
      status: "connected",
      statusReason: null,
      lastValidatedAt: null,
    };

    renderPanel(integrations);

    expect(screen.getByText("Token saved; validation pending")).toBeInTheDocument();
  });

  it("lets a connected workspace admin share their subscription", async () => {
    const integrations = integrationStateFromRows([]) as IntegrationState;
    integrations.codex.connected = true;
    setCodexWorkspaceEngineEnabled.mockResolvedValue({ ok: true });
    renderPanel(integrations, true);

    expect(screen.getByText(/Let everyone use GPT 5\.6 Sol and Terra/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Share my subscription" }));

    await waitFor(() => expect(setCodexWorkspaceEngineEnabled).toHaveBeenCalledWith(true));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows the shared provider and reauthorization state", () => {
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

    renderPanel(integrations, true);

    expect(screen.getByText(/Enabled · Provider Admin/)).toHaveTextContent(
      "Enabled · Provider Admin (provider@example.com)",
    );
    expect(screen.getByText("Reconnect Codex.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable shared access" })).toBeEnabled();
  });

  it("keeps workspace model access read-only for members", () => {
    renderPanel();

    const workspaceAccess = screen.getByRole("region", { name: "Workspace model access" });
    expect(within(workspaceAccess).getByText("Managed by workspace admins.")).toBeInTheDocument();
    expect(within(workspaceAccess).queryByRole("button")).not.toBeInTheDocument();
  });
});
