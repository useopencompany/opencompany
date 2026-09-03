import { getDb } from "@opencompany/db/client";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { RemoteMcpConnectionState } from "../actions/remote-mcp";
import { GoogleAccessAuthError, getGoogleAccessToken } from "./google-access-token";
import { googleDriveMcpScopesSatisfied } from "./google-drive-scopes";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const GOOGLE_DRIVE_MCP_ENDPOINT_URL = "https://drivemcp.googleapis.com/mcp/v1";

type GoogleDriveMcpIntegration = {
  id: string;
  userWorkosId: string;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
  scopes: string[];
  capabilityModes: Record<string, unknown>;
  toolModes: Record<string, unknown>;
};

type GoogleDriveMcpDependencies = {
  loadIntegration: (input: { userWorkosId: string }) => Promise<GoogleDriveMcpIntegration | null>;
  getAccessToken: typeof getGoogleAccessToken;
};

const defaultDependencies: GoogleDriveMcpDependencies = {
  loadIntegration: loadLatestGoogleDriveMcpIntegration,
  getAccessToken: getGoogleAccessToken,
};

export async function getGoogleDriveMcpIntegrationState(
  identity: string | { userWorkosId: string },
  dependencies: Partial<GoogleDriveMcpDependencies> = {},
): Promise<RemoteMcpConnectionState> {
  const deps = { ...defaultDependencies, ...dependencies };
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await deps.loadIntegration({ userWorkosId });
  if (!row || row.status === "disconnected") {
    return {
      connected: false,
      integrationId: null,
      capabilityModes: {},
      toolModes: {},
    };
  }
  return {
    connected: row.status === "connected" && googleDriveMcpScopesSatisfied(row.scopes),
    integrationId: row.id,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadGoogleDriveMcpWorkerConnection(
  input: {
    userWorkosId: string;
    onAuthorizationRequired: () => never;
  },
  dependencies: Partial<GoogleDriveMcpDependencies> = {},
) {
  const deps = { ...defaultDependencies, ...dependencies };
  const row = await deps.loadIntegration({ userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") {
    return { ok: false, reason: "not_connected" } as const;
  }
  if (row.status !== "connected" || !googleDriveMcpScopesSatisfied(row.scopes)) {
    return { ok: false, reason: "needs_reauth" } as const;
  }

  const connection = {
    userWorkosId: row.userWorkosId,
    integrationId: row.id,
    provider: "google_drive" as const,
  };
  let accessToken: string;
  try {
    accessToken = await deps.getAccessToken(connection);
  } catch (error) {
    if (error instanceof GoogleAccessAuthError) {
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
          await deps.getAccessToken(connection, { forceRefresh: true });
        } catch (error) {
          if (error instanceof GoogleAccessAuthError) return input.onAuthorizationRequired();
          throw error;
        }
        throw new Error("Google Drive MCP rejected a freshly refreshed credential.");
      },
    }),
  } as const;
}

export async function loadLatestGoogleDriveMcpIntegration(input: {
  userWorkosId: string;
  db?: any;
}): Promise<GoogleDriveMcpIntegration | null> {
  const [row] = await (input.db ?? getDb())
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
      scopes: integrations.scopes,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, input.userWorkosId),
        isNull(integrations.workspaceId),
        eq(integrations.provider, "google_drive"),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row ?? null;
}
