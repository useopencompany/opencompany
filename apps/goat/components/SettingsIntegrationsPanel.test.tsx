import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type GoatIntegrationState, goatIntegrationStateFromRows } from "@/lib/integration-state";
import { SettingsIntegrationsPanel } from "./SettingsIntegrationsPanel";

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => false,
}));

vi.mock("@/lib/codex-auth", () => ({
  disconnectGoatCodexAuth: vi.fn(),
  pollGoatCodexDeviceAuth: vi.fn(),
  startGoatCodexDeviceAuth: vi.fn(),
}));

// Pulls in @/lib/auth (authkit), which vitest cannot resolve.
vi.mock("@/lib/integration-account-actions", () => ({
  disconnectGoatIntegrationAccountAction: vi.fn(async () => ({ ok: true })),
  getGoatIntegrationAccountUsageAction: vi.fn(async () => ({
    ok: true,
    affectedBrainSourceCount: 0,
  })),
}));

describe("SettingsIntegrationsPanel", () => {
  beforeEach(() => {
    toastError.mockClear();
    toastSuccess.mockClear();
    window.history.replaceState({}, "", "/settings/integrations");
  });

  it("shows an actionable OAuth error once and removes the consumed query parameters", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings/integrations?integration=hubspot&setup=error&reason=not_configured&section=personal",
    );

    render(
      <SettingsIntegrationsPanel
        initialIntegrations={goatIntegrationStateFromRows([]) as GoatIntegrationState}
        isWorkspaceAdmin
      />,
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledOnce();
    });
    expect(toastError).toHaveBeenCalledWith(
      "HubSpot isn't available right now. Please try again later.",
    );
    expect(window.location.search).toBe("?section=personal");
  });

  it("confirms a completed OAuth connection and clears its callback parameters", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings/integrations?integration=hubspot&setup=connected",
    );

    render(
      <SettingsIntegrationsPanel
        initialIntegrations={goatIntegrationStateFromRows([]) as GoatIntegrationState}
        isWorkspaceAdmin
      />,
    );

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("HubSpot connected.");
    });
    expect(window.location.search).toBe("");
  });

  it("does not surface Goat MCP as an integration (it lives in its own tab)", () => {
    render(
      <SettingsIntegrationsPanel
        initialIntegrations={goatIntegrationStateFromRows([]) as GoatIntegrationState}
        isWorkspaceAdmin={false}
      />,
    );

    expect(screen.queryByText("Goat MCP")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "/settings/mcp" })).not.toBeInTheDocument();
  });

  it("switches between the workspace and personal scopes", () => {
    render(
      <SettingsIntegrationsPanel
        initialIntegrations={goatIntegrationStateFromRows([]) as GoatIntegrationState}
        isWorkspaceAdmin
      />,
    );

    // Workspace scope is shown first: GitHub is a workspace-owned connection and
    // Gmail (personal) is hidden.
    expect(
      screen.getByText("Bring pull requests and issues from your repositories into Goat."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Let Goat read and act on your email.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    // Personal scope reveals the personal connections and hides the workspace ones.
    expect(screen.getByText("Let Goat read and act on your email.")).toBeInTheDocument();
    expect(
      screen.queryByText("Bring pull requests and issues from your repositories into Goat."),
    ).not.toBeInTheDocument();
  });

  it("renders the Linear MCP connection instead of the separate brain-source accounts", () => {
    const integrations = goatIntegrationStateFromRows([
      {
        id: "gint_linear_mcp",
        provider: "linear",
        externalId: "linear_mcp",
        accountName: "Linear",
        status: "connected",
      },
      {
        id: "gint_linear_source",
        provider: "linear",
        externalId: "linear_org_1",
        accountName: "Source workspace",
        status: "connected",
      },
    ]) as GoatIntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);

    // Linear lives under the Workspace scope, which is shown first.
    const linearCard = screen
      .getByText("Connect issues, projects, and comments from Linear.")
      .closest("div.rounded-2xl");
    expect(linearCard).not.toBeNull();
    expect(within(linearCard as HTMLElement).getByText("Connected")).toBeInTheDocument();
    expect(
      within(linearCard as HTMLElement).queryByText("Source workspace"),
    ).not.toBeInTheDocument();
    expect(within(linearCard as HTMLElement).queryByRole("link", { name: "Connect" })).toBeNull();
  });
});
