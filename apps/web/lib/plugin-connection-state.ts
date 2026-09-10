import type {
  InfisicalProviderState,
  IntegrationAccountView,
  IntegrationState,
  PersonalAccountProvider,
} from "@/lib/integration-state";
import {
  GOOGLE_DRIVE_MCP_RECONNECT_REASON,
  googleDriveMcpScopesSatisfied,
} from "@/lib/integrations/google-drive-scopes";
import type { OfficialMcpPluginMetadata } from "@/lib/official-plugins";

export type PluginConnectionProvider = PersonalAccountProvider | "posthog" | "stripe";
export type PluginAccount = { account: IntegrationAccountView<PluginConnectionProvider> };
export type ManagedPluginConnection = {
  provider: "infisical";
  integration: InfisicalProviderState;
};

export type PluginAccounts = {
  accounts: PluginAccount[];
  permissionConnection: IntegrationAccountView<PluginConnectionProvider> | null;
  managedConnection?: ManagedPluginConnection;
};

/**
 * Whether an official MCP plugin has the account connection it needs to actually run.
 *
 * Infisical is connected through a managed workspace integration rather than a personal
 * account, so it never populates `permissionConnection`. Plugins that document a
 * `connectionUnavailableReason` (for example Vercel) have no connect flow at all, so there
 * is nothing for the user to fix and they count as satisfied.
 */
export function pluginConnectionSatisfied(
  config: OfficialMcpPluginMetadata,
  accounts: Pick<PluginAccounts, "permissionConnection" | "managedConnection">,
): boolean {
  if (config.connectionUnavailableReason) return true;
  if (accounts.managedConnection) return accounts.managedConnection.integration.connected;
  return accounts.permissionConnection?.connected === true;
}

export function pluginAccountsFromState(
  state: IntegrationState,
  config: Pick<OfficialMcpPluginMetadata, "connectionProvider">,
): PluginAccounts {
  if (config.connectionProvider === "infisical") {
    return {
      accounts: [],
      permissionConnection: null,
      managedConnection: { provider: "infisical", integration: state.infisical },
    };
  }
  if (config.connectionProvider === "granola") {
    const connection = state.granola_mcp;
    const permissionConnection: IntegrationAccountView<"granola"> | null = connection.integrationId
      ? {
          integrationId: connection.integrationId,
          provider: "granola",
          status: connection.status === "not_connected" ? "disconnected" : connection.status,
          connected: connection.connected,
          accountEmail: null,
          accountName: connection.accountName,
          connectionLabel: connection.accountName || "Granola tool access",
          statusReason: connection.statusReason,
          scopes: [],
          capabilityModes: connection.capabilityModes,
        }
      : null;
    return {
      permissionConnection,
      accounts: permissionConnection ? [{ account: permissionConnection }] : [],
    };
  }
  if (
    config.connectionProvider === "attio" ||
    config.connectionProvider === "betterstack" ||
    config.connectionProvider === "fathom" ||
    config.connectionProvider === "github_user" ||
    config.connectionProvider === "gmail" ||
    config.connectionProvider === "google_admin" ||
    config.connectionProvider === "google_calendar" ||
    config.connectionProvider === "outlook" ||
    config.connectionProvider === "outlook-calendar" ||
    config.connectionProvider === "google_drive" ||
    config.connectionProvider === "hubspot" ||
    config.connectionProvider === "jamie" ||
    config.connectionProvider === "neon" ||
    config.connectionProvider === "notion" ||
    config.connectionProvider === "supabase" ||
    config.connectionProvider === "resend" ||
    config.connectionProvider === "posthog" ||
    config.connectionProvider === "convex" ||
    config.connectionProvider === "render" ||
    config.connectionProvider === "vercel" ||
    config.connectionProvider === "signoz" ||
    config.connectionProvider === "slack" ||
    config.connectionProvider === "stripe" ||
    config.connectionProvider === "x_account"
  ) {
    if (config.connectionProvider === "stripe") {
      const account = state.personalAccounts.stripe[0] ?? null;
      return { permissionConnection: account, accounts: account ? [{ account }] : [] };
    }
    if (
      config.connectionProvider === "attio" ||
      config.connectionProvider === "posthog" ||
      config.connectionProvider === "hubspot"
    ) {
      const provider = config.connectionProvider;
      const connection = state[provider];
      const permissionConnection: IntegrationAccountView<typeof provider> | null =
        connection.integrationId
          ? {
              integrationId: connection.integrationId,
              provider,
              status: connection.status === "not_connected" ? "disconnected" : connection.status,
              connected: connection.connected,
              accountEmail: null,
              accountName: connection.accountName,
              connectionLabel:
                connection.accountName ||
                `${provider === "attio" ? "Attio" : provider === "hubspot" ? "HubSpot" : "PostHog"} tool access`,
              statusReason: connection.statusReason,
              scopes: [],
              capabilityModes: connection.capabilityModes,
            }
          : null;
      return {
        permissionConnection,
        accounts: permissionConnection ? [{ account: permissionConnection }] : [],
      };
    }
    const accounts = state.personalAccounts[config.connectionProvider].map((account) => ({
      account:
        config.connectionProvider === "google_drive" &&
        account.status === "connected" &&
        !googleDriveMcpScopesSatisfied(account.scopes)
          ? {
              ...account,
              status: "needs_reauth" as const,
              connected: false,
              statusReason: GOOGLE_DRIVE_MCP_RECONNECT_REASON,
            }
          : account,
    }));
    const primaryIntegrationId =
      config.connectionProvider === "outlook" || config.connectionProvider === "outlook-calendar"
        ? accounts.at(-1)?.account.integrationId
        : config.connectionProvider === "gmail"
          ? state.gmail.integrationId
          : config.connectionProvider === "slack"
            ? state.slack.integrationId
            : config.connectionProvider === "google_calendar"
              ? state.google_calendar.integrationId
              : config.connectionProvider === "google_drive"
                ? state.google_drive.integrationId
                : config.connectionProvider === "x_account"
                  ? state.x_account.integrationId
                  : config.connectionProvider === "jamie"
                    ? state.jamie.integrationId
                    : null;
    return {
      accounts,
      permissionConnection:
        accounts.find(({ account }) => account.integrationId === primaryIntegrationId)?.account ??
        accounts.find(({ account }) => account.connected)?.account ??
        accounts[0]?.account ??
        null,
    };
  }
  const permissionConnection: IntegrationAccountView<"linear"> | null = state.linear.integrationId
    ? {
        integrationId: state.linear.integrationId,
        provider: "linear",
        status: state.linear.status === "not_connected" ? "disconnected" : state.linear.status,
        connected: state.linear.connected,
        accountEmail: null,
        accountName: state.linear.accountName,
        connectionLabel: state.linear.accountName || "Linear tool access",
        statusReason: state.linear.statusReason,
        scopes: [],
        capabilityModes: state.linear.capabilityModes,
      }
    : null;
  return {
    permissionConnection,
    accounts: permissionConnection ? [{ account: permissionConnection }] : [],
  };
}
