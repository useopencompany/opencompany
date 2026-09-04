import "@testing-library/jest-dom/vitest";
import type {
  PluginImportPreviewDto,
  PluginInstallationDto,
  PluginRemoteMcpServerDto,
} from "@opencompany/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationAccountView } from "@/lib/integration-state";
import {
  BetterStackPluginDetailView,
  betterStackToolsStateFromPlugin,
  defaultPostHogToolsState,
  defaultSigNozToolsState,
  GitHubPluginDetail,
  GitHubPluginDetailView,
  GmailPluginDetail,
  GmailPluginDetailView,
  GoogleCalendarPluginDetail,
  GoogleDrivePluginDetail,
  githubToolsStateFromPlugin,
  gmailToolsStateFromPlugin,
  googleCalendarToolsStateFromPlugin,
  googleDriveToolsStateFromPlugin,
  type LinearAccountsState,
  LinearPluginDetail,
  LinearPluginDetailView,
  linearToolsStateFromPlugin,
  NeonPluginDetailView,
  neonToolsStateFromPlugin,
  type PluginToolsState,
  PostHogPluginDetail,
  SigNozPluginDetail,
  SlackPluginDetail,
  slackToolsStateFromPlugin,
  uncuratedPluginToolGroups,
  XPluginDetail,
} from "./OfficialMcpPluginSettings";
import {
  BETTERSTACK_PLUGIN_SOURCE,
  GITHUB_PLUGIN_SOURCE,
  GMAIL_PLUGIN_SOURCE,
  GOOGLE_CALENDAR_PLUGIN_SOURCE,
  GOOGLE_DRIVE_PLUGIN_SOURCE,
  LINEAR_PLUGIN_SOURCE,
  NEON_PLUGIN_SOURCE,
  POSTHOG_PLUGIN_SOURCE,
  SLACK_PLUGIN_SOURCE,
  X_PLUGIN_SOURCE,
} from "./PluginSettings";

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
    gmail: {
      connected: true,
      status: "connected",
      accountEmail: "ada@example.com",
      accountName: "Ada",
      integrationId: "gint_gmail",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      capabilityModes: { query: "ask", draft: "ask", write: "ask" },
    },
    linear: {
      connected: true,
      status: "connected",
      statusReason: null,
      accountName: "Linear tool access",
      integrationId: "gint_linear_tools",
      capabilityModes: { read: "on", write: "ask" },
    },
    posthog: {
      connected: true,
      status: "connected",
      statusReason: null,
      accountName: "Acme Analytics",
      integrationId: "gint_posthog_tools",
      capabilityModes: { read: "on", write: "ask" },
    },
    slack: {
      connected: true,
      status: "connected",
      statusReason: null,
      accountName: "Ada",
      teamName: "Acme",
      integrationId: "gint_slack",
    },
    google_calendar: {
      connected: true,
      status: "connected",
      accountEmail: "ada@example.com",
      accountName: "Ada",
      integrationId: "gint_google_calendar",
    },
    google_drive: {
      connected: true,
      status: "connected",
      integrationId: "gint_google_drive_latest",
      accountEmail: "founder@example.com",
      accountName: "Founder",
    },
    x_account: {
      connected: true,
      status: "connected",
      statusReason: null,
      accountName: "Founder",
      handle: "@founder",
      integrationId: "gint_x_latest",
    },
    personalAccounts: {
      betterstack: [],
      gmail: [
        {
          integrationId: "gint_gmail",
          provider: "gmail",
          status: "connected",
          connected: true,
          accountEmail: "ada@example.com",
          accountName: "Ada",
          connectionLabel: "ada@example.com",
          statusReason: null,
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
          capabilityModes: { query: "ask", draft: "ask", write: "ask" },
        },
      ],
      github_user: [
        {
          integrationId: "gint_github_user",
          provider: "github_user",
          status: "connected",
          connected: true,
          accountEmail: null,
          accountName: "octocat",
          connectionLabel: "octocat",
          statusReason: null,
          scopes: [],
          capabilityModes: { read: "on", write: "ask" },
        },
      ],
      google_calendar: [
        {
          integrationId: "gint_google_calendar",
          provider: "google_calendar",
          status: "connected",
          connected: true,
          accountEmail: "ada@example.com",
          accountName: "Ada",
          connectionLabel: null,
          statusReason: null,
          scopes: [
            "https://www.googleapis.com/auth/calendar.readonly",
            "https://www.googleapis.com/auth/calendar.events",
          ],
          capabilityModes: {},
        },
      ],
      google_drive: [
        {
          integrationId: "gint_google_drive_older",
          provider: "google_drive",
          status: "connected",
          connected: true,
          accountEmail: "older@example.com",
          accountName: "Older",
          connectionLabel: null,
          statusReason: null,
          scopes: [],
          capabilityModes: {},
        },
        {
          integrationId: "gint_google_drive_latest",
          provider: "google_drive",
          status: "connected",
          connected: true,
          accountEmail: "founder@example.com",
          accountName: "Founder",
          connectionLabel: null,
          statusReason: null,
          scopes: [],
          capabilityModes: { read: "ask", query: "ask", write: "ask" },
        },
      ],
      linear: [],
      neon: [],
      signoz: [
        {
          integrationId: "gint_signoz",
          provider: "signoz",
          status: "connected",
          connected: true,
          accountEmail: null,
          accountName: "SigNoz",
          connectionLabel: "SigNoz",
          statusReason: null,
          scopes: [],
          capabilityModes: { read: "on", query: "ask", write: "ask" },
        },
      ],
      slack: [
        {
          integrationId: "gint_slack",
          provider: "slack",
          status: "connected",
          connected: true,
          accountEmail: "ada@acme.example",
          accountName: "Ada",
          connectionLabel: "Acme",
          statusReason: null,
          scopes: ["channels:history", "chat:write"],
          capabilityModes: { read: "on", query: "ask", write: "ask" },
        },
        {
          integrationId: "gint_slack_archive",
          provider: "slack",
          status: "connected",
          connected: true,
          accountEmail: "ada@archive.example",
          accountName: "Ada",
          connectionLabel: "Archive Co",
          statusReason: null,
          scopes: ["channels:history"],
          capabilityModes: {},
        },
      ],
      x_account: [
        {
          integrationId: "gint_x_older",
          provider: "x_account",
          status: "connected",
          connected: true,
          accountEmail: null,
          accountName: "Acme",
          connectionLabel: "@acme",
          statusReason: null,
          scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
          capabilityModes: {},
        },
        {
          integrationId: "gint_x_latest",
          provider: "x_account",
          status: "connected",
          connected: true,
          accountEmail: null,
          accountName: "Founder",
          connectionLabel: "@founder",
          statusReason: null,
          scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
          capabilityModes: { read: "on", query: "ask", write: "ask" },
        },
      ],
    },
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

