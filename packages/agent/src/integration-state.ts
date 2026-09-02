import type { IntegrationProvider, IntegrationStatus } from "@opencompany/db/product-schema";

export type GoogleProviderState = {
  provider: "gmail" | "google_calendar" | "google_drive";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountEmail: string | null;
  accountName: string | null;
};

export type GoogleDriveSourceProviderState = {
  provider: "google_drive";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountEmail: string | null;
  statusReason: string | null;
};

// The Gmail brain-source connection view: unlike GoogleProviderState it
// carries the integration id, which the brain-source picker and save action
// need to key config rows on.
export type GmailSourceProviderState = {
  provider: "gmail";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountEmail: string | null;
  statusReason: string | null;
};

export type LinearProviderState = {
  provider: "linear";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  statusReason: string | null;
  capabilityModes: Record<string, unknown>;
};

export type PostHogProviderState = {
  provider: "posthog";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  statusReason: string | null;
  capabilityModes: Record<string, unknown>;
};

// The Linear brain-source connection (a Linear OAuth app with webhooks), as
// opposed to LinearProviderState which describes the MCP connector. Both
// share provider "linear"; rows are told apart by external_id ("linear_mcp"
// for MCP, the Linear organization id for the source connection).
export type LinearSourceProviderState = {
  provider: "linear";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  organizationName: string | null;
  statusReason: string | null;
};

// The HubSpot brain-source connection (a HubSpot OAuth app with webhooks).
// Rows key external_id on the HubSpot portal id.
export type HubspotSourceProviderState = {
  provider: "hubspot";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountEmail: string | null;
  hubDomain: string | null;
  statusReason: string | null;
};

export type GitHubProviderState = {
  provider: "github";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountName: string | null;
  statusReason: string | null;
};

export type JamieProviderState = {
  provider: "jamie";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountName: string | null;
  statusReason: string | null;
  integrationId: string | null;
  webhookUrl: string | null;
  apiKeyConfigured: boolean;
};

// Granola connects with a personal API key minted in the Granola app; the
// integration id is what the brain-source picker and save action key config
// rows on.
export type GranolaProviderState = {
  provider: "granola";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountEmail: string | null;
  accountName: string | null;
  statusReason: string | null;
};

// iMessage pairs the user's own phone number (verified with a one-time code
// sent over iMessage); the E.164 number lives in account_name. There is no
// credential row — the send transport is platform-level.
export type ImessageProviderState = {
  provider: "imessage";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  phoneE164: string | null;
  statusReason: string | null;
};

// Fathom connects with a personal API key minted in Fathom's user settings;
// the integration id is what the brain-source picker and save action key
// config rows on.
export type FathomProviderState = {
  provider: "fathom";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountEmail: string | null;
  accountName: string | null;
  statusReason: string | null;
};

// Attio connects with a workspace API key minted in Attio's developer
// settings; connect also mints the Attio webhook that feeds ingestion. Rows
// key external_id on the Attio workspace id so inbound webhooks route by the
// event's workspace_id.
export type AttioProviderState = {
  provider: "attio";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  workspaceName: string | null;
  statusReason: string | null;
};

export type StripeProviderState = {
  provider: "stripe";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  livemode: boolean | null;
  statusReason: string | null;
};

export type SlackProviderState = {
  provider: "slack";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  teamName: string | null;
  statusReason: string | null;
};

// The connected X (Twitter) account posts on behalf of the user, distinct
// from the unrelated "x" managed capability (public, read-only X data).
export type XAccountProviderState = {
  provider: "x_account";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  handle: string | null;
  statusReason: string | null;
};

export type CodexProviderState = {
  provider: "codex";
  connected: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  statusReason: string | null;
  lastValidatedAt: string | null;
  workspaceEngine: {
    enabled: boolean;
    providerDisplayName: string;
    providerEmail: string;
    credentialStatus: "connected" | "needs_reauth";
    credentialStatusReason: string | null;
    lastValidatedAt: string | null;
    isCurrentUser: boolean;
  } | null;
};

export type ClaudeCodeProviderState = {
  provider: "claude_code";
  connected: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  statusReason: string | null;
  lastValidatedAt: string | null;
};

export type InfisicalProviderState = {
  provider: "infisical";
  connected: boolean;
  status: "connected" | "needs_reauth" | "disconnected" | "not_connected";
  statusReason: string | null;
  accountEmail: string | null;
  host: "https://app.infisical.com" | "https://eu.infisical.com" | null;
  lastValidatedAt: string | null;
};

// One connected account of a personal provider. A user can hold several
// accounts per provider (two Gmails, two Slack workspaces) — uniqueness in the
// DB is (user, provider, external_id), so a second OAuth pass creates a
// second row rather than replacing the first.
export type IntegrationAccountView = {
  integrationId: string;
  provider: PersonalAccountProvider;
  status: IntegrationStatus;
  connected: boolean;
  accountEmail: string | null;
  accountName: string | null;
  connectionLabel: string | null;
  statusReason: string | null;
  scopes: string[];
  // Sparse per-connection capability overrides; registry defaults fill gaps.
  capabilityModes: Record<string, unknown>;
};

