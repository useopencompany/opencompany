import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  type ConnectorMcpServerStatus,
  connectorMcpCredentials,
  connectorMcpServers,
} from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";

export const CONNECTOR_LINEAR_MCP_SERVER_KEY = "linear";
export const CONNECTOR_LINEAR_MCP_DISPLAY_NAME = "Linear";
export const CONNECTOR_LINEAR_MCP_ENDPOINT_URL = "https://mcp.linear.app/mcp";
export const CONNECTOR_LINEAR_MCP_OAUTH_CREDENTIAL_KIND = "oauth";

export type ConnectorLinearMcpSettings = {
  configured: boolean;
  serverId: string | null;
  status: ConnectorMcpServerStatus | null;
  statusReason: string | null;
  updatedAt: string | null;
};

export async function loadConnectorLinearMcpSettings(
  organizationId: string,
): Promise<ConnectorLinearMcpSettings> {
  const db = getDb();
  const [server] = await db
    .select({
      id: connectorMcpServers.id,
      status: connectorMcpServers.status,
      statusReason: connectorMcpServers.statusReason,
      updatedAt: connectorMcpServers.updatedAt,
    })
    .from(connectorMcpServers)
    .where(
      and(
        eq(connectorMcpServers.organizationId, organizationId),
        eq(connectorMcpServers.serverKey, CONNECTOR_LINEAR_MCP_SERVER_KEY),
      ),
    )
    .limit(1);

  if (!server) return emptyLinearMcpSettings();

  const [credential] = await db
    .select({ id: connectorMcpCredentials.id })
    .from(connectorMcpCredentials)
    .where(
      and(
        eq(connectorMcpCredentials.organizationId, organizationId),
        eq(connectorMcpCredentials.serverId, server.id),
        eq(connectorMcpCredentials.kind, CONNECTOR_LINEAR_MCP_OAUTH_CREDENTIAL_KIND),
      ),
    )
    .limit(1);

  return {
    configured: Boolean(credential && server.status === "configured"),
    serverId: server.id,
    status: server.status,
    statusReason: server.statusReason,
    updatedAt: server.updatedAt.toISOString(),
  };
}

export async function upsertConnectorLinearMcpServer(input: {
  organizationId: string;
  status: Extract<ConnectorMcpServerStatus, "configured" | "missing_credential" | "error">;
  statusReason: string | null;
  connectedByUserId?: string | null;
}) {
  const now = new Date();
  const [server] = await getDb()
    .insert(connectorMcpServers)
    .values({
      id: newConnectorMcpServerId(),
      organizationId: input.organizationId,
      serverKey: CONNECTOR_LINEAR_MCP_SERVER_KEY,
      displayName: CONNECTOR_LINEAR_MCP_DISPLAY_NAME,
      endpointUrl: CONNECTOR_LINEAR_MCP_ENDPOINT_URL,
      status: input.status,
      statusReason: input.statusReason,
      connectedByUserId: input.connectedByUserId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [connectorMcpServers.organizationId, connectorMcpServers.serverKey],
      set: {
        displayName: CONNECTOR_LINEAR_MCP_DISPLAY_NAME,
        endpointUrl: CONNECTOR_LINEAR_MCP_ENDPOINT_URL,
        status: input.status,
        statusReason: input.statusReason,
        connectedByUserId: input.connectedByUserId ?? null,
        updatedAt: now,
      },
    })
    .returning({ id: connectorMcpServers.id });

  if (!server) throw new Error("Could not persist the Linear MCP server.");
  return server;
}

export function emptyLinearMcpSettings(): ConnectorLinearMcpSettings {
  return {
    configured: false,
    serverId: null,
    status: null,
    statusReason: null,
    updatedAt: null,
  };
}

function newConnectorMcpServerId() {
  return `cmcps_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
