import { getDb } from "@opencompany/db/client";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { RemoteMcpConnectionState, RemoteMcpOperation } from "../actions/remote-mcp";
import { ActionAuthError } from "../actions/types";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";
import { getXAccessToken, XAccessAuthError } from "./x-access-token";
import { X_API_TOOLS } from "./x-api-tools";
import { xMcpToolModes, xToolName } from "./x-mcp-catalog";
import { createXMcpClient } from "./x-mcp-client";

export const X_MCP_ENDPOINT_URL = "https://api.x.com/mcp";

export async function getXMcpIntegrationState(
  identity: string | { userWorkosId: string },
): Promise<RemoteMcpConnectionState> {
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await loadXMcpIntegration(userWorkosId);
  if (!row || row.status === "disconnected") {
    return {
      connected: false,
      integrationId: null,
      capabilityModes: {},
      toolModes: {},
    };
  }
  return {
    connected: row.status === "connected",
    integrationId: row.id,
    capabilityModes: row.capabilityModes,
    toolModes: xMcpToolModes(row.toolModes),
  };
}

export async function loadXMcpWorkerConnection(input: {
  userWorkosId: string;
  operation?: RemoteMcpOperation;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadXMcpIntegration(input.userWorkosId);
  if (!row || row.status === "disconnected") return { ok: false, reason: "not_connected" } as const;
  if (row.status !== "connected") return { ok: false, reason: "needs_reauth" } as const;

  if (input.operation?.type === "tools/call") {
    const tool = xToolName(input.operation.tool);
    const requiredScopes =
      X_API_TOOLS.find((entry) => entry.name === tool)?.scopes ??
      (tool.startsWith("get_users_bookmark")
        ? ["bookmark.read"]
        : tool.startsWith("create_users_bookmark") || tool === "delete_users_bookmark"
          ? ["bookmark.write"]
          : []);
    const missing = requiredScopes.filter((scope) => !row.scopes?.includes(scope));
    if (missing.length) {
      throw new ActionAuthError(
        "auth_expired",
        "x_account",
        `Reconnect X in Settings → Plugins → X to grant ${missing.join(", ")}, then retry. Your current connection does not include these permissions.`,
      );
    }
  }

  let accessToken: string;
  try {
    accessToken = await getXAccessToken({
      userWorkosId: input.userWorkosId,
      integrationId: row.id,
    });
  } catch (error) {
    if (error instanceof XAccessAuthError) {
      return { ok: false, reason: "needs_reauth" } as const;
    }
    throw error;
  }

  return {
    ok: true,
    integrationId: row.id,
    createClient: createXMcpClient({
      connection: { userWorkosId: input.userWorkosId, integrationId: row.id },
    }),
    authProvider: createRemoteMcpStaticBearerAuthProvider({
      accessToken,
      onAuthorizationRequired: async () => {
        try {
          await getXAccessToken(
            { userWorkosId: input.userWorkosId, integrationId: row.id },
            { forceRefresh: true },
          );
        } catch (error) {
          if (error instanceof XAccessAuthError) return input.onAuthorizationRequired();
          throw error;
        }
        throw new Error("X MCP rejected a freshly refreshed credential.");
      },
    }),
  } as const;
}

async function loadXMcpIntegration(userWorkosId: string) {
  const [row] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
      scopes: integrations.scopes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        isNull(integrations.workspaceId),
        eq(integrations.provider, "x_account"),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row;
}
