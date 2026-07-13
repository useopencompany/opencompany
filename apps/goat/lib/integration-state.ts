import type { GoatIntegrationProvider, GoatIntegrationStatus } from "@opencompany/db/goat-schema";

export type GoatGoogleProviderState = {
  provider: "gmail" | "google_calendar" | "google_drive";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountEmail: string | null;
  accountName: string | null;
};

export type GoatGoogleDriveSourceProviderState = {
  provider: "google_drive";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountEmail: string | null;
  statusReason: string | null;
};

// The Gmail brain-source connection view: unlike GoatGoogleProviderState it
// carries the integration id, which the brain-source picker and save action
// need to key config rows on.
export type GoatGmailSourceProviderState = {
  provider: "gmail";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountEmail: string | null;
  statusReason: string | null;
};

export type GoatLinearProviderState = {
  provider: "linear";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountName: string | null;
  statusReason: string | null;
};

// The Linear brain-source connection (a Linear OAuth app with webhooks), as
// opposed to GoatLinearProviderState which describes the MCP connector. Both
// share provider "linear"; rows are told apart by external_id ("linear_mcp"
// for MCP, the Linear organization id for the source connection).
export type GoatLinearSourceProviderState = {
  provider: "linear";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  organizationName: string | null;
  statusReason: string | null;
};

export type GoatGitHubProviderState = {
  provider: "github";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountName: string | null;
  statusReason: string | null;
};

export type GoatJamieProviderState = {
  provider: "jamie";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountName: string | null;
  statusReason: string | null;
  integrationId: string | null;
  webhookUrl: string | null;
  apiKeyConfigured: boolean;
};

export type GoatSlackProviderState = {
  provider: "slack";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  teamName: string | null;
  statusReason: string | null;
};

export type GoatCodexProviderState = {
  provider: "codex";
  connected: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  statusReason: string | null;
  lastValidatedAt: string | null;
};

export type GoatIntegrationState = {
  gmail: GoatGoogleProviderState;
  google_calendar: GoatGoogleProviderState;
  google_drive: GoatGoogleProviderState;
  linear: GoatLinearProviderState;
  github: GoatGitHubProviderState;
  jamie: GoatJamieProviderState;
  slack: GoatSlackProviderState;
  codex: GoatCodexProviderState;
};

type IntegrationStateRow = {
  id?: string;
  provider: GoatIntegrationProvider;
  workspaceId?: string | null;
  workspace_id?: string | null;
  externalId?: string | null;
  external_id?: string | null;
  accountEmail?: string | null;
  account_email?: string | null;
  accountName?: string | null;
  account_name?: string | null;
  connectionLabel?: string | null;
  connection_label?: string | null;
  statusReason?: string | null;
  status_reason?: string | null;
  status: GoatIntegrationStatus;
};

const JAMIE_API_KEY_EXTERNAL_ID_PREFIX = "jamie_api_key_sha256:";

export function goatIntegrationStateFromRows(rows: readonly IntegrationStateRow[]) {
  const byProvider = new Map<GoatIntegrationProvider, IntegrationStateRow>();
  for (const row of rows) {
    if (row.status === "disconnected") continue;
    // Provider "linear" covers two kinds of rows; the MCP card must only ever
    // reflect the MCP connector row (external_id "linear_mcp"). Linear
    // brain-source rows are surfaced through the brain settings page instead.
    if (row.provider === "linear" && (row.externalId ?? row.external_id) !== "linear_mcp") {
      continue;
    }
    // GitHub and Jamie are workspace-owned; personal rows for those providers
    // are pre-ownership leftovers and must not shadow the workspace connection.
    if (
      (row.provider === "github" || row.provider === "jamie") &&
      !(row.workspaceId ?? row.workspace_id)
    ) {
      continue;
    }
    byProvider.set(row.provider, row);
  }

  return {
    gmail: googleProviderState("gmail", byProvider.get("gmail")),
    google_calendar: googleProviderState("google_calendar", byProvider.get("google_calendar")),
    google_drive: googleProviderState("google_drive", byProvider.get("google_drive")),
    linear: linearProviderState(byProvider.get("linear")),
    github: githubProviderState(byProvider.get("github")),
    jamie: jamieProviderState(byProvider.get("jamie")),
    slack: slackProviderState(byProvider.get("slack")),
    codex: {
      provider: "codex",
      connected: false,
      status: "not_connected",
      statusReason: null,
      lastValidatedAt: null,
    },
  };
}

export const goatGoogleIntegrationStateFromRows = goatIntegrationStateFromRows;

function googleProviderState(
  provider: "gmail" | "google_calendar" | "google_drive",
  row: IntegrationStateRow | undefined,
): GoatGoogleProviderState {
  if (!row) {
    return {
      provider,
      connected: false,
      status: "not_connected",
      accountEmail: null,
      accountName: null,
    };
  }

  return {
    provider,
    connected: row.status === "connected",
    status: row.status,
    accountEmail: row.accountEmail ?? row.account_email ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
  };
}

function linearProviderState(row: IntegrationStateRow | undefined): GoatLinearProviderState {
  if (!row) {
    return {
      provider: "linear",
      connected: false,
      status: "not_connected",
      accountName: null,
      statusReason: null,
    };
  }

  return {
    provider: "linear",
    connected: row.status === "connected",
    status: row.status,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
  };
}

function githubProviderState(row: IntegrationStateRow | undefined): GoatGitHubProviderState {
  if (!row) {
    return {
      provider: "github",
      connected: false,
      status: "not_connected",
      accountName: null,
      statusReason: null,
    };
  }

  return {
    provider: "github",
    connected: row.status === "connected",
    status: row.status,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
  };
}

function slackProviderState(row: IntegrationStateRow | undefined): GoatSlackProviderState {
  if (!row || row.status === "disconnected") {
    return {
      provider: "slack",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      teamName: null,
      statusReason: null,
    };
  }

  return {
    provider: "slack",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    teamName: row.connectionLabel ?? row.connection_label ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
  };
}

function jamieProviderState(row: IntegrationStateRow | undefined): GoatJamieProviderState {
  if (!row) {
    return {
      provider: "jamie",
      connected: false,
      status: "not_connected",
      accountName: null,
      statusReason: null,
      integrationId: null,
      webhookUrl: null,
      apiKeyConfigured: false,
    };
  }

  return {
    provider: "jamie",
    connected: row.status === "connected",
    status: row.status,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
    integrationId: row.id ?? null,
    webhookUrl: null,
    apiKeyConfigured:
      row.status === "connected" ||
      (row.externalId ?? row.external_id ?? "").startsWith(JAMIE_API_KEY_EXTERNAL_ID_PREFIX),
  };
}
