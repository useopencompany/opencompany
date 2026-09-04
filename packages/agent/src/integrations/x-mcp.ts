import { getDb } from "@opencompany/db/client";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { RemoteMcpConnectionState } from "../actions/remote-mcp";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";
import { getXAccessToken, XAccessAuthError } from "./x-access-token";

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
    toolModes: row.toolModes,
  };
}

export async function loadXMcpWorkerConnection(input: {
  userWorkosId: string;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadXMcpIntegration(input.userWorkosId);
  if (!row || row.status === "disconnected") return { ok: false, reason: "not_connected" } as const;
  if (row.status !== "connected") return { ok: false, reason: "needs_reauth" } as const;

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