export type PersonalAccountProvider =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "linear"
  | "github_user"
  | "slack"
  | "hubspot"
  | "granola"
  | "fathom"
  | "attio"
  | "betterstack"
  | "latitude"
  | "neon"
  | "x_account";

export type IntegrationState = {
  gmail: GoogleProviderState;
  google_calendar: GoogleProviderState;
  google_drive: GoogleProviderState;
  linear: LinearProviderState;
  posthog: PostHogProviderState;
  github: GitHubProviderState;
  jamie: JamieProviderState;
  slack: SlackProviderState;
  granola: GranolaProviderState;
  fathom: FathomProviderState;
  attio: AttioProviderState;
  stripe: StripeProviderState;
  x_account: XAccountProviderState;
  imessage: ImessageProviderState;
  codex: CodexProviderState;
  claude_code: ClaudeCodeProviderState;
  infisical: InfisicalProviderState;
  // All of the user's connected accounts per personal provider. The
  // single-account states above remain the "primary connection" view used by
  // onboarding and zero states; multi-account UI reads this instead.
  personalAccounts: Record<PersonalAccountProvider, IntegrationAccountView[]>;
};

type IntegrationStateRow = {
  id?: string;
  provider: IntegrationProvider;
  workspaceId?: string | null;
  workspace_id?: string | null;
  externalId?: string | null;
  external_id?: string | null;
  accountEmail?: string | null;
  account_email?: string | null;
  accountName?: string | null;
  account_name?: string | null;
  accountType?: string | null;
  account_type?: string | null;
  connectionLabel?: string | null;
  connection_label?: string | null;
  statusReason?: string | null;
  status_reason?: string | null;
  status: IntegrationStatus;
  scopes?: string[] | null;
  capabilityModes?: Record<string, unknown> | null;
  capability_modes?: Record<string, unknown> | null;
};

const JAMIE_API_KEY_EXTERNAL_ID_PREFIX = "jamie_api_key_sha256:";

// Collects every personal (non-workspace) account row per provider. The
// Linear ingest connections count as accounts; the MCP connector row
// (external_id "linear_mcp") never does.
export function personalAccountsFromRows(
  rows: readonly IntegrationStateRow[],
): Record<PersonalAccountProvider, IntegrationAccountView[]> {
  const personalAccounts: Record<PersonalAccountProvider, IntegrationAccountView[]> = {
    gmail: [],
    google_calendar: [],
    google_drive: [],
    linear: [],
    github_user: [],
    slack: [],
    hubspot: [],
    granola: [],
    fathom: [],
    attio: [],
    betterstack: [],
    latitude: [],
    neon: [],
    x_account: [],
  };
  for (const row of rows) {
    if (row.status === "disconnected") continue;
    if (!row.id || (row.workspaceId ?? row.workspace_id)) continue;
    if (row.provider === "linear") {
      if ((row.externalId ?? row.external_id) !== "linear_mcp") {
        personalAccounts.linear.push(accountViewFromRow("linear", row));
      }
      continue;
    }
    if (
      row.provider === "gmail" ||
      row.provider === "google_calendar" ||
      row.provider === "google_drive" ||
      row.provider === "github_user" ||
      row.provider === "slack" ||
      row.provider === "hubspot" ||
      row.provider === "granola" ||
      row.provider === "fathom" ||
      row.provider === "attio" ||
      row.provider === "betterstack" ||
      row.provider === "latitude" ||
      row.provider === "neon" ||
      row.provider === "x_account"
    ) {
      personalAccounts[row.provider].push(accountViewFromRow(row.provider, row));
    }
  }
  return personalAccounts;
}

export function integrationStateFromRows(rows: readonly IntegrationStateRow[]): IntegrationState {
  const byProvider = new Map<IntegrationProvider, IntegrationStateRow>();
  for (const row of rows) {
    if (row.status === "disconnected") continue;
    // Provider "linear" covers two kinds of rows; the MCP card must only ever
    // reflect the MCP connector row (external_id "linear_mcp"). Linear
    // brain-source rows are surfaced through the brain settings page instead.
    if (row.provider === "linear" && (row.externalId ?? row.external_id) !== "linear_mcp") {
      continue;
    }
    // GitHub, Jamie, and Stripe are workspace-owned; personal rows for those
    // providers are pre-ownership leftovers and must not shadow the workspace
    // connection.
    if (
      (row.provider === "github" || row.provider === "jamie" || row.provider === "stripe") &&
      !(row.workspaceId ?? row.workspace_id)
    ) {
      continue;
    }
    byProvider.set(row.provider, row);
  }
  const personalAccounts = personalAccountsFromRows(rows);

  return {
    gmail: googleProviderState("gmail", byProvider.get("gmail")),
    google_calendar: googleProviderState("google_calendar", byProvider.get("google_calendar")),
    google_drive: googleProviderState("google_drive", byProvider.get("google_drive")),
    linear: linearProviderState(byProvider.get("linear")),
    posthog: posthogProviderState(byProvider.get("posthog")),
    github: githubProviderState(byProvider.get("github")),
    jamie: jamieProviderState(byProvider.get("jamie")),
    slack: slackProviderState(byProvider.get("slack")),
    granola: granolaProviderState(byProvider.get("granola")),
    fathom: fathomProviderState(byProvider.get("fathom")),
    attio: attioProviderState(byProvider.get("attio")),
    stripe: stripeProviderState(byProvider.get("stripe")),
    x_account: xAccountProviderState(byProvider.get("x_account")),
    imessage: imessageProviderState(byProvider.get("imessage")),
    codex: {
      provider: "codex",
      connected: false,
      status: "not_connected",
      statusReason: null,
      lastValidatedAt: null,
      workspaceEngine: null,
    },
    claude_code: {
      provider: "claude_code",
      connected: false,
      status: "not_connected",
      statusReason: null,
      lastValidatedAt: null,
    },
    infisical: {
      provider: "infisical",
      connected: false,
      status: "not_connected",
      statusReason: null,
      accountEmail: null,
      host: null,
      lastValidatedAt: null,
    },
    personalAccounts,
  };
}

