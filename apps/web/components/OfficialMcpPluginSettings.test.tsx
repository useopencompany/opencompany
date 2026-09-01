import "@testing-library/jest-dom/vitest";
import type {
  PluginImportPreviewDto,
  PluginInstallationDto,
  PluginRemoteMcpServerDto,
} from "@opencompany/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationAccountView } from "@/lib/integration-state";
import {
  type LinearAccountsState,
  LinearPluginDetail,
  LinearPluginDetailView,
  linearToolsStateFromPlugin,
  NeonPluginDetailView,
  neonToolsStateFromPlugin,
  type PluginToolsState,
  uncuratedPluginToolGroups,
} from "./OfficialMcpPluginSettings";
import { LINEAR_PLUGIN_SOURCE, NEON_PLUGIN_SOURCE } from "./PluginSettings";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const commands = vi.hoisted(() => ({
  approveHeadlessPluginMcp: vi.fn(),
  archiveHeadlessPlugin: vi.fn(async () => undefined),
  deleteHeadlessPluginData: vi.fn(),
  disableHeadlessPlugin: vi.fn(),
  enableHeadlessPlugin: vi.fn(),
  importHeadlessPlugin: vi.fn(),
  previewHeadlessPluginImport: vi.fn(),
  refreshHeadlessPluginMcp: vi.fn(),
  revokeHeadlessPluginMcp: vi.fn(),
}));
const accountActions = vi.hoisted(() => ({
  disconnectIntegrationAccountAction: vi.fn(async () => ({ ok: true as const })),
  getIntegrationAccountUsageAction: vi.fn(async () => ({
    ok: true as const,
    affectedBrainSourceCount: 0,
  })),
  setIntegrationCapabilityModeAction: vi.fn(async () => ({ ok: true as const })),
}));
const appData = vi.hoisted(() => ({
  integrations: {
    linear: {
      connected: true,
      status: "connected",
      statusReason: null,
      accountName: "Linear tool access",
      integrationId: "gint_linear_tools",
      capabilityModes: { read: "on", write: "ask" },
    },
    personalAccounts: { linear: [], neon: [] },
  },
}));
const useLiveQuery = vi.hoisted(() => vi.fn(() => ({ data: [], isLoading: false })));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@opencompany/ui/components/sonner", () => ({ toast: toasts }));
vi.mock("@tanstack/react-db", () => ({ useLiveQuery }));
vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => appData,
  useAppDataOptional: () => null,
}));
vi.mock("@/lib/headless-knowledge-commands", () => commands);
vi.mock("@/lib/integration-account-actions", () => accountActions);

