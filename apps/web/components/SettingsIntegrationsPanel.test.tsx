import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type IntegrationState, integrationStateFromRows } from "@/lib/integration-state";
import { SettingsIntegrationsPanel } from "./SettingsIntegrationsPanel";

const {
  completeInfisicalAuth,
  disconnectInfisicalAuth,
  startInfisicalAuth,
  toastError,
  toastSuccess,
} = vi.hoisted(() => ({
  completeInfisicalAuth: vi.fn(),
  disconnectInfisicalAuth: vi.fn(),
  startInfisicalAuth: vi.fn(),
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
  disconnectCodexAuth: vi.fn(),
  pollCodexDeviceAuth: vi.fn(),
  setCodexWorkspaceEngineEnabled: vi.fn(),
  startCodexDeviceAuth: vi.fn(),
}));

vi.mock("@/lib/infisical-auth", () => ({
  completeInfisicalAuth: completeInfisicalAuth,
  disconnectInfisicalAuth: disconnectInfisicalAuth,
  startInfisicalAuth: startInfisicalAuth,
}));

// Pulls in @/lib/auth (authkit), which vitest cannot resolve.
vi.mock("@/lib/claude-code-auth", () => ({
  disconnectClaudeCodeAuth: vi.fn(async () => ({ ok: true })),
  saveClaudeCodeToken: vi.fn(async () => ({ ok: true })),
}));

// Pulls in @/lib/auth (authkit), which vitest cannot resolve.
vi.mock("@/lib/integration-account-actions", () => ({
  disconnectIntegrationAccountAction: vi.fn(async () => ({ ok: true })),
  getIntegrationAccountUsageAction: vi.fn(async () => ({
    ok: true,
    affectedBrainSourceCount: 0,
  })),
  setIntegrationCapabilityModeAction: vi.fn(async () => ({ ok: true })),
}));

