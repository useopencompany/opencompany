import "@testing-library/jest-dom/vitest";
import type { PluginImportPreviewDto, PluginInstallationDto } from "@opencompany/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationAccountView } from "@/lib/integration-state";
import {
  type LinearAccountsState,
  LinearPluginDetailView,
  type PluginToolsState,
  uncuratedPluginToolGroups,
} from "./LinearPluginSettings";
import { LINEAR_PLUGIN_SOURCE } from "./PluginSettings";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const commands = vi.hoisted(() => ({
  approveHeadlessPluginMcp: vi.fn(),
  archiveHeadlessPlugin: vi.fn(async () => undefined),
  deleteHeadlessPluginData: vi.fn(),
  disableHeadlessPlugin: vi.fn(),
  enableHeadlessPlugin: vi.fn(),
  importHeadlessPlugin: vi.fn(),
  previewHeadlessPluginImport: vi.fn(),
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

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/headless-knowledge-commands", () => commands);
vi.mock("@/lib/integration-account-actions", () => accountActions);

const plugin = {
  id: "plugin_linear",
  name: "linear",
  status: "enabled",
  manifest: { name: "Linear", description: "Plan and ship work with Linear." },
  source: {
    type: "github",
    url: "https://github.com/useopencompany/opencompany-experimental",
    ref: "feat/plugins-v2",
    path: "plugins/linear",
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

const toolAccount = account("gint_linear_tools", "Linear tool access", {
  read: "on",
  write: "ask",
});
const ingestAccount = account("gint_linear_ingest", "Acme", {});

const accountsState: LinearAccountsState = {
  status: "ready",
  accounts: [
    { purpose: "Tools", account: toolAccount },
    { purpose: "Ingestion", account: ingestAccount },
  ],
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
};

describe("Linear plugin settings", () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
    for (const command of Object.values(commands)) command.mockReset();
    commands.archiveHeadlessPlugin.mockResolvedValue(undefined);
    accountActions.disconnectIntegrationAccountAction.mockClear();
    accountActions.getIntegrationAccountUsageAction.mockClear();
    accountActions.setIntegrationCapabilityModeAction.mockReset();
    accountActions.setIntegrationCapabilityModeAction.mockResolvedValue({ ok: true });
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
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Search issues")).toBeInTheDocument();
    expect(screen.getByText("linear-triage")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(40))).toBeInTheDocument();
    expect(screen.getByText(`sha256:${"b".repeat(64)}`)).toBeInTheDocument();
    expect(screen.queryByText("read write")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view source/i })).toHaveAttribute(
      "href",
      `https://github.com/useopencompany/opencompany-experimental/tree/${"a".repeat(40)}/plugins/linear`,
    );

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
    expect(within(dialog).getByText(/ongoing ingestion will not be changed/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));

    await waitFor(() => expect(commands.archiveHeadlessPlugin).toHaveBeenCalledWith("linear"));
    expect(accountActions.disconnectIntegrationAccountAction).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("keeps existing accounts visible while the plugin is uninstalled", () => {
    render(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin: null }}
        accountsState={accountsState}
        toolsState={toolsState}
        canEdit
      />,
    );

    expect(screen.getByText("Linear tool access")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Install Linear to make its tools available.")).toBeInTheDocument();
    expect(screen.getByText("Install Linear to add its skills.")).toBeInTheDocument();
  });

  it("installs only after previewing the expected source commit and integrity", async () => {
    const preview = pluginPreview();
    commands.previewHeadlessPluginImport.mockResolvedValue(preview);
    commands.importHeadlessPlugin.mockResolvedValue({ plugin });
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

    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    const source = screen.getByDisplayValue(LINEAR_PLUGIN_SOURCE);
    expect(source).toHaveAttribute("readonly");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() =>
      expect(commands.previewHeadlessPluginImport).toHaveBeenCalledWith({
        url: LINEAR_PLUGIN_SOURCE,
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Install plugin" }));
    await waitFor(() =>
      expect(commands.importHeadlessPlugin).toHaveBeenCalledWith({
        url: LINEAR_PLUGIN_SOURCE,
        expectedResolvedCommit: preview.source.resolvedCommit,
        expectedIntegrity: preview.integrity,
      }),
    );
  });

  it("renders loading, error, and empty states for each section", () => {
    const { rerender } = render(
      <LinearPluginDetailView
        pluginState={{ status: "loading" }}
        accountsState={{ status: "loading" }}
        toolsState={{ status: "loading" }}
        canEdit
      />,
    );
    expect(screen.getByLabelText("Loading Linear plugin")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading Linear accounts")).toBeInTheDocument();
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
    expect(screen.getByText("Accounts unavailable")).toBeInTheDocument();
    expect(screen.getByText("Tools unavailable")).toBeInTheDocument();
    expect(screen.getByText("Skills unavailable")).toBeInTheDocument();

    rerender(
      <LinearPluginDetailView
        pluginState={{ status: "ready", plugin: null }}
        accountsState={{ status: "ready", accounts: [], permissionConnection: null }}
        toolsState={{ status: "ready", groups: [] }}
        canEdit
      />,
    );
    expect(screen.getByText("No Linear accounts are connected.")).toBeInTheDocument();
    expect(screen.getByText("Install Linear to make its tools available.")).toBeInTheDocument();
    expect(screen.getByText("Install Linear to add its skills.")).toBeInTheDocument();
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
): IntegrationAccountView {
  return {
    integrationId,
    provider: "linear",
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

function pluginPreview(): PluginImportPreviewDto {
  return {
    manifest: plugin.manifest,
    source: plugin.source,
    integrity: plugin.integrity,
    files: [{ path: "plugin.json", sizeBytes: 128 }],
    fileCount: 1,
    totalBytes: 128,
    skills: [],
    stdioServers: [],
    report: {
      ignoredManifestFields: [],
      skills: [],
      mcp: { status: "absent" },
    },
  };
}