function accountViewFromRow(
  provider: PersonalAccountProvider,
  row: IntegrationStateRow,
): IntegrationAccountView {
  return {
    integrationId: row.id ?? "",
    provider,
    status: row.status,
    connected: row.status === "connected",
    accountEmail: row.accountEmail ?? row.account_email ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    connectionLabel: row.connectionLabel ?? row.connection_label ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
    scopes: Array.isArray(row.scopes)
      ? row.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    capabilityModes: row.capabilityModes ?? row.capability_modes ?? {},
  };
}

export const googleIntegrationStateFromRows = integrationStateFromRows;

function googleProviderState(
  provider: "gmail" | "google_calendar" | "google_drive",
  row: IntegrationStateRow | undefined,
): GoogleProviderState {
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

function linearProviderState(row: IntegrationStateRow | undefined): LinearProviderState {
  if (!row) {
    return {
      provider: "linear",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
      capabilityModes: {},
    };
  }

  return {
    provider: "linear",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
    capabilityModes: row.capabilityModes ?? row.capability_modes ?? {},
  };
}

function posthogProviderState(row: IntegrationStateRow | undefined): PostHogProviderState {
  if (!row) {
    return {
      provider: "posthog",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
      capabilityModes: {},
    };
  }

  return {
    provider: "posthog",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
    capabilityModes: row.capabilityModes ?? row.capability_modes ?? {},
  };
}

function githubProviderState(row: IntegrationStateRow | undefined): GitHubProviderState {
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

function slackProviderState(row: IntegrationStateRow | undefined): SlackProviderState {
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

function xAccountProviderState(row: IntegrationStateRow | undefined): XAccountProviderState {
  if (!row || row.status === "disconnected") {
    return {
      provider: "x_account",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      handle: null,
      statusReason: null,
    };
  }

  return {
    provider: "x_account",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    handle: row.connectionLabel ?? row.connection_label ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
  };
}

function granolaProviderState(row: IntegrationStateRow | undefined): GranolaProviderState {
  if (!row || row.status === "disconnected") {
    return {
      provider: "granola",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountEmail: null,
      accountName: null,
      statusReason: null,
    };
  }

  return {
    provider: "granola",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountEmail: row.accountEmail ?? row.account_email ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
  };
}

function imessageProviderState(row: IntegrationStateRow | undefined): ImessageProviderState {
  if (!row || row.status === "disconnected") {
    return {
      provider: "imessage",
      connected: false,
      status: "not_connected",
      integrationId: null,
      phoneE164: null,
      statusReason: null,
    };
  }

  return {
    provider: "imessage",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    phoneE164: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
  };
}

function fathomProviderState(row: IntegrationStateRow | undefined): FathomProviderState {
  if (!row || row.status === "disconnected") {
    return {
      provider: "fathom",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountEmail: null,
      accountName: null,
      statusReason: null,
    };
  }

  return {
    provider: "fathom",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountEmail: row.accountEmail ?? row.account_email ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
  };
}

function attioProviderState(row: IntegrationStateRow | undefined): AttioProviderState {
  if (!row || row.status === "disconnected") {
    return {
      provider: "attio",
      connected: false,
      status: "not_connected",
      integrationId: null,
      workspaceName: null,
      statusReason: null,
    };
  }

  return {
    provider: "attio",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    workspaceName: row.connectionLabel ?? row.connection_label ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
  };
}

function stripeProviderState(row: IntegrationStateRow | undefined): StripeProviderState {
  if (!row || row.status === "disconnected") {
    return {
      provider: "stripe",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      livemode: null,
      statusReason: null,
    };
  }

  return {
    provider: "stripe",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountName:
      row.connectionLabel ?? row.connection_label ?? row.accountName ?? row.account_name ?? null,
    livemode:
      (row.accountType ?? row.account_type) === "stripe_live_restricted_key"
        ? true
        : (row.accountType ?? row.account_type) === "stripe_test_restricted_key"
          ? false
          : null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
  };
}

function jamieProviderState(row: IntegrationStateRow | undefined): JamieProviderState {
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
