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
  setGoatIntegrationCapabilityModeAction: vi.fn(async () => ({ ok: true })),
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
        capabilityModes: {},
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
    const readPermission = within(linearCard as HTMLElement).getByRole("group", {
      name: "Read Linear permission",
    });
    const writePermission = within(linearCard as HTMLElement).getByRole("group", {
      name: "Manage issues permission",
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

  it("shows separate Gmail read, draft, and send controls with one scope-upgrade prompt", () => {
    const integrations = goatIntegrationStateFromRows([
      {
        id: "gint_gmail",
        provider: "gmail",
        externalId: "google_account_1",
        accountEmail: "louis@example.com",
        status: "connected",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        capabilityModes: {},
      },
    ]) as GoatIntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    const gmailCard = screen
      .getByText("Let Goat read and act on your email.")
      .closest("div.rounded-2xl");
    expect(gmailCard).not.toBeNull();
    const readPermission = within(gmailCard as HTMLElement).getByRole("group", {
      name: "Read emails permission",
    });
    const sendPermission = within(gmailCard as HTMLElement).getByRole("group", {
      name: "Send emails permission",
    });
    const draftPermission = within(gmailCard as HTMLElement).getByRole("group", {
      name: "Create drafts permission",
    });
    expect(within(readPermission).getByRole("button", { name: "On" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(draftPermission).getByRole("button", { name: "On" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(sendPermission).getByRole("button", { name: "Ask" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(gmailCard as HTMLElement).getByRole("link", { name: "Enable drafts & sending" }),
    ).toHaveAttribute("href", "/api/integrations/gmail/start?returnTo=/settings/integrations");
  });

  it("prompts send-enabled Gmail accounts only for draft access", () => {
    const integrations = goatIntegrationStateFromRows([
      {
        id: "gint_gmail",
        provider: "gmail",
        externalId: "google_account_1",
        accountEmail: "louis@example.com",
        status: "connected",
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
        ],
        capabilityModes: {},
      },
    ]) as GoatIntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    const gmailCard = screen
      .getByText("Let Goat read and act on your email.")
      .closest("div.rounded-2xl");
    expect(gmailCard).not.toBeNull();
    expect(
      within(gmailCard as HTMLElement).getByRole("link", { name: "Enable drafts" }),
    ).toHaveAttribute("href", "/api/integrations/gmail/start?returnTo=/settings/integrations");
    expect(
      within(gmailCard as HTMLElement).queryByRole("link", { name: "Enable drafts & sending" }),
    ).toBeNull();
  });

  it("shows Attio read and write permission controls on the connected workspace", () => {
    const integrations = goatIntegrationStateFromRows([
      {
        id: "gint_attio",
        provider: "attio",
        externalId: "attio_workspace_1",
        connectionLabel: "Acme CRM",
        status: "connected",
        capabilityModes: {},
      },
    ]) as GoatIntegrationState;

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

  it("shows Drive read and edit controls plus an OAuth upgrade when editing is unavailable", () => {
    const integrations = goatIntegrationStateFromRows([
      {
        id: "gint_drive",
        provider: "google_drive",
        externalId: "google_account_1",
        accountEmail: "founder@example.com",
        status: "connected",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        capabilityModes: {},
      },
    ]) as GoatIntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    const driveCard = screen
      .getByText("Sync files and folders you choose into Goat.")
      .closest("div.rounded-2xl");
    expect(driveCard).not.toBeNull();
    const readPermission = within(driveCard as HTMLElement).getByRole("group", {
      name: "Find & read files permission",
    });
    const writePermission = within(driveCard as HTMLElement).getByRole("group", {
      name: "Edit Google Docs permission",
    });
    expect(within(readPermission).getByRole("button", { name: "On" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(writePermission).getByRole("button", { name: "Ask" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(driveCard as HTMLElement).getByRole("link", { name: "Enable editing" }),
    ).toHaveAttribute(
      "href",
      "/api/integrations/google-drive/start?returnTo=/settings/integrations",
    );
  });

  it("shows one broad Slack read permission for each connected workspace", () => {
    const integrations = goatIntegrationStateFromRows([
      {
        id: "gint_slack",
        provider: "slack",
        externalId: "T123",
        connectionLabel: "Acme",
        accountName: "Louis",
        status: "connected",
        capabilityModes: {},
      },
    ]) as GoatIntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));

    const slackCard = screen
      .getByText("Let Goat search and read your Slack conversations.")
      .closest("div.rounded-2xl");
    expect(slackCard).not.toBeNull();
    const readPermission = within(slackCard as HTMLElement).getByRole("group", {
      name: "Read Slack permission",
    });
    expect(within(readPermission).getByRole("button", { name: "On" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(slackCard as HTMLElement).queryByRole("group", {
        name: /write|send/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("shows a workspace-owned Stripe connection and test-mode label", () => {
    const integrations = goatIntegrationStateFromRows([
      {
        id: "gint_stripe",
        workspaceId: "workspace_1",
        provider: "stripe",
        externalId: "acct_123",
        connectionLabel: "Acme Payments",
        accountType: "stripe_test_restricted_key",
        status: "connected",
      },
    ]) as GoatIntegrationState;

    render(<SettingsIntegrationsPanel initialIntegrations={integrations} isWorkspaceAdmin />);

    const stripeCard = screen
      .getByText("Give Goat read-only access to payment activity, subscriptions, and receivables.")
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
