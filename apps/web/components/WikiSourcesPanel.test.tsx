import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WikiSourcesPanel } from "./WikiSourcesPanel";

const mocks = vi.hoisted(() => ({
  integrations: [] as Array<Record<string, unknown>>,
  integrationsLoading: false,
  initialIntegrations: null as Record<string, unknown> | null,
  useLiveQuery: vi.fn(),
  listWikiSources: vi.fn(),
  setWikiSourceEnabled: vi.fn(),
  upsertWikiSource: vi.fn(),
  listGitHubRepositories: vi.fn(),
  listLinearTeams: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: mocks.useLiveQuery,
}));

vi.mock("@/components/AppDataProvider", () => ({
  useAppDataOptional: () =>
    mocks.initialIntegrations ? { integrations: mocks.initialIntegrations } : null,
}));

vi.mock("@/components/WikiIngestActivityFeed", () => ({
  WikiIngestActivityFeed: () => <section>Recent ingestion activity</section>,
  WikiIngestActivitySkeleton: () => <section>Loading Wiki ingestion activity</section>,
}));

vi.mock("@/components/GranolaIntegrationSetup", () => ({
  GranolaIntegrationSetup: () => <div>Granola setup form</div>,
}));

vi.mock("@/lib/headless-integration-collections", () => ({
  getHeadlessIntegrationAccounts: () => ({ id: "integration-accounts" }),
}));

vi.mock("@/lib/wiki-source-api", () => ({
  listWikiSources: mocks.listWikiSources,
  setWikiSourceEnabled: mocks.setWikiSourceEnabled,
  upsertWikiSource: mocks.upsertWikiSource,
}));