const plugin = {
  id: "plugin_linear",
  name: "linear",
  status: "enabled",
  manifest: { name: "Linear", description: "Plan and ship work with Linear." },
  source: {
    type: "github",
    url: "https://github.com/useopencompany/plugins",
    ref: "a".repeat(40),
    path: "linear",
    resolvedCommit: "a".repeat(40),
  },
  integrity: `sha256:${"b".repeat(64)}`,
  files: [{ path: "plugin.json", executable: false, sizeBytes: 128 }],
  skills: [
    {
      name: "linear-triage",
      path: "skills/linear-triage",
      bundleId: "bundle_linear_triage",
      integrity: `sha256:${"c".repeat(64)}`,
      description: "Triage a Linear backlog.",
    },
  ],
  stdioServers: [],
  remoteMcpServers: [
    {
      name: "linear",
      type: "streamable-http",
      connectionProvider: "linear",
      capabilities: [
        { id: "read", label: "Read Linear", defaultMode: "on", tools: ["list_issues"] },
        { id: "write", label: "Manage issues", defaultMode: "ask", tools: ["save_issue"] },
      ],
      tools: [
        {
          name: "list_issues",
          description: "Find issues in the connected workspace.",
          classification: {
            capabilityId: "read",
            capabilityLabel: "Read Linear",
            defaultMode: "on",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "save_issue",
          classification: {
            capabilityId: "write",
            capabilityLabel: "Manage issues",
            defaultMode: "ask",
            bucket: "write",
            curated: true,
          },
        },
      ],
      discoveryStatus: "ready",
      discoveredAt: "2026-08-26T12:00:00.000Z",
      refreshAfter: "2026-08-26T13:00:00.000Z",
      lastDiscoveryError: null,
    },
  ],
  installReport: {
    ignoredManifestFields: [],
    skills: [],
    mcp: { status: "absent" },
    collisions: [],
  },
  mcpApprovedIntegrity: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
  archivedAt: null,
} as const satisfies PluginInstallationDto;

const officialPreview = {
  manifest: plugin.manifest,
  source: plugin.source,
  integrity: plugin.integrity,
  files: [{ path: "plugin.json", sizeBytes: 128 }],
  fileCount: 1,
  totalBytes: 128,
  skills: [
    {
      path: "skills/linear-triage",
      name: "linear-triage",
      description: "Triage a Linear backlog.",
      integrity: `sha256:${"c".repeat(64)}`,
      fileCount: 1,
      totalBytes: 64,
    },
  ],
  stdioServers: [],
  remoteMcpServers: plugin.remoteMcpServers.map(
    ({ name, type, connectionProvider, capabilities }: PluginRemoteMcpServerDto) => ({
      name,
      type,
      connectionProvider,
      capabilities,
    }),
  ),
  report: {
    ignoredManifestFields: [],
    skills: [],
    mcp: { status: "absent" },
  },
} as const satisfies PluginImportPreviewDto;

const emptyOfficialPreview = {
  ...officialPreview,
  skills: [],
  remoteMcpServers: [],
} as const satisfies PluginImportPreviewDto;

const toolAccount = account("gint_linear_tools", "Linear tool access", {
  read: "on",
  write: "ask",
});
const ingestAccount = account("gint_linear_ingest", "Acme", {});

const accountsState: LinearAccountsState = {
  status: "ready",
  accounts: [{ account: toolAccount }, { account: ingestAccount }],
  permissionConnection: toolAccount,
};

const toolsState: PluginToolsState = {
  status: "ready",
  groups: [
    {
      id: "read",
      label: "Read Linear",
      description: "Look up Linear work.",
      modeKey: "read",
      defaultMode: "on",
      curated: true,
      tools: [
        {
          id: "linear_search_issues",
          name: "Search issues",
          description: "Find issues in the connected workspace.",
          readOnly: true,
        },
      ],
    },
    {
      id: "write",
      label: "Manage issues",
      description: "Create and update Linear work.",
      modeKey: "write",
      defaultMode: "ask",
      curated: true,
      tools: [
        {
          id: "linear_create_issue",
          name: "Create issue",
          description: null,
          readOnly: false,
        },
      ],
    },
  ],
  discovery: {
    status: "ready",
    toolCount: 2,
    discoveredAt: "2026-08-26T12:00:00.000Z",
    refreshAfter: "2026-08-26T13:00:00.000Z",
    lastDiscoveryError: null,
  },
};

const neonAccount = account("gint_neon_tools", "Neon", { read: "on", query: "ask" }, "neon");
const neonPlugin = {
  ...plugin,
  id: "plugin_neon",
  name: "neon",
  manifest: {
    name: "neon",
    description: "Inspect Neon projects and run permission-gated read-only SQL.",
  },
  source: { ...plugin.source, path: "neon" },
  skills: [],
  remoteMcpServers: [
    {
      name: "neon",
      type: "streamable-http",
      connectionProvider: "neon",
      capabilities: [
        {
          id: "read",
          label: "Inspect Neon structure",
          defaultMode: "on",
          tools: ["list_projects"],
        },
        {
          id: "query",
          label: "Query database data",
          defaultMode: "ask",
          tools: ["run_sql"],
        },
      ],
      tools: [
        {
          name: "list_projects",
          description: "List Neon projects.",
          classification: {
            capabilityId: "read",
            capabilityLabel: "Inspect Neon structure",
            defaultMode: "on",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "run_sql",
          description: "Run provider-enforced read-only SQL.",
          classification: {
            capabilityId: "query",
            capabilityLabel: "Query database data",
            defaultMode: "ask",
            bucket: "read",
            curated: true,
          },
        },
      ],
      discoveryStatus: "ready",
      discoveredAt: "2026-08-26T12:00:00.000Z",
      refreshAfter: "2026-08-26T13:00:00.000Z",
      lastDiscoveryError: null,
    },
  ],
} as const satisfies PluginInstallationDto;

describe("Linear plugin settings", () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
    for (const command of Object.values(commands)) command.mockReset();
    commands.archiveHeadlessPlugin.mockResolvedValue(undefined);
    commands.enableHeadlessPlugin.mockResolvedValue(undefined);
    commands.importHeadlessPlugin.mockResolvedValue({ plugin, replayed: false });
    commands.previewHeadlessPluginImport.mockResolvedValue(officialPreview);
    commands.refreshHeadlessPluginMcp.mockResolvedValue(plugin);
    toasts.error.mockReset();
    toasts.success.mockReset();
    accountActions.disconnectIntegrationAccountAction.mockClear();
    accountActions.getIntegrationAccountUsageAction.mockClear();
    accountActions.setIntegrationCapabilityModeAction.mockReset();
    accountActions.setIntegrationCapabilityModeAction.mockResolvedValue({ ok: true });
    useLiveQuery.mockClear();
    window.history.replaceState({}, "", "/settings/plugins/linear");
  });

  it("server-renders account data without starting another live query", () => {
    const html = renderToString(
      <LinearPluginDetail
        pluginState={{ status: "ready", plugin }}
        toolsState={toolsState}
        canEdit
      />,
    );

    expect(html).toContain("Linear tool access");
    expect(useLiveQuery).not.toHaveBeenCalled();
  });

  it("shows provenance, accounts, discovered tools, and read-only skills", async () => {
    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin }}
        accountsState={accountsState}
        toolsState={toolsState}
        canEdit
      />,
    );

    expect(screen.getByRole("heading", { name: "Accounts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Skills" })).toBeInTheDocument();
    expect(screen.queryByText("gint_linear_tools")).not.toBeInTheDocument();
    expect(screen.getByText("Linear tool access")).toBeInTheDocument();
    expect(screen.queryByText("Acme")).not.toBeInTheDocument();
    expect(screen.getByText("Search issues")).toBeInTheDocument();
    expect(screen.getByText("linear-triage")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(40))).toBeInTheDocument();
    expect(screen.getByText(`sha256:${"b".repeat(64)}`)).toBeInTheDocument();
    expect(screen.queryByText("read write")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view source/i })).toHaveAttribute(
      "href",
      `https://github.com/useopencompany/plugins/tree/${"a".repeat(40)}/linear`,
    );
    const advancedDetails = screen.getByText("Advanced package details").closest("details");
    expect(advancedDetails).not.toHaveAttribute("open");
    for (const toolDetails of screen
      .getAllByText("1 tool")
      .map((item) => item.closest("details"))) {
      expect(toolDetails).not.toHaveAttribute("open");
    }

    const readModes = screen.getByRole("group", { name: "Read Linear permission" });
    await userEvent.click(within(readModes).getByRole("button", { name: "Ask" }));

    await waitFor(() =>
      expect(accountActions.setIntegrationCapabilityModeAction).toHaveBeenCalledWith(
        "gint_linear_tools",
        "read",
        "ask",
      ),
    );
  });

  it("uninstalls only the package and leaves account actions untouched", async () => {
    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin }}
        accountsState={accountsState}
        toolsState={toolsState}
        canEdit
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Uninstall Linear?" });
    expect(within(dialog).getByText(/Connected accounts will not be changed/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));

    await waitFor(() => expect(commands.archiveHeadlessPlugin).toHaveBeenCalledWith("linear"));
    expect(accountActions.disconnectIntegrationAccountAction).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("previews tools and skills while keeping accounts hidden before installation", async () => {
    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin: null }}
        accountsState={accountsState}
        toolsState={toolsState}
        canEdit
      />,
    );

    expect(screen.queryByRole("heading", { name: "Accounts" })).not.toBeInTheDocument();
    expect(screen.queryByText("Linear tool access")).not.toBeInTheDocument();
    expect(await screen.findByText("linear-triage")).toBeInTheDocument();
    expect(screen.getByText("Read Linear")).toBeInTheDocument();
    expect(screen.getByText("Manage issues")).toBeInTheDocument();
    expect(screen.queryByText("Add ingestion account")).not.toBeInTheDocument();
  });

  it("installs the pinned official package without an intermediate dialog", async () => {
    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin: null }}
        accountsState={{
          status: "ready",
          accounts: [],
          permissionConnection: null,
        }}
        toolsState={toolsState}
        canEdit
      />,
    );

    expect(await screen.findByText("linear-triage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeEnabled();
    expect(LINEAR_PLUGIN_SOURCE).toContain("/useopencompany/plugins/tree/");
    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(commands.importHeadlessPlugin).toHaveBeenCalledTimes(1));
    expect(commands.previewHeadlessPluginImport).toHaveBeenCalledWith({
      url: LINEAR_PLUGIN_SOURCE,
    });
    expect(commands.importHeadlessPlugin).toHaveBeenCalledWith({
      url: LINEAR_PLUGIN_SOURCE,
      expectedResolvedCommit: officialPreview.source.resolvedCommit,
      expectedIntegrity: officialPreview.integrity,
    });
    expect(router.refresh).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("refreshes discovery manually and reloads the server snapshot", async () => {
    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin }}
        accountsState={accountsState}
        toolsState={toolsState}
        canEdit
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(commands.refreshHeadlessPluginMcp).toHaveBeenCalledWith("linear"));
    expect(toasts.success).toHaveBeenCalledWith("Linear tools refreshed.");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("presents a missing tool account as a neutral connection-required state", () => {
    const connectionRequiredPlugin = {
      ...plugin,
      remoteMcpServers: plugin.remoteMcpServers.map((server: PluginRemoteMcpServerDto) => ({
        ...server,
        tools: [],
        discoveryStatus: "error" as const,
        lastDiscoveryError: "No usable provider connection was available for MCP discovery.",
      })),
    } satisfies PluginInstallationDto;

    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin: connectionRequiredPlugin }}
        accountsState={{ status: "ready", accounts: [], permissionConnection: null }}
        toolsState={linearToolsStateFromPlugin(connectionRequiredPlugin)}
        canEdit
      />,
    );

    expect(screen.getByText("Needs account")).toBeVisible();
    expect(
      screen.getAllByText("Connect a Linear account to activate tools.").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Discovery refresh failed")).not.toBeInTheDocument();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Connect Linear account" })).toHaveAttribute(
      "href",
      "/api/integrations/linear/start?returnTo=/settings/plugins/linear",
    );
  });

  it("maps the persisted discovery snapshot and surfaces a stale refresh error", () => {
    const stalePlugin = {
      ...plugin,
      remoteMcpServers: plugin.remoteMcpServers.map((server: PluginRemoteMcpServerDto) => ({
        ...server,
        discoveryStatus: "stale" as const,
        lastDiscoveryError: "Linear MCP returned 503.",
      })),
    } satisfies PluginInstallationDto;
    const state = linearToolsStateFromPlugin(stalePlugin);
    expect(state).toMatchObject({
      status: "ready",
      discovery: {
        status: "stale",
        toolCount: 2,
        lastDiscoveryError: "Linear MCP returned 503.",
      },
      groups: [
        { id: "read", tools: [{ id: "linear:list_issues", name: "List issues" }] },
        { id: "write", tools: [{ id: "linear:save_issue", name: "Save issue" }] },
      ],
    });

    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin: stalePlugin }}
        accountsState={accountsState}
        toolsState={state}
        canEdit
      />,
    );
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText(/Linear MCP returned 503\./u)).toBeInTheDocument();
    expect(screen.getByText(/last successful tool snapshot remains available/i)).toBeVisible();
  });

  it("can re-enable a disabled installation", async () => {
    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin: { ...plugin, status: "disabled" } }}
        accountsState={accountsState}
        toolsState={toolsState}
        canEdit
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Enable" }));

    await waitFor(() => expect(commands.enableHeadlessPlugin).toHaveBeenCalledWith("linear"));
    expect(router.refresh).toHaveBeenCalled();
  });

  it.each([
    { query: "integration=linear&setup=connected", toast: "success" as const },
    { query: "integration=linear&setup=error&reason=oauth_failed", toast: "error" as const },
  ])("surfaces and clears OAuth return status: $toast", async ({ query, toast }) => {
    window.history.replaceState({}, "", `/settings/plugins/linear?${query}`);

    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin }}
        accountsState={accountsState}
        toolsState={toolsState}
        canEdit
      />,
    );

    await waitFor(() => expect(toasts[toast]).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/settings/plugins/linear");
    expect(window.location.search).toBe("");
  });

  it("renders loading, error, and empty states for each installed-package section", async () => {
    const { rerender } = render(
      <LinearPluginDetailView
        pluginState={{ status: "loading" }}
        accountsState={{ status: "loading" }}
        toolsState={{ status: "loading" }}
        canEdit
      />,
    );
    expect(screen.getByLabelText("Loading Linear plugin")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Accounts" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loading Linear tools")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading Linear skills")).toBeInTheDocument();

    rerender(
      <LinearPluginDetailView
        pluginState={{ status: "error", message: "Plugin failed." }}
        accountsState={{ status: "error", message: "Accounts failed." }}
        toolsState={{ status: "error", message: "Tools failed." }}
        canEdit
      />,
    );
    expect(screen.getByText("Plugin details unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Accounts unavailable")).not.toBeInTheDocument();
    expect(screen.getByText("Tools unavailable")).toBeInTheDocument();
    expect(screen.getByText("Skills unavailable")).toBeInTheDocument();

    commands.previewHeadlessPluginImport.mockResolvedValue(emptyOfficialPreview);
    rerender(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin: null }}
        accountsState={{ status: "ready", accounts: [], permissionConnection: null }}
        toolsState={{
          status: "ready",
          groups: [],
          discovery: {
            status: "pending",
            toolCount: 0,
            discoveredAt: null,
            refreshAfter: null,
            lastDiscoveryError: null,
          },
        }}
        canEdit
      />,
    );
    expect(screen.queryByRole("heading", { name: "Accounts" })).not.toBeInTheDocument();
    expect(await screen.findByText(/No tools have been discovered yet\./u)).toBeInTheDocument();
    expect(screen.getByText("This version of the plugin contains no skills.")).toBeInTheDocument();
  });

  it("presents Neon through the same package, account, discovery, and query-permission flow", async () => {
    const state = neonToolsStateFromPlugin(neonPlugin);
    const neonAccountsState = {
      status: "ready" as const,
      accounts: [{ account: neonAccount }],
      permissionConnection: neonAccount,
    };

    render(
      <NeonPluginDetailView
        pluginState={{ status: "ready", plugin: neonPlugin }}
        accountsState={neonAccountsState}
        toolsState={state}
        canEdit
      />,
    );

    expect(screen.getByRole("heading", { name: "Neon" })).toBeInTheDocument();
    expect(screen.getByText("List projects")).toBeInTheDocument();
    expect(screen.getByText("Run sql")).toBeInTheDocument();
    expect(screen.getByText("This version of the plugin contains no skills.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Neon account" })).toHaveAttribute(
      "href",
      "/api/integrations/neon/start?returnTo=/settings/plugins/neon",
    );
    expect(screen.queryByText(/Configure Neon ingestion/u)).not.toBeInTheDocument();
    expect(NEON_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/neon$/u,
    );
    expect(state).toMatchObject({
      status: "ready",
      groups: [
        { id: "read", tools: [{ name: "List projects", readOnly: true }] },
        { id: "query", tools: [{ name: "Run sql", readOnly: true }] },
      ],
    });

    const queryModes = screen.getByRole("group", { name: "Query database data permission" });
    await userEvent.click(within(queryModes).getByRole("button", { name: "On" }));
    await waitFor(() =>
      expect(accountActions.setIntegrationCapabilityModeAction).toHaveBeenCalledWith(
        "gint_neon_tools",
        "query",
        "on",
      ),
    );
  });

  it("builds the two-bucket advanced fallback with ask defaults", () => {
    const groups = uncuratedPluginToolGroups([
      { id: "search", name: "Search", description: null, readOnly: true },
      { id: "mutate", name: "Mutate", description: null, readOnly: false },
    ]);

    expect(groups).toMatchObject([
      { label: "Read tools", defaultMode: "ask", curated: false, tools: [{ id: "search" }] },
      {
        label: "Write & other tools",
        defaultMode: "ask",
        curated: false,
        tools: [{ id: "mutate" }],
      },
    ]);
  });
});

function account(
  integrationId: string,
  connectionLabel: string,
  capabilityModes: Record<string, unknown>,
  provider: IntegrationAccountView["provider"] = "linear",
): IntegrationAccountView {
  return {
    integrationId,
    provider,
    status: "connected",
    connected: true,
    accountEmail: null,
    accountName: null,
    connectionLabel,
    statusReason: null,
    scopes: [],
    capabilityModes,
  };
}