describe("SettingsIntegrationsPanel", () => {
  beforeEach(() => {
    toastError.mockClear();
    toastSuccess.mockClear();
    completeInfisicalAuth.mockReset();
    disconnectInfisicalAuth.mockReset();
    startInfisicalAuth.mockReset();
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
        initialIntegrations={integrationStateFromRows([]) as IntegrationState}
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
        initialIntegrations={integrationStateFromRows([]) as IntegrationState}
        isWorkspaceAdmin
      />,
    );

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("HubSpot connected.");
    });
    expect(window.location.search).toBe("");
  });

  it("does not surface opencompany MCP as an integration (it lives in its own tab)", () => {
    render(
      <SettingsIntegrationsPanel
        initialIntegrations={integrationStateFromRows([]) as IntegrationState}
        isWorkspaceAdmin={false}
      />,
    );

    expect(screen.queryByText("opencompany MCP")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "/settings/mcp" })).not.toBeInTheDocument();
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

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    expect(screen.getByText("Token saved; validation pending")).toBeInTheDocument();
  });

  it("switches between the workspace and personal scopes", () => {
    render(
      <SettingsIntegrationsPanel
        initialIntegrations={integrationStateFromRows([]) as IntegrationState}
        isWorkspaceAdmin
      />,
    );

    // Workspace scope is shown first and personal connections are hidden.
    expect(
      screen.getByText(
        "Ingest pull requests and issues from selected repositories through webhooks.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Let opencompany view and update your schedule and events."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    // Personal scope reveals non-plugin connections and hides workspace-owned ones.
    expect(
      screen.getByText("Observe, understand, and improve your AI agents from opencompany."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Sync files and folders you choose into opencompany."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Let opencompany read and act on your email."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Let opencompany view and update your schedule and events."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Ingest pull requests and issues from selected repositories through webhooks.",
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps subscription-backed model routing out of Integrations", () => {
    const integrations = integrationStateFromRows([]) as IntegrationState;
    integrations.codex.workspaceEngine = {
      enabled: true,
      providerDisplayName: "Provider Admin",
      providerEmail: "provider@example.com",
      credentialStatus: "connected",
      credentialStatusReason: null,
      lastValidatedAt: null,
      isCurrentUser: false,
    };

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);

    expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workspace 1" })).not.toBeInTheDocument();
    expect(screen.queryByText("Subscription-backed models")).not.toBeInTheDocument();
  });

  it("lets workspace admins complete the Infisical browser-token handoff", async () => {
    startInfisicalAuth.mockResolvedValue({
      ok: true,
      flow: {
        id: "ginff_123",
        status: "link_ready",
        loginUrl: "https://app.infisical.com/login?callback_port=12345",
        statusReason: null,
        expiresAt: "2026-08-05T17:00:00.000Z",
      },
    });
    completeInfisicalAuth.mockResolvedValue({
      ok: true,
      flow: {
        id: "ginff_123",
        status: "completed",
        loginUrl: "https://app.infisical.com/login?callback_port=12345",
        statusReason: null,
        expiresAt: "2026-08-05T17:00:00.000Z",
      },
    });

    render(
      <SettingsIntegrationsPanel
        initialIntegrations={integrationStateFromRows([])}
        isWorkspaceAdmin
      />,
    );
    const card = screen
      .getByText("Give workspace coding agents access to the real Infisical CLI.")
      .closest("div.rounded-2xl");
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(startInfisicalAuth).toHaveBeenCalledWith({
        host: "https://app.infisical.com",
      });
      expect(
        within(card as HTMLElement).getByRole("link", { name: /Open Infisical sign-in/ }),
      ).toHaveAttribute("href", "https://app.infisical.com/login?callback_port=12345");
    });
    fireEvent.change(within(card as HTMLElement).getByPlaceholderText("Paste browser token"), {
      target: { value: "browser-token" },
    });
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Finish connection" }));

    await waitFor(() => {
      expect(completeInfisicalAuth).toHaveBeenCalledWith({
        flowId: "ginff_123",
        browserToken: "browser-token",
      });
    });
  });

  it("starts Infisical authentication in the selected EU region", async () => {
    startInfisicalAuth.mockResolvedValue({
      ok: true,
      flow: {
        id: "ginff_eu",
        status: "link_ready",
        loginUrl: "https://eu.infisical.com/login?callback_port=23456",
        statusReason: null,
        expiresAt: "2026-08-05T17:00:00.000Z",
      },
    });

    render(
      <SettingsIntegrationsPanel
        initialIntegrations={integrationStateFromRows([])}
        isWorkspaceAdmin
      />,
    );
    const card = screen
      .getByText("Give workspace coding agents access to the real Infisical CLI.")
      .closest("div.rounded-2xl");
    expect(card).not.toBeNull();

    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "EU" }));
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(startInfisicalAuth).toHaveBeenCalledWith({
        host: "https://eu.infisical.com",
      });
      expect(
        within(card as HTMLElement).getByRole("link", { name: /Open Infisical sign-in/ }),
      ).toHaveAttribute("href", "https://eu.infisical.com/login?callback_port=23456");
    });
    expect(
      within(card as HTMLElement).getByText(/Open Infisical EU, finish signing in/),
    ).toBeVisible();
  });

  it("restores the saved Infisical region for reconnects", () => {
    const integrations = integrationStateFromRows([]);
    integrations.infisical = {
      provider: "infisical",
      connected: true,
      status: "connected",
      statusReason: null,
      accountEmail: "founder@example.com",
      host: "https://eu.infisical.com",
      lastValidatedAt: "2026-08-07T06:00:00.000Z",
    };

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    const card = screen
      .getByText("Give workspace coding agents access to the real Infisical CLI.")
      .closest("div.rounded-2xl");
    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByText("Connected as founder@example.com · EU"),
    ).toBeVisible();
    expect(within(card as HTMLElement).getByRole("button", { name: "EU" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps workspace Infisical read-only for non-admin members", () => {
    render(
      <SettingsIntegrationsPanel
        initialIntegrations={integrationStateFromRows([])}
        isWorkspaceAdmin={false}
      />,
    );
    const card = screen
      .getByText("Give workspace coding agents access to the real Infisical CLI.")
      .closest("div.rounded-2xl");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("Managed by workspace admins.")).toBeVisible();
    expect(within(card as HTMLElement).queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("links a connected GitHub workspace to repository configuration", () => {
    const integrations = integrationStateFromRows([]) as IntegrationState;
    integrations.github = {
      provider: "github",
      connected: true,
      status: "connected",
      accountName: "opencompany",
      statusReason: null,
    };

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);

    expect(screen.getByText("GitHub workspace ingestion")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configure repositories" })).toHaveAttribute(
      "href",
      "/settings/repositories",
    );
  });

  it("keeps Linear out of the legacy Integrations panel", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_linear_mcp",
        provider: "linear",
        externalId: "linear_mcp",
        accountName: "Linear",
        status: "connected",
        capabilityModes: {},
      },
      {
        id: "gint_linear_source",
        provider: "linear",
        externalId: "linear_org_1",
        accountName: "Source workspace",
        status: "connected",
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);

    expect(
      screen.queryByText("Connect issues, projects, and comments from Linear."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Source workspace")).not.toBeInTheDocument();
  });

  it("keeps Slack out of the legacy Integrations panel", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_slack",
        provider: "slack",
        externalId: "T123",
        connectionLabel: "Acme",
        accountName: "Louis",
        status: "connected",
        capabilityModes: {},
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    expect(screen.queryByText("Acme")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Personal" })).not.toHaveTextContent("1");
  });

  it("keeps Google Calendar out of the legacy Integrations panel", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_google_calendar",
        provider: "google_calendar",
        externalId: "google-user-1",
        accountEmail: "ada@example.com",
        accountName: "Ada",
        status: "connected",
        capabilityModes: {},
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    expect(screen.queryByText("Ada")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Let opencompany read and manage your calendar events."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Personal" })).not.toHaveTextContent("1");
  });

  it("keeps the PostHog connection off the legacy integrations surface", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_posthog_mcp",
        provider: "posthog",
        externalId: "posthog_mcp",
        accountName: "PostHog",
        status: "connected",
        capabilityModes: {},
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);

    expect(screen.queryByText("PostHog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workspace" })).not.toHaveTextContent("1");
  });

  it("removes the legacy Gmail settings card after the plugin cutover", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_gmail",
        provider: "gmail",
        externalId: "google_account_1",
        accountEmail: "louis@example.com",
        status: "connected",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        capabilityModes: {},
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    expect(screen.queryByText("Let opencompany read and act on your email.")).toBeNull();
    expect(screen.queryByText("louis@example.com")).toBeNull();
  });

  it("shows Attio read and write permission controls on the connected workspace", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_attio",
        provider: "attio",
        externalId: "attio_workspace_1",
        connectionLabel: "Acme CRM",
        status: "connected",
        capabilityModes: {},
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);

    const attioCard = screen
      .getByText("Sync CRM records and notes from Attio.")
      .closest("div.rounded-2xl");
    expect(attioCard).not.toBeNull();
    const readPermission = within(attioCard as HTMLElement).getByRole("group", {
      name: "Read Attio permission",
    });
    const writePermission = within(attioCard as HTMLElement).getByRole("group", {
      name: "Update Attio permission",
    });
    expect(within(readPermission).getByRole("button", { name: "On" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(writePermission).getByRole("button", { name: "Ask" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps Google Drive out of legacy integrations now that its account lives under Plugins", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_drive",
        provider: "google_drive",
        externalId: "google_account_1",
        accountEmail: "founder@example.com",
        status: "connected",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        capabilityModes: {},
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    expect(
      screen.queryByText("Sync files and folders you choose into opencompany."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("founder@example.com")).not.toBeInTheDocument();
  });

  it("connects Latitude as a personal OAuth integration with guarded writes", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_latitude",
        provider: "latitude",
        externalId: "latitude_mcp",
        connectionLabel: "Latitude",
        status: "connected",
        capabilityModes: {},
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    const latitudeCard = screen
      .getByText("Observe, understand, and improve your AI agents from opencompany.")
      .closest("div.rounded-2xl");
    expect(latitudeCard).not.toBeNull();
    expect(within(latitudeCard as HTMLElement).getByText("Connected")).toBeInTheDocument();
    expect(
      within(latitudeCard as HTMLElement).getByRole("group", {
        name: "Read Latitude permission",
      }),
    ).toHaveTextContent("On");
    expect(
      within(latitudeCard as HTMLElement).getByRole("group", {
        name: "Manage Latitude permission",
      }),
    ).toHaveTextContent("Ask");
    expect(
      within(latitudeCard as HTMLElement).getByRole("link", { name: "Add account" }),
    ).toHaveAttribute("href", "/api/integrations/latitude/start?returnTo=/settings/integrations");
  });

  it("keeps Neon out of legacy integrations now that its account lives under Plugins", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_neon",
        provider: "neon",
        externalId: "neon_mcp",
        connectionLabel: "Neon",
        status: "connected",
        scopes: ["read"],
        capabilityModes: {},
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    expect(
      screen.queryByText(
        "Inspect Neon projects and schemas, and run permission-gated read-only SQL.",
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps X accounts out of legacy settings now that they live under Plugins", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_x_founder",
        provider: "x_account",
        externalId: "x_user_1",
        connectionLabel: "@founder",
        accountName: "Founder",
        status: "connected",
        capabilityModes: {},
      },
      {
        id: "gint_x_company",
        provider: "x_account",
        externalId: "x_user_2",
        connectionLabel: "@acme",
        accountName: "Acme",
        status: "connected",
        capabilityModes: {},
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    expect(
      screen.queryByText("Connect X accounts and publish account-specific posts from chat."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("@founder · Founder")).not.toBeInTheDocument();
    expect(screen.queryByText("@acme · Acme")).not.toBeInTheDocument();
  });

  it("shows a workspace-owned Stripe connection and test-mode label", () => {
    const integrations = integrationStateFromRows([
      {
        id: "gint_stripe",
        workspaceId: "workspace_1",
        provider: "stripe",
        externalId: "acct_123",
        connectionLabel: "Acme Payments",
        accountType: "stripe_test_restricted_key",
        status: "connected",
      },
    ]) as IntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);

    const stripeCard = screen
      .getByText(
        "Give opencompany read-only access to payment activity, subscriptions, and receivables.",
      )
      .closest("div.rounded-2xl");
    expect(stripeCard).not.toBeNull();
    expect(within(stripeCard as HTMLElement).getByText("Connected")).toBeInTheDocument();
    expect(within(stripeCard as HTMLElement).getByText(/Acme Payments · Test mode/)).toBeVisible();
    expect(within(stripeCard as HTMLElement).queryByRole("link", { name: "Connect" })).toBeNull();
    expect(within(stripeCard as HTMLElement).getByRole("link", { name: "Manage" })).toHaveAttribute(
      "href",
      "/settings/stripe",
    );
  });
});
