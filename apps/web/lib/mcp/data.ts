import { getDb } from "@opencompany/db/client";
import {
  workspaceExperiments,
  workspaceMcpCredentials,
  workspaceMcpServers,
} from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";

export const MCP_EXPERIMENT_KEY = "mcp";
export const LINEAR_MCP_SERVER_KEY = "linear";
export const LINEAR_MCP_ENDPOINT_URL = "https://mcp.linear.app/mcp";
export const LINEAR_MCP_OAUTH_CREDENTIAL_KIND = "oauth";

export type WorkspaceMcpSettings = {
  mcpEnabled: boolean;
  linear: {
    configured: boolean;
    serverId: string | null;
    status: "configured" | "missing_credential" | "disabled" | "error" | null;
    statusReason: string | null;
    updatedAt: string | null;
  };
};

export async function loadWorkspaceMcpSettingsForWorkspace(
  workspaceId: string,
): Promise<WorkspaceMcpSettings> {
  const db = getDb();
  const [[experiment], [server], credentials] = await Promise.all([
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
        status: workspaceMcpServers.status,
        statusReason: workspaceMcpServers.statusReason,
        updatedAt: workspaceMcpServers.updatedAt,
      })
      .from(workspaceMcpServers)
      .where(
        and(
          eq(workspaceMcpServers.workspaceId, workspaceId),
          eq(workspaceMcpServers.serverKey, LINEAR_MCP_SERVER_KEY),
        ),
      )
      .limit(1),
    db
      .select({
        kind: workspaceMcpCredentials.kind,
      })
      .from(workspaceMcpCredentials)
      .innerJoin(
        workspaceMcpServers,
        and(
          eq(workspaceMcpServers.workspaceId, workspaceMcpCredentials.workspaceId),
          eq(workspaceMcpServers.id, workspaceMcpCredentials.serverId),
          eq(workspaceMcpServers.serverKey, LINEAR_MCP_SERVER_KEY),
        ),
      )
      .where(eq(workspaceMcpCredentials.workspaceId, workspaceId)),
  ]);
  const hasLinearCredential = credentials.some(
    (credential) =>
      credential.kind === "bearer_token" || credential.kind === LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
  );

  return {
    mcpEnabled: experiment?.enabled === true,
    linear: {
      configured: Boolean(hasLinearCredential && server?.status === "configured"),
      serverId: server?.id ?? null,
      status: server?.status ?? null,
      statusReason: server?.statusReason ?? null,
      updatedAt: server?.updatedAt.toISOString() ?? null,
    },
  };
}