const betterStackAccount = account(
  "gint_betterstack_tools",
  "Better Stack tool access",
  { read: "on", query: "ask", write: "ask" },
  "betterstack",
);
const betterStackPlugin = {
  ...plugin,
  id: "plugin_betterstack",
  name: "betterstack",
  manifest: {
    name: "betterstack",
    description: "Investigate Better Stack observability data and manage operational resources.",
  },
  source: { ...plugin.source, path: "betterstack" },
  skills: [],
  remoteMcpServers: [
    {
      name: "betterstack",
      type: "streamable-http",
      connectionProvider: "betterstack",
      capabilities: [
        {
          id: "read",
          label: "Search Better Stack docs",
          defaultMode: "on",
          tools: ["documentation"],
        },
        {
          id: "query",
          label: "Inspect observability data",
          defaultMode: "ask",
          tools: ["query"],
        },
        {
          id: "write",
          label: "Manage Better Stack",
          defaultMode: "ask",
          tools: ["create_monitor"],
        },
      ],
      tools: [
        {
          name: "documentation",
          description: "Search Better Stack documentation.",
          classification: {
            capabilityId: "read",
            capabilityLabel: "Search Better Stack docs",
            defaultMode: "on",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "query",
          description: "Query Better Stack telemetry.",
          classification: {
            capabilityId: "query",
            capabilityLabel: "Inspect observability data",
            defaultMode: "ask",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "create_monitor",
          description: "Create a Better Stack monitor.",
          classification: {
            capabilityId: "write",
            capabilityLabel: "Manage Better Stack",
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
} as const satisfies PluginInstallationDto;

const githubAccount = {
  ...account("gint_github_user", "octocat", { read: "on", write: "ask" }, "github_user"),
  accountName: "octocat",
} satisfies IntegrationAccountView;
const githubPlugin = {
  ...plugin,
  id: "plugin_github",
  name: "github",
  manifest: {
    name: "github",
    description: "Work with repositories, issues, pull requests, and Actions as yourself.",
  },
  source: { ...plugin.source, path: "github" },
  skills: [],
  remoteMcpServers: [
    {
      name: "github",
      type: "streamable-http",
      connectionProvider: "github",
      capabilities: [
        {
          id: "read",
          label: "Read GitHub",
          defaultMode: "on",
          tools: ["search_repositories", "actions_list"],
        },
        {
          id: "write",
          label: "Manage GitHub",
          defaultMode: "ask",
          tools: ["merge_pull_request"],
        },
      ],
      tools: [
        {
          name: "search_repositories",
          description: "Search repositories accessible to the connected account.",
          classification: {
            capabilityId: "read",
            capabilityLabel: "Read GitHub",
            defaultMode: "on",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "actions_list",
          description: "List GitHub Actions workflows and runs.",
          classification: {
            capabilityId: "read",
            capabilityLabel: "Read GitHub",
            defaultMode: "on",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "merge_pull_request",
          description: "Merge a pull request.",
          classification: {
            capabilityId: "write",
            capabilityLabel: "Manage GitHub",
            defaultMode: "ask",
            bucket: "write",
            curated: true,
          },
        },
      ],
      discoveryStatus: "ready",
      discoveredAt: "2026-09-02T06:30:00.000Z",
      refreshAfter: "2026-09-02T07:30:00.000Z",
      lastDiscoveryError: null,
    },
  ],
} as const satisfies PluginInstallationDto;

const googleDrivePlugin = {
  ...plugin,
  id: "plugin_google_drive",
  name: "google-drive",
  manifest: {
    name: "google-drive",
    description: "Search, inspect, read, create, and copy files through Google Drive.",
  },
  source: {
    ...plugin.source,
    path: "google-drive",
    resolvedCommit: "dc0c91221bcfa9b6088a19277f875c438b37e96e",
  },
  skills: [],
  remoteMcpServers: [
    {
      name: "google-drive",
      type: "streamable-http",
      connectionProvider: "google-drive",
      capabilities: [
        {
          id: "read",
          label: "Browse Drive files",
          defaultMode: "ask",
          tools: ["get_file_metadata", "list_recent_files", "search_files"],
        },
        {
          id: "query",
          label: "Read files & permissions",
          defaultMode: "ask",
          tools: ["download_file_content", "get_file_permissions", "read_file_content"],
        },
        {
          id: "write",
          label: "Create & copy files",
          defaultMode: "ask",
          tools: ["copy_file", "create_file"],
        },
      ],
      tools: [
        driveTool("get_file_metadata", "read"),
        driveTool("list_recent_files", "read"),
        driveTool("search_files", "read"),
        driveTool("download_file_content", "query"),
        driveTool("get_file_permissions", "query"),
        driveTool("read_file_content", "query"),
        driveTool("copy_file", "write"),
        driveTool("create_file", "write"),
      ],
      discoveryStatus: "ready",
      discoveredAt: "2026-09-03T06:00:00.000Z",
      refreshAfter: "2026-09-03T07:00:00.000Z",
      lastDiscoveryError: null,
    },
  ],
} as const satisfies PluginInstallationDto;

function driveTool(name: string, capabilityId: "read" | "query" | "write") {
  const capabilityLabel = {
    read: "Browse Drive files",
    query: "Read files & permissions",
    write: "Create & copy files",
  }[capabilityId];
  return {
    name,
    description: `${name} from Google Drive.`,
    classification: {
      capabilityId,
      capabilityLabel,
      defaultMode: "ask" as const,
      bucket: capabilityId === "write" ? ("write" as const) : ("read" as const),
      curated: true,
    },
  };
}

const slackPlugin = {
  ...plugin,
  id: "plugin_slack",
  name: "slack",
  manifest: {
    name: "slack",
    description: "Search Slack and take permission-gated actions as yourself.",
  },
  source: {
    ...plugin.source,
    path: "slack",
    resolvedCommit: "1b912fe6c4f4497147887b2383f0181f763aa19b",
  },
  skills: [],
  remoteMcpServers: [
    {
      name: "slack",
      type: "streamable-http",
      connectionProvider: "slack",
      capabilities: [
        {
          id: "read",
          label: "Search public Slack",
          defaultMode: "on",
          tools: ["slack_search_public"],
        },
        {
          id: "query",
          label: "Read private Slack",
          defaultMode: "ask",
          tools: ["slack_read_channel"],
        },
        {
          id: "write",
          label: "Change Slack",
          defaultMode: "ask",
          tools: ["slack_send_message"],
        },
      ],
      tools: [
        {
          name: "slack_search_public",
          description: "Search public Slack conversations.",
          classification: {
            capabilityId: "read",
            capabilityLabel: "Search public Slack",
            defaultMode: "on",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "slack_read_channel",
          description: "Read a channel.",
          classification: {
            capabilityId: "query",
            capabilityLabel: "Read private Slack",
            defaultMode: "ask",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "slack_send_message",
          description: "Send a message.",
          classification: {
            capabilityId: "write",
            capabilityLabel: "Change Slack",
            defaultMode: "ask",
            bucket: "write",
            curated: true,
          },
        },
      ],
      discoveryStatus: "ready",
      discoveredAt: "2026-09-02T08:00:00.000Z",
      refreshAfter: "2026-09-02T09:00:00.000Z",
      lastDiscoveryError: null,
    },
  ],
} as const satisfies PluginInstallationDto;

const googleCalendarPlugin = {
  ...plugin,
  id: "plugin_google_calendar",
  name: "google-calendar",
  manifest: {
    name: "google-calendar",
    description: "Read and create Google Calendar events through opencompany's MCP server.",
  },
  source: {
    ...plugin.source,
    path: "google-calendar",
    resolvedCommit: "de04f0c11eeb4e4eb4ed1140818205e14b08401f",
  },
  skills: [],
  remoteMcpServers: [
    {
      name: "google-calendar",
      type: "streamable-http",
      connectionProvider: "google-calendar",
      capabilities: [
        {
          id: "read",
          label: "Check calendars",
          defaultMode: "ask",
          tools: ["list_calendars"],
        },
        {
          id: "query",
          label: "Read calendar events",
          defaultMode: "ask",
          tools: ["list_events", "get_event"],
        },
        {
          id: "write",
          label: "Manage calendar events",
          defaultMode: "ask",
          tools: ["create_event"],
        },
      ],
      tools: [
        {
          name: "list_calendars",
          description: "List calendars.",
          classification: {
            capabilityId: "read",
            capabilityLabel: "Check calendars",
            defaultMode: "ask",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "list_events",
          description: "List events.",
          classification: {
            capabilityId: "query",
            capabilityLabel: "Read calendar events",
            defaultMode: "ask",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "get_event",
          description: "Get an event.",
          classification: {
            capabilityId: "query",
            capabilityLabel: "Read calendar events",
            defaultMode: "ask",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "create_event",
          description: "Create an event.",
          classification: {
            capabilityId: "write",
            capabilityLabel: "Manage calendar events",
            defaultMode: "ask",
            bucket: "write",
            curated: true,
          },
        },
      ],
      discoveryStatus: "ready",
      discoveredAt: "2026-09-03T08:00:00.000Z",
      refreshAfter: "2026-09-03T09:00:00.000Z",
      lastDiscoveryError: null,
    },
  ],
} as const satisfies PluginInstallationDto;

const slackPreview = {
  ...officialPreview,
  manifest: slackPlugin.manifest,
  source: slackPlugin.source,
  integrity: slackPlugin.integrity,
  skills: [],
  remoteMcpServers: slackPlugin.remoteMcpServers.map(
    ({ name, type, connectionProvider, capabilities }: PluginRemoteMcpServerDto) => ({
      name,
      type,
      connectionProvider,
      capabilities,
    }),
  ),
} as const satisfies PluginImportPreviewDto;

const gmailPlugin = {
  ...plugin,
  id: "plugin_gmail",
  name: "gmail",
  manifest: {
    name: "gmail",
    description: "Search and read Gmail, create drafts, and organize messages.",
  },
  source: {
    ...plugin.source,
    path: "gmail",
    resolvedCommit: "587fb06ae2a4e4bed7532e216f8712979ca35e7b",
  },
  skills: [],
  remoteMcpServers: [
    {
      name: "gmail",
      type: "streamable-http",
      connectionProvider: "gmail",
      capabilities: [
        { id: "query", label: "Read Gmail", defaultMode: "ask", tools: ["get_message"] },
        { id: "draft", label: "Create drafts", defaultMode: "ask", tools: ["create_draft"] },
        { id: "write", label: "Organize Gmail", defaultMode: "ask", tools: ["trash_message"] },
      ],
      tools: [
        {
          name: "get_message",
          description: "Get a Gmail message.",
          classification: {
            capabilityId: "query",
            capabilityLabel: "Read Gmail",
            defaultMode: "ask",
            bucket: "read",
            curated: true,
          },
        },
        {
          name: "create_draft",
          description: "Create a Gmail draft.",
          classification: {
            capabilityId: "draft",
            capabilityLabel: "Create drafts",
            defaultMode: "ask",
            bucket: "write",
            curated: true,
          },
        },
        {
          name: "trash_message",
          description: "Move a Gmail message to trash.",
          classification: {
            capabilityId: "write",
            capabilityLabel: "Organize Gmail",
            defaultMode: "ask",
            bucket: "write",
            curated: true,
          },
        },
      ],
      discoveryStatus: "ready",
      discoveredAt: "2026-09-03T08:00:00.000Z",
      refreshAfter: "2026-09-03T09:00:00.000Z",
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

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("maps the personal github_user connection onto the GitHub plugin surface", () => {
    const html = renderToString(
      <GitHubPluginDetail
        pluginState={{ status: "ready", plugin: githubPlugin }}
        toolsState={githubToolsStateFromPlugin(githubPlugin)}
        canEdit
      />,
    );

    expect(html).toContain("octocat");
    expect(html).toContain("GitHub as you");
    expect(html).toContain("Read GitHub");
    expect(html).toContain("Manage GitHub");
    expect(useLiveQuery).not.toHaveBeenCalled();
  });

  it("presents the selected Drive account and all reviewed tools with Ask defaults", () => {
    const toolsState = googleDriveToolsStateFromPlugin(googleDrivePlugin);
    render(
      <GoogleDrivePluginDetail
        pluginState={{ status: "ready", plugin: googleDrivePlugin }}
        toolsState={toolsState}
        canEdit
      />,
    );

    expect(screen.getByText("founder@example.com")).toBeInTheDocument();
    expect(screen.queryByText("older@example.com")).not.toBeInTheDocument();
    expect(screen.getByText("Needs reconnect")).toBeInTheDocument();
    expect(screen.queryByText("Enable Docs & Sheets editing")).not.toBeInTheDocument();
    expect(screen.getByText(/most recently connected Google Drive account/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Connect Google Drive account" })).toHaveAttribute(
      "href",
      "/api/integrations/google-drive/start?returnTo=/settings/plugins/google-drive",
    );
    expect(
      screen.getByRole("link", { name: "Configure Google Drive ingestion in Wiki sources" }),
    ).toHaveAttribute("href", "/wiki/sources");
    for (const label of ["Browse Drive files", "Read files & permissions", "Create & copy files"]) {
      expect(
        within(screen.getByRole("group", { name: `${label} permission` })).getByRole("button", {
          name: "Ask",
        }),
      ).toHaveAttribute("aria-pressed", "true");
    }
    expect(toolsState).toMatchObject({
      status: "ready",
      discovery: { status: "ready", toolCount: 8 },
    });
    if (toolsState.status !== "ready") throw new Error("Expected discovered Drive tools.");
    expect(
      toolsState.groups.map((group) => ({
        id: group.id,
        defaultMode: group.defaultMode,
        tools: group.tools.map((tool) => tool.name),
      })),
    ).toEqual([
      {
        id: "read",
        defaultMode: "ask",
        tools: ["Get file metadata", "List recent files", "Search files"],
      },
      {
        id: "query",
        defaultMode: "ask",
        tools: ["Download file content", "Get file permissions", "Read file content"],
      },
      {
        id: "write",
        defaultMode: "ask",
        tools: ["Copy file", "Create file"],
      },
    ]);
    expect(GOOGLE_DRIVE_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/dc0c91221bcfa9b6088a19277f875c438b37e96e/google-drive",
    );
  });

  it("maps the personal SigNoz connection onto the official plugin surface", () => {
    const signozPlugin = {
      ...plugin,
      id: "plugin_signoz",
      name: "signoz",
      manifest: { name: "signoz", description: "Investigate SigNoz telemetry." },
      source: { ...plugin.source, path: "signoz" },
    } satisfies PluginInstallationDto;
    const html = renderToString(
      <SigNozPluginDetail
        pluginState={{ status: "ready", plugin: signozPlugin }}
        toolsState={defaultSigNozToolsState()}
        canEdit
      />,
    );

    expect(html).toContain("SigNoz");
    expect(html).toContain("Read SigNoz documentation");
    expect(html).toContain("Inspect observability data");
    expect(html).toContain("Manage SigNoz");
  });

  it("maps the existing PostHog OAuth connection onto the official plugin surface", () => {
    const posthogPlugin = {
      ...plugin,
      id: "plugin_posthog",
      name: "posthog",
      manifest: { name: "posthog", description: "Explore PostHog analytics." },
      source: { ...plugin.source, path: "posthog" },
    } satisfies PluginInstallationDto;
    const html = renderToString(
      <PostHogPluginDetail
        pluginState={{ status: "ready", plugin: posthogPlugin }}
        toolsState={defaultPostHogToolsState()}
        canEdit
      />,
    );

    expect(html).toContain("Acme Analytics");
    expect(html).toContain("Read analytics");
    expect(html).toContain("Create insights");
    expect(POSTHOG_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/4ba32cd5a7618d9be3714ec0efd3c8784209046c/posthog",
    );
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
    expect(toasts.success).toHaveBeenCalledWith("Linear installed.");
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

  it("renders GitHub connection, discovery, and permission controls against github_user", async () => {
    const state = githubToolsStateFromPlugin(githubPlugin);
    window.history.replaceState({}, "", "/settings/plugins/github");
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) =>
      Response.json({
        checkedAt: "2026-09-02T12:00:00.000Z",
        target: null,
        installations: [
          {
            id: "123",
            account: {
              id: "987",
              login: "opencompany",
              type: "Organization",
              avatarUrl: null,
              htmlUrl: "https://github.com/opencompany",
            },
            repositorySelection: "selected",
            permissions: { metadata: "read", contents: "write" },
            pendingPermissions: ["actions", "checks", "issues", "pull_requests"],
            suspendedAt: null,
            repositories: [
              {
                id: "456",
                name: "private-repo",
                fullName: "opencompany/private-repo",
                private: true,
                htmlUrl: "https://github.com/opencompany/private-repo",
              },
              ...(init?.method === "POST"
                ? [
                    {
                      id: "789",
                      name: "newly-approved-repo",
                      fullName: "opencompany/newly-approved-repo",
                      private: true,
                      htmlUrl: "https://github.com/opencompany/newly-approved-repo",
                    },
                  ]
                : []),
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GitHubPluginDetailView
        pluginState={{ status: "ready", plugin: githubPlugin }}
        accountsState={{
          status: "ready",
          accounts: [{ account: githubAccount }],
          permissionConnection: githubAccount,
        }}
        toolsState={state}
        canEdit
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "GitHub as you" })).toBeInTheDocument();
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect GitHub account" })).toHaveAttribute(
      "href",
      "/api/integrations/github-user/start?returnTo=/settings/plugins/github",
    );
    expect(await screen.findByRole("heading", { name: "Repository access" })).toBeVisible();
    const installationAccount = await screen.findByText("opencompany");
    expect(installationAccount).toBeVisible();
    await userEvent.click(installationAccount);
    expect(screen.getByText("opencompany/private-repo")).toBeVisible();
    expect(screen.getByTestId("github-permissions-pending")).toHaveTextContent(
      "New permissions pending approval",
    );
    expect(screen.getByRole("link", { name: "Add organization or account" })).toHaveAttribute(
      "href",
      "/api/integrations/github-user/start?returnTo=%2Fsettings%2Fplugins%2Fgithub",
    );
    await userEvent.click(screen.getByRole("link", { name: "Add organization or account" }));
    expect(screen.getByTestId("github-installation-pending")).toHaveTextContent(
      "Pending admin approval",
    );
    await userEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/github-user/installations",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByTestId("github-installation-approved")).toHaveTextContent(
      "Repository access updated",
    );
    expect(GITHUB_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/github$/u,
    );
    expect(state).toMatchObject({
      status: "ready",
      groups: [
        {
          id: "read",
          defaultMode: "on",
          tools: [
            { name: "Search repositories", readOnly: true },
            { name: "Actions list", readOnly: true },
          ],
        },
        {
          id: "write",
          defaultMode: "ask",
          tools: [{ name: "Merge pull request", readOnly: false }],
        },
      ],
    });

    const writeModes = screen.getByRole("group", { name: "Manage GitHub permission" });
    await userEvent.click(within(writeModes).getByRole("button", { name: "On" }));
    await waitFor(() =>
      expect(accountActions.setIntegrationCapabilityModeAction).toHaveBeenCalledWith(
        "gint_github_user",
        "write",
        "on",
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(accountActions.disconnectIntegrationAccountAction).toHaveBeenCalledWith(
        "gint_github_user",
      ),
    );
  });

  it.each([
    {
      query: "integration=github_user&setup=connected",
      toast: "success" as const,
      message: "GitHub connected.",
    },
    {
      query: "integration=github_user&setup=error&reason=installation_not_authorized",
      toast: "error" as const,
      message: "The selected GitHub App installation is not available to this GitHub account.",
    },
  ])("surfaces and clears GitHub setup status: $toast", async ({ query, toast, message }) => {
    window.history.replaceState({}, "", `/settings/plugins/github?${query}`);

    render(
      <GitHubPluginDetailView
        pluginState={{ status: "ready", plugin: githubPlugin }}
        accountsState={{
          status: "ready",
          accounts: [{ account: githubAccount }],
          permissionConnection: githubAccount,
        }}
        toolsState={githubToolsStateFromPlugin(githubPlugin)}
        canEdit
      />,
    );

    await waitFor(() => expect(toasts[toast]).toHaveBeenCalledWith(message));
    expect(window.location.pathname).toBe("/settings/plugins/github");
    expect(window.location.search).toBe("");
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

    expect(screen.getByRole("heading", { level: 1, name: "Neon" })).toBeInTheDocument();
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

  it("presents Better Stack with sensitive reads and writes gated on Ask", () => {
    const state = betterStackToolsStateFromPlugin(betterStackPlugin);
    const betterStackAccountsState = {
      status: "ready" as const,
      accounts: [{ account: betterStackAccount }],
      permissionConnection: betterStackAccount,
    };

    render(
      <BetterStackPluginDetailView
        pluginState={{ status: "ready", plugin: betterStackPlugin }}
        accountsState={betterStackAccountsState}
        toolsState={state}
        canEdit
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Better Stack" })).toBeInTheDocument();
    expect(screen.getByText("Documentation")).toBeInTheDocument();
    expect(screen.getByText("Query")).toBeInTheDocument();
    expect(screen.getByText("Create monitor")).toBeInTheDocument();
    expect(screen.getByText("This version of the plugin contains no skills.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Better Stack account" })).toHaveAttribute(
      "href",
      "/api/integrations/betterstack/start?returnTo=/settings/plugins/betterstack",
    );
    expect(BETTERSTACK_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/betterstack$/u,
    );
    expect(state).toMatchObject({
      status: "ready",
      groups: [
        { id: "read", defaultMode: "on", tools: [{ readOnly: true }] },
        { id: "query", defaultMode: "ask", tools: [{ readOnly: true }] },
        { id: "write", defaultMode: "ask", tools: [{ readOnly: false }] },
      ],
    });
    expect(
      within(screen.getByRole("group", { name: "Search Better Stack docs permission" })).getByRole(
        "button",
        { name: "On" },
      ),
    ).toHaveAttribute("aria-pressed", "true");
    for (const label of ["Inspect observability data", "Manage Better Stack"]) {
      expect(
        within(screen.getByRole("group", { name: `${label} permission` })).getByRole("button", {
          name: "Ask",
        }),
      ).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("presents Slack connections and three conservative permission tiers", () => {
    const state = slackToolsStateFromPlugin(slackPlugin);
    render(<SlackPluginDetail pluginState={{ status: "ready", plugin: slackPlugin }} canEdit />);

    expect(screen.getByRole("heading", { level: 1, name: "Slack" })).toBeInTheDocument();
    expect(screen.getByText("Acme · Ada")).toBeInTheDocument();
    expect(screen.getByText("Archive Co · Ada")).toBeInTheDocument();
    expect(screen.getByText("Slack tools")).toBeInTheDocument();
    expect(screen.getByText("Not active")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Slack account" })).toHaveAttribute(
      "href",
      "/api/integrations/slack/start?returnTo=/settings/plugins/slack",
    );
    expect(
      screen.queryByRole("link", { name: /Configure Slack ingestion/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Search public Slack permission" })).toHaveTextContent(
      "On",
    );
    expect(screen.getByRole("group", { name: "Read private Slack permission" })).toHaveTextContent(
      "Ask",
    );
    expect(screen.getByRole("group", { name: "Change Slack permission" })).toHaveTextContent("Ask");
    expect(SLACK_PLUGIN_SOURCE).toContain("/tree/1b912fe6c4f4497147887b2383f0181f763aa19b/slack");
    expect(state).toMatchObject({
      groups: [
        { id: "read", defaultMode: "on" },
        { id: "query", defaultMode: "ask" },
        { id: "write", defaultMode: "ask" },
      ],
    });
  });

  it("maps the active X account onto the official plugin surface", () => {
    const xPlugin = {
      ...plugin,
      id: "plugin_x",
      name: "x",
      manifest: { name: "x", description: "Official X plugin tools." },
      source: { ...plugin.source, path: "x" },
    } satisfies PluginInstallationDto;
    const toolsState: PluginToolsState = {
      status: "ready",
      groups: [
        {
          id: "read",
          label: "Research public X data",
          description: "Public X research tools.",
          modeKey: "read",
          defaultMode: "on",
          curated: true,
          tools: [],
        },
        {
          id: "query",
          label: "Read account & private X data",
          description: "Private X data tools.",
          modeKey: "query",
          defaultMode: "ask",
          curated: true,
          tools: [],
        },
        {
          id: "write",
          label: "Manage X",
          description: "X mutation tools.",
          modeKey: "write",
          defaultMode: "ask",
          curated: true,
          tools: [],
        },
      ],
      discovery: {
        status: "pending",
        toolCount: 0,
        discoveredAt: null,
        refreshAfter: null,
        lastDiscoveryError: null,
      },
    };

    render(
      <XPluginDetail
        pluginState={{ status: "ready", plugin: xPlugin }}
        toolsState={toolsState}
        canEdit
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "X" })).toBeInTheDocument();
    expect(screen.getByText("@founder · Founder")).toBeInTheDocument();
    expect(screen.getByText("@acme · Acme")).toBeInTheDocument();
    expect(screen.getByText("X tools")).toBeInTheDocument();
    expect(screen.getByText("Legacy fallback")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect X account" })).toHaveAttribute(
      "href",
      "/api/integrations/x-account/start?returnTo=/settings/plugins/x",
    );
    expect(
      screen.getByRole("group", { name: "Research public X data permission" }),
    ).toHaveTextContent("On");
    expect(
      screen.getByRole("group", { name: "Read account & private X data permission" }),
    ).toHaveTextContent("Ask");
    expect(screen.getByRole("group", { name: "Manage X permission" })).toHaveTextContent("Ask");
    expect(X_PLUGIN_SOURCE).toContain("/tree/21060c09d1bbe70df85519cc3ad74cd5d097fbb6/x");
  });

  it("presents Google Calendar with every capability gated on Ask", () => {
    const state = googleCalendarToolsStateFromPlugin(googleCalendarPlugin);
    render(
      <GoogleCalendarPluginDetail
        pluginState={{ status: "ready", plugin: googleCalendarPlugin }}
        canEdit
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Google Calendar" })).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Google Calendar account" })).toHaveAttribute(
      "href",
      "/api/integrations/google-calendar/start?returnTo=/settings/plugins/google-calendar",
    );
    for (const label of ["Check calendars", "Read calendar events", "Manage calendar events"]) {
      expect(
        within(screen.getByRole("group", { name: `${label} permission` })).getByRole("button", {
          name: "Ask",
        }),
      ).toHaveAttribute("aria-pressed", "true");
    }
    expect(GOOGLE_CALENDAR_PLUGIN_SOURCE).toContain(
      "/tree/de04f0c11eeb4e4eb4ed1140818205e14b08401f/google-calendar",
    );
    expect(state).toMatchObject({
      groups: [
        { id: "read", defaultMode: "ask" },
        { id: "query", defaultMode: "ask" },
        { id: "write", defaultMode: "ask" },
      ],
    });
  });

  it("reviews and installs Slack from the pinned package on its detail page", async () => {
    commands.previewHeadlessPluginImport.mockResolvedValue(slackPreview);
    commands.importHeadlessPlugin.mockResolvedValue({ plugin: slackPlugin, replayed: false });

    render(<SlackPluginDetail pluginState={{ status: "ready", plugin: null }} canEdit />);

    expect(screen.getByRole("button", { name: "Loading package…" })).toBeDisabled();
    expect(await screen.findByText("Search public Slack")).toBeInTheDocument();
    const installButton = screen.getByRole("button", { name: "Install" });
    expect(installButton).toBeEnabled();

    await userEvent.click(installButton);

    await waitFor(() => expect(commands.importHeadlessPlugin).toHaveBeenCalledTimes(1));
    expect(commands.previewHeadlessPluginImport).toHaveBeenCalledWith({
      url: SLACK_PLUGIN_SOURCE,
    });
    expect(commands.importHeadlessPlugin).toHaveBeenCalledWith({
      url: SLACK_PLUGIN_SOURCE,
      expectedResolvedCommit: slackPreview.source.resolvedCommit,
      expectedIntegrity: slackPreview.integrity,
    });
    expect(toasts.success).toHaveBeenCalledWith("Slack installed.");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("presents Gmail with every sensitive capability gated on Ask", () => {
    const state = gmailToolsStateFromPlugin(gmailPlugin);
    render(<GmailPluginDetail pluginState={{ status: "ready", plugin: gmailPlugin }} canEdit />);

    expect(screen.getByRole("heading", { level: 1, name: "Gmail" })).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Gmail account" })).toHaveAttribute(
      "href",
      "/api/integrations/gmail/start?access=mcp&returnTo=/settings/plugins/gmail",
    );
    for (const label of ["Read Gmail", "Create drafts", "Organize Gmail"]) {
      expect(
        within(screen.getByRole("group", { name: `${label} permission` })).getByRole("button", {
          name: "Ask",
        }),
      ).toHaveAttribute("aria-pressed", "true");
    }
    expect(state).toMatchObject({
      groups: [
        { id: "query", defaultMode: "ask", tools: [{ readOnly: true }] },
        { id: "draft", defaultMode: "ask", tools: [{ readOnly: false }] },
        { id: "write", defaultMode: "ask", tools: [{ readOnly: false }] },
      ],
    });
    expect(GMAIL_PLUGIN_SOURCE).toContain("/tree/587fb06ae2a4e4bed7532e216f8712979ca35e7b/gmail");
  });

  it("edits the same Gmail account selected by the MCP gateway", async () => {
    const [primary] = appData.integrations.personalAccounts.gmail;
    if (!primary) throw new Error("Expected a primary Gmail fixture.");
    const other = {
      ...primary,
      integrationId: "gint_gmail_other",
      accountEmail: "other@example.com",
      connectionLabel: "other@example.com",
      capabilityModes: { query: "off", draft: "off", write: "off" },
    };
    appData.integrations.personalAccounts.gmail = [other, primary];

    render(<GmailPluginDetail pluginState={{ status: "ready", plugin: gmailPlugin }} canEdit />);
    await userEvent.click(
      within(screen.getByRole("group", { name: "Read Gmail permission" })).getByRole("button", {
        name: "On",
      }),
    );
    expect(accountActions.setIntegrationCapabilityModeAction).toHaveBeenCalledWith(
      "gint_gmail",
      "query",
      "on",
    );
  });

  it("prompts older Gmail connections to grant the full MCP scope", () => {
    const oldGrant = {
      ...account("gint_gmail_old", "ada@example.com", {}, "gmail"),
      accountEmail: "ada@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    } satisfies IntegrationAccountView;
    render(
      <GmailPluginDetailView
        pluginState={{ status: "ready", plugin: gmailPlugin }}
        accountsState={{
          status: "ready",
          accounts: [{ account: oldGrant }],
          permissionConnection: oldGrant,
        }}
        toolsState={gmailToolsStateFromPlugin(gmailPlugin)}
        canEdit
      />,
    );

    expect(screen.getByRole("link", { name: "Enable full Gmail tools" })).toHaveAttribute(
      "href",
      "/api/integrations/gmail/start?access=mcp&returnTo=/settings/plugins/gmail",
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
