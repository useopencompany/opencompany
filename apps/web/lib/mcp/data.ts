import { getDb } from "@opencompany/db/client";
import {
  workspaceExperiments,
  workspaceMcpCredentials,
  workspaceMcpServers,
} from "@opencompany/db/schema";
import { and, eq, inArray } from "drizzle-orm";

export const MCP_EXPERIMENT_KEY = "mcp";
export const LINEAR_MCP_SERVER_KEY = "linear";
export const LINEAR_MCP_ENDPOINT_URL = "https://mcp.linear.app/mcp";
export const LINEAR_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
export const SLACK_MCP_SERVER_KEY = "slack";
export const SLACK_MCP_ENDPOINT_URL = "https://mcp.slack.com/mcp";
export const SLACK_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
export const POSTHOG_MCP_SERVER_KEY = "posthog";
export const POSTHOG_MCP_ENDPOINT_URL = "https://mcp.posthog.com/mcp";
export const POSTHOG_MCP_OAUTH_CREDENTIAL_KIND = "oauth";

export const MCP_PROVIDER_KEYS = [
  LINEAR_MCP_SERVER_KEY,
  SLACK_MCP_SERVER_KEY,
  POSTHOG_MCP_SERVER_KEY,
] as const;

export type McpProviderKey = (typeof MCP_PROVIDER_KEYS)[number];

export type WorkspaceMcpSettings = {
  mcpEnabled: boolean;
  linear: WorkspaceMcpProviderSettings;
  slack: WorkspaceMcpProviderSettings;
  posthog: WorkspaceMcpProviderSettings;
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
  const [[experiment], servers, credentials] = await Promise.all([
    db
      .select({ enabled: workspaceExperiments.enabled })
      .from(workspaceExperiments)
      .where(
        and(
          eq(workspaceExperiments.workspaceId, workspaceId),
          eq(workspaceExperiments.key, MCP_EXPERIMENT_KEY),
        ),
      )
      .limit(1),
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
    mcpEnabled: experiment?.enabled === true,
    linear: settingsFor(LINEAR_MCP_SERVER_KEY),
    slack: settingsFor(SLACK_MCP_SERVER_KEY),
    posthog: settingsFor(POSTHOG_MCP_SERVER_KEY),
  };
}
