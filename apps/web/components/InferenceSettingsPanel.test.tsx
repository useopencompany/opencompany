import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type IntegrationState, integrationStateFromRows } from "@/lib/integration-state";
import type { WorkspaceSandboxSizeResult } from "@/lib/sandbox-size";
import { InferenceSettingsPanel, type SandboxSizeOptionView } from "./InferenceSettingsPanel";

const {
  disconnectClaudeCodeAuth,
  disconnectCodexAuth,
  loadCurrentClaudeCodeUsage,
  loadCurrentCodexUsage,
  pollCodexDeviceAuth,
  refresh,
  saveClaudeCodeToken,
  setCodexWorkspaceEngineEnabled,
  setWorkspaceSandboxSizeAction,
  startCodexDeviceAuth,
  toastError,
  toastSuccess,
} = vi.hoisted(() => ({
  disconnectClaudeCodeAuth: vi.fn(),
  disconnectCodexAuth: vi.fn(),
  loadCurrentClaudeCodeUsage: vi.fn(async () => ({
    ok: true,
    usage: { windows: [], updatedAt: new Date().toISOString() },
  })),
  loadCurrentCodexUsage: vi.fn(async () => ({
    ok: true,
    usage: { windows: [], updatedAt: new Date().toISOString() },
  })),
  pollCodexDeviceAuth: vi.fn(),
  refresh: vi.fn(),
  saveClaudeCodeToken: vi.fn(),
  setCodexWorkspaceEngineEnabled: vi.fn(),
  setWorkspaceSandboxSizeAction: vi.fn(),
  startCodexDeviceAuth: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock("@/lib/sandbox-size", () => ({ setWorkspaceSandboxSizeAction }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("@/lib/claude-code-auth", () => ({
  disconnectClaudeCodeAuth,
  loadCurrentClaudeCodeUsage,
  saveClaudeCodeToken,
}));

vi.mock("@/lib/codex-auth", () => ({
  disconnectCodexAuth,
  loadCurrentCodexUsage,
  pollCodexDeviceAuth,
  setCodexWorkspaceEngineEnabled,
  startCodexDeviceAuth,
}));

const SANDBOX_SIZE_OPTIONS: SandboxSizeOptionView[] = [
  {
    size: "small",
    label: "Small",
    summary: "Editing, small repos, and quick scripts.",
    cpuCount: 2,
    memoryMB: 4096,
    hourlyCostUsdMicros: 165_600,
  },
  {
    size: "standard",
    label: "Standard",
    summary: "Most work: installs, test suites, and a browser.",
    cpuCount: 4,
    memoryMB: 8192,
    hourlyCostUsdMicros: 331_200,
  },
  {
    size: "large",
    label: "Large",
    summary: "Heavy builds, containers, and large test runs.",
    cpuCount: 8,
    memoryMB: 16384,
    hourlyCostUsdMicros: 662_400,
  },
];

function renderPanel(
  integrations = integrationStateFromRows([]),
  canManage = false,
  sandboxSize: WorkspaceSandboxSizeResult = { ok: true, sandboxSize: "standard" },
) {
  return render(
    <InferenceSettingsPanel
      codex={integrations.codex}
      claudeCode={integrations.claude_code}
      canManage={canManage}
      sandboxSize={sandboxSize}
      sandboxSizeOptions={SANDBOX_SIZE_OPTIONS}
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
    setWorkspaceSandboxSizeAction.mockReset();
    startCodexDeviceAuth.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  it("shows each sandbox size with its allocation and hourly price, read-only for members", () => {
    renderPanel();

    const section = screen.getByRole("region", { name: "Sandbox size" });
    expect(within(section).getByText("Small · 2 vCPU · 4 GB")).toBeInTheDocument();
    expect(
      within(section).getByText(/About \$0\.33 per hour of running time\./),
    ).toBeInTheDocument();
    expect(within(section).getByText("Managed by workspace admins.")).toBeInTheDocument();
    for (const radio of within(section).getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });

  it("saves an admin's size change and says running sessions keep theirs", async () => {
    setWorkspaceSandboxSizeAction.mockResolvedValueOnce({ ok: true, sandboxSize: "small" });
    renderPanel(integrationStateFromRows([]), true);

    const section = screen.getByRole("region", { name: "Sandbox size" });
    fireEvent.click(within(section).getByRole("radio", { name: /Small/ }));

    await waitFor(() => expect(setWorkspaceSandboxSizeAction).toHaveBeenCalledWith("small"));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "New sessions will run on Small. Sessions already running keep their size.",
      ),
    );
    expect(within(section).getByRole("radio", { name: /Small/ })).toBeChecked();
  });

  it("restores the previous size when the save fails", async () => {
    setWorkspaceSandboxSizeAction.mockResolvedValueOnce({ ok: false, error: "Nope." });
    renderPanel(integrationStateFromRows([]), true);

    const section = screen.getByRole("region", { name: "Sandbox size" });
    fireEvent.click(within(section).getByRole("radio", { name: /Small/ }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Nope."));
    expect(within(section).getByRole("radio", { name: /Standard/ })).toBeChecked();
  });

  it("keeps the rest of the page usable when the size cannot be read", () => {
    renderPanel(integrationStateFromRows([]), true, { ok: false, error: "Could not load it." });

    const section = screen.getByRole("region", { name: "Sandbox size" });
    expect(within(section).getByText("Could not load it.")).toBeInTheDocument();
    expect(within(section).queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Coding subscriptions" })).toBeInTheDocument();
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
