import type { GoatIntegrationProvider, GoatIntegrationStatus } from "@opencompany/db/goat-schema";

export type GoatGoogleProviderState = {
  provider: "gmail" | "google_calendar";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountEmail: string | null;
  accountName: string | null;
};

export type GoatLinearProviderState = {
  provider: "linear";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountName: string | null;
  statusReason: string | null;
};

export type GoatGitHubProviderState = {
  provider: "github";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountName: string | null;
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
  linear: GoatLinearProviderState;
  github: GoatGitHubProviderState;
  codex: GoatCodexProviderState;
};

type IntegrationStateRow = {
  provider: GoatIntegrationProvider;
  accountEmail?: string | null;
  account_email?: string | null;
  accountName?: string | null;
  account_name?: string | null;
  statusReason?: string | null;
  status_reason?: string | null;
  status: GoatIntegrationStatus;
};

export function goatIntegrationStateFromRows(rows: readonly IntegrationStateRow[]) {
  const byProvider = new Map<GoatIntegrationProvider, IntegrationStateRow>();
  for (const row of rows) {
    if (row.status === "disconnected") continue;
    byProvider.set(row.provider, row);
  }

  return {
    gmail: googleProviderState("gmail", byProvider.get("gmail")),
    google_calendar: googleProviderState("google_calendar", byProvider.get("google_calendar")),
    linear: linearProviderState(byProvider.get("linear")),
    github: githubProviderState(byProvider.get("github")),
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
  provider: "gmail" | "google_calendar",
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
