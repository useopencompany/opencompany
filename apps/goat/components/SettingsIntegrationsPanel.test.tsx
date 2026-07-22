import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
        mcpSetup={{ preferredClient: null, completedAt: null }}
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
        mcpSetup={{ preferredClient: null, completedAt: null }}
      />,
    );

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("HubSpot connected.");
    });
    expect(window.location.search).toBe("");
  });

  it("always exposes the permanent Goat Brain MCP entry", () => {
    render(
      <SettingsIntegrationsPanel
        initialIntegrations={goatIntegrationStateFromRows([]) as GoatIntegrationState}
        isWorkspaceAdmin={false}
        mcpSetup={{ preferredClient: null, completedAt: null }}
      />,
    );

    // The MCP card shows its title + client hint; its CTA links to the setup page.
    expect(screen.getByText("Goat MCP")).toBeInTheDocument();
    expect(screen.getByText("Claude, ChatGPT, or Cursor")).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: "Set up" });
    expect(cta).toHaveAttribute("href", "/settings/mcp");
  });

  it("reports the verified connection and remembered client", () => {
    render(
      <SettingsIntegrationsPanel
        initialIntegrations={goatIntegrationStateFromRows([]) as GoatIntegrationState}
        isWorkspaceAdmin
        mcpSetup={{
          preferredClient: "cursor",
          completedAt: "2026-07-13T09:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Goat MCP")).toBeInTheDocument();
    expect(screen.getByText("Connected with Cursor")).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: "Manage" });
    expect(cta).toHaveAttribute("href", "/settings/mcp");
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

    render(
      <SettingsIntegrationsPanel
        initialIntegrations={integrations}
        isWorkspaceAdmin
        mcpSetup={{ preferredClient: null, completedAt: null }}
      />,
    );

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