vi.mock("@/lib/brain-source-actions", () => ({
  listGitHubRepositoriesAction: mocks.listGitHubRepositories,
  listLinearTeamsAction: mocks.listLinearTeams,
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

describe("WikiSourcesPanel", () => {
  beforeEach(() => {
    mocks.integrations = [];
    mocks.integrationsLoading = false;
    mocks.initialIntegrations = null;
    mocks.useLiveQuery.mockReset();
    mocks.useLiveQuery.mockImplementation(() => ({
      data: mocks.integrations,
      isLoading: mocks.integrationsLoading,
    }));
    mocks.listWikiSources.mockReset();
    mocks.listWikiSources.mockResolvedValue([]);
    mocks.setWikiSourceEnabled.mockReset();
    mocks.upsertWikiSource.mockReset();
    mocks.listGitHubRepositories.mockReset();
    mocks.listLinearTeams.mockReset();
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
  });

  it("renders a not-connected state with the existing provider connect flow", async () => {
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    const connect = await screen.findByRole("link", { name: "Connect Gmail" });
    expect(connect).toHaveAttribute("href", "/api/integrations/gmail/start?returnTo=/wiki/sources");
    expect(screen.getByText("No sources are feeding yet")).toBeInTheDocument();
    expect(screen.getAllByText("Not connected")).toHaveLength(4);
  });

  it("keeps OAuth connections in onboarding and ships no dead scope placeholder", async () => {
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin mode="onboarding" />);

    expect(await screen.findByText("Connect your sources")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Connect Gmail" })).toHaveAttribute(
      "href",
      "/api/integrations/gmail/start?returnTo=%2Fonboarding%2Fconnected",
    );
    expect(screen.queryByText("Scope configuration coming soon")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent ingestion activity")).not.toBeInTheDocument();
  });

  it("does not start the live integration collection during server rendering", () => {
    const html = renderToString(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    expect(html).toContain("Loading Wiki sources");
    expect(mocks.useLiveQuery).not.toHaveBeenCalled();
  });

  it("turns a connected scoped provider into a Wiki source through the direct API", async () => {
    mocks.integrations = [integration({ provider: "gmail", accountEmail: "ada@example.com" })];
    mocks.upsertWikiSource.mockResolvedValue(source());
    const user = userEvent.setup();
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    const toggle = await screen.findByRole("switch", {
      name: "Enable Gmail source ada@example.com",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("button", { name: "Choose events and instructions" }),
    ).toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() =>
      expect(mocks.upsertWikiSource).toHaveBeenCalledWith({
        integrationId: "integration_1",
        provider: "gmail",
        enabled: true,
      }),
    );
    expect(await screen.findByText("Feeding")).toBeInTheDocument();
  });

  it("saves Gmail event scope and instructions through the Wiki sources API", async () => {
    mocks.integrations = [integration({ provider: "gmail", accountEmail: "ada@example.com" })];
    mocks.listWikiSources.mockResolvedValue([
      source({
        config: {
          events: [{ id: "email_received" }],
          instructions: "Only customer mail.",
        },
      }),
    ]);
    mocks.upsertWikiSource.mockResolvedValue(
      source({
        config: {
          events: [{ id: "email_received" }, { id: "email_sent" }],
          instructions: "Only customer commitments.",
        },
      }),
    );
    const user = userEvent.setup();
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    await user.click(await screen.findByRole("button", { name: "Choose events and instructions" }));
    await user.click(screen.getByRole("checkbox", { name: "Email sent" }));
    const instructions = screen.getByLabelText("Ingestion instructions (optional)");
    await user.clear(instructions);
    await user.type(instructions, "Only customer commitments.");
    await user.click(screen.getByRole("button", { name: "Save Gmail source" }));

    await waitFor(() =>
      expect(mocks.upsertWikiSource).toHaveBeenCalledWith({
        integrationId: "integration_1",
        provider: "gmail",
        enabled: true,
        config: {
          events: [{ id: "email_received" }, { id: "email_sent" }],
          instructions: "Only customer commitments.",
        },
      }),
    );
  });

  it("configures selected Linear teams and events through the Wiki sources API", async () => {
    mocks.integrations = [integration({ provider: "linear", accountName: "Acme" })];
    mocks.listLinearTeams.mockResolvedValue({
      ok: true,
      teams: [{ id: "team_1", name: "Core", key: "ENG" }],
      partial: false,
    });
    mocks.upsertWikiSource.mockResolvedValue(
      source({
        provider: "linear",
        accountName: "Acme",
        config: {
          teams: [{ id: "team_1", name: "Core", key: "ENG" }],
          events: [
            { id: "issue_created" },
            { id: "issue_updated" },
            { id: "issue_status_changed" },
            { id: "issue_removed" },
            { id: "comment_created" },
            { id: "comment_updated" },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    await user.click(await screen.findByRole("button", { name: "Choose teams and events" }));
    await user.click(await screen.findByRole("checkbox", { name: /Core/u }));
    await user.click(screen.getByRole("button", { name: "Save Linear source" }));

    await waitFor(() =>
      expect(mocks.upsertWikiSource).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationId: "integration_1",
          provider: "linear",
          enabled: true,
          config: expect.objectContaining({
            teams: [{ id: "team_1", name: "Core", key: "ENG" }],
          }),
        }),
      ),
    );
  });

  it("configures selected GitHub repositories through the Wiki sources API", async () => {
    mocks.integrations = [
      integration({ provider: "github", workspaceId: "workspace_1", accountName: "Acme" }),
    ];
    mocks.listGitHubRepositories.mockResolvedValue({
      ok: true,
      repos: [{ id: "4242", fullName: "acme/api", private: true }],
    });
    mocks.upsertWikiSource.mockResolvedValue(
      source({
        provider: "github",
        accountName: "Acme",
        ownerKind: "workspace",
        config: {
          repos: [{ id: "4242", fullName: "acme/api" }],
          events: [
            "pull_request_opened",
            "pull_request_merged",
            "pull_request_commented",
            "issue_opened",
            "issue_commented",
          ],
        },
      }),
    );
    const user = userEvent.setup();
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    await user.click(await screen.findByRole("button", { name: "Configure" }));
    await user.click(await screen.findByRole("checkbox", { name: /acme\/api/u }));
    await user.click(screen.getByRole("button", { name: "Save GitHub source" }));

    await waitFor(() =>
      expect(mocks.upsertWikiSource).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationId: "integration_1",
          provider: "github",
          enabled: true,
          config: expect.objectContaining({
            repos: [{ id: "4242", fullName: "acme/api" }],
          }),
        }),
      ),
    );
  });

  it("uses the server integration snapshot while the live read model loads", async () => {
    mocks.integrationsLoading = true;
    mocks.initialIntegrations = initialIntegrationState([
      integrationAccount({ provider: "gmail", accountEmail: "ada@example.com" }),
    ]);
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading Wiki sources")).not.toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Enable Gmail source ada@example.com" }),
    ).toBeEnabled();
  });

  it("auto-enables a newly connected meeting source", async () => {
    mocks.integrations = [integration({ provider: "granola", accountEmail: "ada@example.com" })];
    mocks.upsertWikiSource.mockResolvedValue(
      source({ provider: "granola", enabled: true, accountEmail: "ada@example.com" }),
    );
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    await waitFor(() =>
      expect(mocks.upsertWikiSource).toHaveBeenCalledWith({
        integrationId: "integration_1",
        provider: "granola",
        enabled: true,
      }),
    );
    expect(await screen.findByText("Feeding")).toBeInTheDocument();
  });

  it("keeps a deliberately paused meeting source disabled", async () => {
    mocks.integrations = [integration({ provider: "granola", accountEmail: "ada@example.com" })];
    mocks.listWikiSources.mockResolvedValue([
      source({ provider: "granola", enabled: false, accountEmail: "ada@example.com" }),
    ]);
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    const toggle = await screen.findByRole("switch", {
      name: "Enable Granola source ada@example.com",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(mocks.upsertWikiSource).not.toHaveBeenCalled());
  });

  it("uses the live integration status for an already configured source", async () => {
    mocks.integrations = [
      integration({
        provider: "gmail",
        accountEmail: "current@example.com",
        status: "needs_reauth",
      }),
    ];
    mocks.listWikiSources.mockResolvedValue([
      source({ enabled: true, accountEmail: "stale@example.com" }),
    ]);
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    expect(await screen.findByText("Needs reconnect")).toBeInTheDocument();
    expect(screen.getByText("current@example.com")).toBeInTheDocument();
    expect(screen.queryByText("stale@example.com")).not.toBeInTheDocument();
    expect(screen.getByText("No sources are feeding yet")).toBeInTheDocument();
  });

  it("offers reconnect instead of calling a disconnected source connected", async () => {
    mocks.listWikiSources.mockResolvedValue([
      source({ enabled: true, integrationStatus: "disconnected" }),
    ]);
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    expect(await screen.findByText("Needs reconnect")).toBeInTheDocument();
    expect(
      screen.getByText("This connection was removed. Reconnect it before feeding can resume."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconnect" })).toHaveAttribute(
      "href",
      "/api/integrations/gmail/start?returnTo=/wiki/sources",
    );
    expect(screen.queryByText("Connected · off")).not.toBeInTheDocument();
  });

  it("shows a recoverable loading error", async () => {
    mocks.listWikiSources.mockRejectedValue(new Error("API unavailable"));
    render(<WikiSourcesPanel workspaceId="workspace_1" isAdmin />);

    expect(await screen.findByText("Sources didn't load")).toBeInTheDocument();
    expect(screen.getByText("API unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading Wiki sources")).not.toBeInTheDocument();
  });
});

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: "integration_1",
    provider: "gmail",
    workspaceId: null,
    externalId: "external_1",
    connectionLabel: null,
    accountName: null,
    accountEmail: null,
    accountType: null,
    status: "connected",
    statusReason: null,
    scopes: [],
    capabilityModes: {},
    ...overrides,
  };
}

function integrationAccount(overrides: Record<string, unknown> = {}) {
  return {
    integrationId: "integration_1",
    provider: "gmail",
    status: "connected",
    connected: true,
    accountEmail: null,
    accountName: null,
    connectionLabel: null,
    statusReason: null,
    scopes: [],
    capabilityModes: {},
    ...overrides,
  };
}

function initialIntegrationState(gmail: Array<Record<string, unknown>>) {
  return {
    personalAccounts: { gmail, slack: [], linear: [], granola: [] },
    github: {
      provider: "github",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
    },
    jamie: {
      provider: "jamie",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
    },
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "gwscfg_1",
    provider: "gmail",
    integrationId: "integration_1",
    enabled: true,
    config: {},
    integrationStatus: "connected",
    accountName: null,
    accountEmail: "ada@example.com",
    connectionLabel: null,
    ownerName: "Ada Lovelace",
    ownerEmail: "ada@example.com",
    ownerAvatarUrl: null,
    ownerKind: "user",
    isOwn: true,
    canConfigure: true,
    canToggle: true,
    canDelete: true,
    ...overrides,
  };
}
