import { getDb } from "@opencompany/db/client";
import { workspaceMcpCredentials, workspaceMcpServers } from "@opencompany/db/schema";
import { and, eq, inArray } from "drizzle-orm";

export const LINEAR_MCP_SERVER_KEY = "linear";
export const LINEAR_MCP_ENDPOINT_URL = "https://mcp.linear.app/mcp";
export const LINEAR_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
export const SLACK_MCP_SERVER_KEY = "slack";
export const SLACK_MCP_ENDPOINT_URL = "https://mcp.slack.com/mcp";
export const SLACK_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
export const POSTHOG_MCP_SERVER_KEY = "posthog";
export const POSTHOG_MCP_ENDPOINT_URL = "https://mcp.posthog.com/mcp";
export const POSTHOG_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
export const BETTERSTACK_MCP_SERVER_KEY = "betterstack";
export const BETTERSTACK_MCP_ENDPOINT_URL = "https://mcp.betterstack.com";
export const BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
export const BRAINTRUST_MCP_SERVER_KEY = "braintrust";
export const BRAINTRUST_MCP_ENDPOINT_URL = "https://api.braintrust.dev/mcp";
export const BRAINTRUST_MCP_OAUTH_CREDENTIAL_KIND = "oauth";

export const MCP_PROVIDER_KEYS = [
  LINEAR_MCP_SERVER_KEY,
  SLACK_MCP_SERVER_KEY,
  POSTHOG_MCP_SERVER_KEY,
  BETTERSTACK_MCP_SERVER_KEY,
  BRAINTRUST_MCP_SERVER_KEY,
] as const;

export type McpProviderKey = (typeof MCP_PROVIDER_KEYS)[number];

export type WorkspaceMcpSettings = {
  linear: WorkspaceMcpProviderSettings;
  slack: WorkspaceMcpProviderSettings;
  posthog: WorkspaceMcpProviderSettings;
  betterstack: WorkspaceMcpProviderSettings;
  braintrust: WorkspaceMcpProviderSettings;
};

export type WorkspaceMcpProviderSettings = {
  configured: boolean;
  serverId: string | null;
  status: "configured" | "missing_credential" | "disabled" | "error" | null;
  statusReason: string | null;
  updatedAt: string | null;
};

export async function loadWorkspaceMcpSettingsForWorkspace(
  workspaceId: string,
): Promise<WorkspaceMcpSettings> {
  const db = getDb();
  const [servers, credentials] = await Promise.all([
    db
      .select({
        id: workspaceMcpServers.id,
        serverKey: workspaceMcpServers.serverKey,
        status: workspaceMcpServers.status,
        statusReason: workspaceMcpServers.statusReason,
        updatedAt: workspaceMcpServers.updatedAt,
      })
      .from(workspaceMcpServers)
      .where(
        and(
          eq(workspaceMcpServers.workspaceId, workspaceId),
          inArray(workspaceMcpServers.serverKey, [...MCP_PROVIDER_KEYS]),
        ),
      ),
    db
      .select({
        serverKey: workspaceMcpServers.serverKey,
        kind: workspaceMcpCredentials.kind,
      })
      .from(workspaceMcpCredentials)
      .innerJoin(
        workspaceMcpServers,
        and(
          eq(workspaceMcpServers.workspaceId, workspaceMcpCredentials.workspaceId),
          eq(workspaceMcpServers.id, workspaceMcpCredentials.serverId),
          inArray(workspaceMcpServers.serverKey, [...MCP_PROVIDER_KEYS]),
        ),
      )
      .where(eq(workspaceMcpCredentials.workspaceId, workspaceId)),
  ]);

  const serverByKey = new Map(servers.map((server) => [server.serverKey, server]));

  function settingsFor(provider: McpProviderKey): WorkspaceMcpProviderSettings {
    const server = serverByKey.get(provider);
    const hasCredential = credentials.some((credential) => {
      if (credential.serverKey !== provider) return false;
      if (provider === LINEAR_MCP_SERVER_KEY) {
        return (
          credential.kind === "bearer_token" || credential.kind === LINEAR_MCP_OAUTH_CREDENTIAL_KIND
        );
      }
      if (provider === POSTHOG_MCP_SERVER_KEY) {
        return credential.kind === POSTHOG_MCP_OAUTH_CREDENTIAL_KIND;
      }
      if (provider === BETTERSTACK_MCP_SERVER_KEY) {
        return credential.kind === BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND;
      }
      if (provider === BRAINTRUST_MCP_SERVER_KEY) {
        return credential.kind === BRAINTRUST_MCP_OAUTH_CREDENTIAL_KIND;
      }
      return credential.kind === SLACK_MCP_OAUTH_CREDENTIAL_KIND;
    });
    return {
      configured: Boolean(hasCredential && server?.status === "configured"),
      serverId: server?.id ?? null,
      status: server?.status ?? null,
      statusReason: server?.statusReason ?? null,
      updatedAt: server?.updatedAt.toISOString() ?? null,
    };
  }

  return {
    linear: settingsFor(LINEAR_MCP_SERVER_KEY),
    slack: settingsFor(SLACK_MCP_SERVER_KEY),
    posthog: settingsFor(POSTHOG_MCP_SERVER_KEY),
    betterstack: settingsFor(BETTERSTACK_MCP_SERVER_KEY),
    braintrust: settingsFor(BRAINTRUST_MCP_SERVER_KEY),
  };
}
