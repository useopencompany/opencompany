import type { IntegrationProvider, IntegrationStatus } from "@opencompany/db/product-schema";
import {
  GOOGLE_CALENDAR_MCP_RECONNECT_REASON,
  googleCalendarMcpScopesSatisfied,
} from "./integrations/google-calendar-scopes";
import { SLACK_MCP_RECONNECT_REASON, slackMcpScopesSatisfied } from "./integrations/slack-scopes";

export type GoogleProviderState = {
  provider: "gmail" | "google_calendar" | "google_drive";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountEmail: string | null;
  accountName: string | null;
  scopes: string[];
  capabilityModes: Record<string, unknown>;
};

export type GoogleDriveSourceProviderState = {
  provider: "google_drive";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountEmail: string | null;
  statusReason: string | null;
};

// The Gmail brain-source connection view adds ingestion-specific status detail
// used by the brain-source picker and save action.
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

export type HubSpotProviderState = {
  provider: "hubspot";
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

export type JamieProviderState = {
  provider: "jamie";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountName: string | null;
  statusReason: string | null;
  integrationId: string | null;
  capabilityModes: Record<string, unknown>;
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

export type GranolaMcpProviderState = {
  provider: "granola";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  statusReason: string | null;
  capabilityModes: Record<string, unknown>;
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

export type AttioMcpProviderState = {
  provider: "attio";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  statusReason: string | null;
  capabilityModes: Record<string, unknown>;
};

export type StripeProviderState = {
  provider: "stripe";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  livemode: boolean | null;
  statusReason: string | null;
  capabilityModes: Record<string, unknown>;
  toolModes: Record<string, unknown>;
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
export type IntegrationAccountView<Provider extends string = PersonalAccountProvider> = {
  integrationId: string;
  provider: Provider;
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
  | "jamie"
  | "slack"
  | "hubspot"
  | "granola"
  | "fathom"
  | "attio"
  | "betterstack"
  | "render"
  | "signoz"
  | "latitude"
  | "neon"
  | "x_account";

export type IntegrationState = {
  gmail: GoogleProviderState;
  google_calendar: GoogleProviderState;
  google_drive: GoogleProviderState;
  linear: LinearProviderState;
  hubspot: HubSpotProviderState;
  posthog: PostHogProviderState;
  jamie: JamieProviderState;
  slack: SlackProviderState;
  granola: GranolaProviderState;
  granola_mcp: GranolaMcpProviderState;
  fathom: FathomProviderState;
  attio: AttioMcpProviderState;
  stripe: StripeProviderState;
  x_account: XAccountProviderState;
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
  toolModes?: Record<string, unknown> | null;
  tool_modes?: Record<string, unknown> | null;
};

const JAMIE_MCP_EXTERNAL_ID = "jamie_mcp";
const FATHOM_MCP_EXTERNAL_ID = "fathom_mcp";

// Collects every personal (non-workspace) account row per provider. The
// Linear, HubSpot, Attio, and Granola ingestion connections count as accounts;
// their dedicated MCP connector rows do not. Fathom is the inverse: only its MCP
// connector is shown in plugin account lists, while its API-key row stays in Wiki sources.
export function personalAccountsFromRows(
  rows: readonly IntegrationStateRow[],
): Record<PersonalAccountProvider, IntegrationAccountView[]> {
  const personalAccounts: Record<PersonalAccountProvider, IntegrationAccountView[]> = {
    gmail: [],
    google_calendar: [],
    google_drive: [],
    linear: [],
    github_user: [],
    jamie: [],
    slack: [],
    hubspot: [],
    granola: [],
    fathom: [],
    attio: [],
    betterstack: [],
    render: [],
    signoz: [],
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
    if (row.provider === "hubspot") {
      if ((row.externalId ?? row.external_id) !== "hubspot_mcp") {
        personalAccounts.hubspot.push(accountViewFromRow("hubspot", row));
      }
      continue;
    }
    if (row.provider === "jamie") {
      if ((row.externalId ?? row.external_id) === JAMIE_MCP_EXTERNAL_ID) {
        personalAccounts.jamie.push(accountViewFromRow("jamie", row));
      }
      continue;
    }
    if (row.provider === "attio") {
      if ((row.externalId ?? row.external_id) !== "attio_mcp") {
        personalAccounts.attio.push(accountViewFromRow("attio", row));
      }
      continue;
    }
    if (row.provider === "granola") {
      if ((row.externalId ?? row.external_id) !== "granola_mcp") {
        personalAccounts.granola.push(accountViewFromRow("granola", row));
      }
      continue;
    }
    if (row.provider === "fathom") {
      if ((row.externalId ?? row.external_id) === FATHOM_MCP_EXTERNAL_ID) {
        personalAccounts.fathom.push(accountViewFromRow("fathom", row));
      }
      continue;
    }
    if (
      row.provider === "gmail" ||
      row.provider === "google_calendar" ||
      row.provider === "google_drive" ||
      row.provider === "github_user" ||
      row.provider === "slack" ||
      row.provider === "betterstack" ||
      row.provider === "render" ||
      row.provider === "signoz" ||
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
  let granolaMcpRow: IntegrationStateRow | undefined;
  for (const row of rows) {
    if (row.status === "disconnected") continue;
    // Provider "linear" covers two kinds of rows; the MCP card must only ever
    // reflect the MCP connector row (external_id "linear_mcp"). Linear
    // brain-source rows are surfaced through the brain settings page instead.
    if (row.provider === "linear" && (row.externalId ?? row.external_id) !== "linear_mcp") {
      continue;
    }
    // HubSpot also has a separate OAuth connection for Wiki ingestion. Only
    // the MCP-auth-app row belongs to the plugin settings and action gateway.
    if (row.provider === "hubspot" && (row.externalId ?? row.external_id) !== "hubspot_mcp") {
      continue;
    }
    if (row.provider === "granola" && (row.externalId ?? row.external_id) === "granola_mcp") {
      granolaMcpRow = row;
      continue;
    }
    // Attio's API-key connection remains available for Wiki ingestion and as
    // a legacy action fallback. Plugin settings reflect only the MCP OAuth row.
    if (row.provider === "attio" && (row.externalId ?? row.external_id) !== "attio_mcp") {
      continue;
    }
    // Fathom's API-key row remains the Wiki ingestion fallback. The dedicated
    // OAuth connector is surfaced only through personalAccounts on the Plugin page.
    if (
      row.provider === "fathom" &&
      (row.externalId ?? row.external_id) === FATHOM_MCP_EXTERNAL_ID
    ) {
      continue;
    }
    // Stripe is workspace-owned; personal rows are pre-ownership leftovers
    // and must not shadow the workspace connection.
    if (row.provider === "stripe" && !(row.workspaceId ?? row.workspace_id)) {
      continue;
    }
    // Jamie's retired webhook integration used workspace-owned rows. Only the
    // personal OAuth connector row belongs to the official plugin.
    if (
      row.provider === "jamie" &&
      ((row.workspaceId ?? row.workspace_id) ||
        (row.externalId ?? row.external_id) !== JAMIE_MCP_EXTERNAL_ID)
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
    hubspot: hubspotProviderState(byProvider.get("hubspot")),
    posthog: posthogProviderState(byProvider.get("posthog")),
    jamie: jamieProviderState(byProvider.get("jamie")),
    slack: slackProviderState(byProvider.get("slack")),
    granola: granolaProviderState(byProvider.get("granola")),
    granola_mcp: granolaMcpProviderState(granolaMcpRow),
    fathom: fathomProviderState(byProvider.get("fathom")),
    attio: attioMcpProviderState(byProvider.get("attio")),
    stripe: stripeProviderState(byProvider.get("stripe")),
    x_account: xAccountProviderState(byProvider.get("x_account")),
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
  const scopes = Array.isArray(row.scopes)
    ? row.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const needsSlackPluginGrant =
    provider === "slack" && row.status === "connected" && !slackMcpScopesSatisfied(scopes);
  const needsGoogleCalendarPluginGrant =
    provider === "google_calendar" &&
    row.status === "connected" &&
    !googleCalendarMcpScopesSatisfied(scopes);
  const needsPluginGrant = needsSlackPluginGrant || needsGoogleCalendarPluginGrant;
  return {
    integrationId: row.id ?? "",
    provider,
    status: needsPluginGrant ? "needs_reauth" : row.status,
    connected: row.status === "connected" && !needsPluginGrant,
    accountEmail: row.accountEmail ?? row.account_email ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    connectionLabel: row.connectionLabel ?? row.connection_label ?? null,
    statusReason: needsSlackPluginGrant
      ? SLACK_MCP_RECONNECT_REASON
      : needsGoogleCalendarPluginGrant
        ? GOOGLE_CALENDAR_MCP_RECONNECT_REASON
        : (row.statusReason ?? row.status_reason ?? null),
    scopes,
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
      integrationId: null,
      accountEmail: null,
      accountName: null,
      scopes: [],
      capabilityModes: {},
    };
  }

  const scopes = Array.isArray(row.scopes)
    ? row.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];

  return {
    provider,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountEmail: row.accountEmail ?? row.account_email ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    scopes,
    capabilityModes: row.capabilityModes ?? row.capability_modes ?? {},
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

function hubspotProviderState(row: IntegrationStateRow | undefined): HubSpotProviderState {
  if (!row) {
    return {
      provider: "hubspot",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
      capabilityModes: {},
    };
  }

  return {
    provider: "hubspot",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
    capabilityModes: row.capabilityModes ?? row.capability_modes ?? {},
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

  const scopes = Array.isArray(row.scopes)
    ? row.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const needsPluginGrant = row.status === "connected" && !slackMcpScopesSatisfied(scopes);

  return {
    provider: "slack",
    connected: row.status === "connected" && !needsPluginGrant,
    status: needsPluginGrant ? "needs_reauth" : row.status,
    integrationId: row.id ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    teamName: row.connectionLabel ?? row.connection_label ?? null,
    statusReason: needsPluginGrant
      ? SLACK_MCP_RECONNECT_REASON
      : (row.statusReason ?? row.status_reason ?? null),
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

function granolaMcpProviderState(row: IntegrationStateRow | undefined): GranolaMcpProviderState {
  if (!row || row.status === "disconnected") {
    return {
      provider: "granola",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
      capabilityModes: {},
    };
  }

  return {
    provider: "granola",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
    capabilityModes: row.capabilityModes ?? row.capability_modes ?? {},
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

function attioMcpProviderState(row: IntegrationStateRow | undefined): AttioMcpProviderState {
  if (!row || row.status === "disconnected") {
    return {
      provider: "attio",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
      capabilityModes: {},
    };
  }

  return {
    provider: "attio",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id ?? null,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
    capabilityModes: row.capabilityModes ?? row.capability_modes ?? {},
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
      capabilityModes: {},
      toolModes: {},
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
    capabilityModes: row.capabilityModes ?? row.capability_modes ?? {},
    toolModes: row.toolModes ?? row.tool_modes ?? {},
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
      capabilityModes: {},
    };
  }

  return {
    provider: "jamie",
    connected: row.status === "connected",
    status: row.status,
    accountName: row.accountName ?? row.account_name ?? null,
    statusReason: row.statusReason ?? row.status_reason ?? null,
    integrationId: row.id ?? null,
    capabilityModes: row.capabilityModes ?? row.capability_modes ?? {},
  };
}
